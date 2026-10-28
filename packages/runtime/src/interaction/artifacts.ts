import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import {
  ArtifactIdSchema, ArtifactReferenceSchema, WebArtifactMetadataSchema, WebArtifactChunkSchema,
  OperationResultSchema, WEB_LIMITS, type ArtifactStore, type OperationOptions, type OperationResult,
  type WebArtifactRead, type WebArtifactMetadata,
} from '@bflow/contracts';
/** Hard transfer quota independent of untrusted media type/size. Preview policy stays at 1 MiB. */
export const ARTIFACT_TRANSFER_BYTES = 64 * 1024 * 1024;
const metadataResult = OperationResultSchema(WebArtifactMetadataSchema);
export async function readScopedArtifact(store: ArtifactStore, projectId: string, requestedProject: string, artifactId: string,
  ownsRun: (runId: string)=>Promise<boolean>, options?: OperationOptions): Promise<OperationResult<WebArtifactRead>> {
  try {
    ArtifactIdSchema.parse(artifactId);
    if(projectId!==requestedProject)throw Error('scope');
    const result=await store.resolve(artifactId, options);
    if(!result.ok)return result;
    if(!result.value)return {ok:false,error:{code:'not_found',retryable:false,message:'Artifact not found.'}};
    const ref=ArtifactReferenceSchema.parse(result.value);
    if(ref.artifactId!==artifactId || !await ownsRun(ref.runId))throw Error('scope');
    if(ref.sizeBytes===undefined || ref.sizeBytes>ARTIFACT_TRANSFER_BYTES)throw Error('quota');
    const mediaType=ref.mediaType.toLowerCase().trim();
    const inline=['text/plain','application/json','text/markdown'].includes(mediaType) && ref.sizeBytes<=WEB_LIMITS.previewBytes;
    const metadata=WebArtifactMetadataSchema.parse({apiVersion:1,artifactId,runId:ref.runId,mediaType:ref.mediaType,
      checksum:ref.checksum,sizeBytes:ref.sizeBytes,disposition:inline?'inline':'attachment',previewLimitBytes:WEB_LIMITS.previewBytes});
    return {ok:true,value:{metadata,chunks:(async function*(){
      let size=0; const hash=createHash(ref.checksum.algorithm);
      for await(const item of store.get(ref,{...options,timeoutMs:30000})) {
        if(!item.ok)throw Error('Artifact read failed.');
        if(item.value.byteLength===0)continue;
        const chunk=WebArtifactChunkSchema.parse(item.value);size+=chunk.byteLength;
        if(size>metadata.sizeBytes || size>ARTIFACT_TRANSFER_BYTES)throw Error('Artifact size mismatch.');
        hash.update(chunk);yield chunk;
      }
      if(size!==metadata.sizeBytes || hash.digest('hex')!==metadata.checksum.value.toLowerCase())throw Error('Artifact integrity mismatch.');
    })()}};
  }catch{return {ok:false,error:{code:'validation',retryable:false,message:'Artifact scope or policy refused.'}};}
}
async function writeSocket(socket: Socket, bytes: string | Uint8Array): Promise<void> {
  if (socket.destroyed) throw Error('Artifact reader disconnected');
  if (socket.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const clear = () => { socket.off('drain', drain); socket.off('close', close); socket.off('error', error); };
    const drain = () => { clear(); resolve(); };
    const close = () => { clear(); reject(Error('Artifact reader disconnected')); };
    const error = (reason: Error) => { clear(); reject(reason); };
    socket.once('drain', drain); socket.once('close', close); socket.once('error', error);
  });
}
/** Private IPC uses one validated metadata line followed by raw bounded bytes. No paths or URIs cross it. */
export async function serveArtifact(socket: Socket, result: OperationResult<WebArtifactRead>): Promise<void> {
  if(!result.ok){socket.end(JSON.stringify(metadataResult.parse(result))+'\n');return;}
  const iterator=result.value.chunks[Symbol.asyncIterator]();
  try {
    // Store verifies its complete private snapshot before yielding even the first byte.
    let next=await iterator.next();
    if(socket.destroyed)return;
    await writeSocket(socket, JSON.stringify(metadataResult.parse({ok:true,value:result.value.metadata}))+'\n');
    while(!next.done){if(socket.destroyed)return;await writeSocket(socket, WebArtifactChunkSchema.parse(next.value));next=await iterator.next();}
    socket.end();
  }finally{await iterator.return?.();}
}
export async function connectArtifact(socketPath: string, token: string, params: unknown): Promise<OperationResult<WebArtifactRead>> {
  const socket=connect(socketPath);socket.on('error',()=>{});
  const timer=setTimeout(()=>socket.destroy(new Error('Artifact transfer deadline.')),30000);timer.unref();
  socket.once('close',()=>clearTimeout(timer));
  const iterator=socket[Symbol.asyncIterator]();
  try {
    await once(socket,'connect');socket.write(JSON.stringify({token,method:'interaction_artifact',params})+'\n');
    let header=Buffer.alloc(0), remainder=Buffer.alloc(0);let metadata:WebArtifactMetadata;
    for(;;){const next=await iterator.next();if(next.done)throw Error('Missing artifact metadata');
      header=Buffer.concat([header,next.value]);const newline=header.indexOf(10);
      if((newline<0 && header.length>8192)||newline>8192)throw Error('Oversized artifact metadata');
      if(newline<0)continue;
      const result=metadataResult.parse(JSON.parse(header.subarray(0,newline).toString('utf8')));
      if(!result.ok){socket.destroy();return result;}
      metadata=result.value;if(metadata.sizeBytes>ARTIFACT_TRANSFER_BYTES)throw Error('Artifact quota');
      remainder=header.subarray(newline+1);break;
    }
    return {ok:true,value:{metadata,chunks:(async function*(){
      let count=0;const hash=createHash(metadata.checksum.algorithm);
      try {
        let pending=remainder;
        for(;;){for(let offset=0;offset<pending.length;offset+=WEB_LIMITS.chunkBytes){const chunk=WebArtifactChunkSchema.parse(pending.subarray(offset,offset+WEB_LIMITS.chunkBytes));
          count+=chunk.byteLength;if(count>metadata.sizeBytes)throw Error('Artifact overflow');hash.update(chunk);yield chunk;}
          const next=await iterator.next();if(next.done)break;pending=next.value;
        }
        if(count!==metadata.sizeBytes || hash.digest('hex')!==metadata.checksum.value.toLowerCase())throw Error('Artifact incomplete');
      }finally{socket.destroy();await iterator.return?.();}
    })()}};
  }catch{socket.destroy();return {ok:false,error:{code:'transport_unavailable',retryable:true,message:'Artifact unavailable.'}};}
}
