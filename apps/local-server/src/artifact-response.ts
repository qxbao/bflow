import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { WebArtifactReadSchema, WebArtifactChunkSchema, WEB_LIMITS, type WebArtifactRead } from '@bflow/contracts/web';
import { HttpError, observeWithinDeadline } from './errors.js';
const maxTransfer=64*1024*1024;
/** Always serve inert bytes. Markdown/JSON are plain text, never HTML or executable navigation. */
export async function artifactResponse(req: IncomingMessage, res: ServerResponse, input: WebArtifactRead, artifactId: string, authenticate:()=>void): Promise<void> {
  const value=WebArtifactReadSchema.parse(input),metadata=value.metadata;
  const iterator=value.chunks[Symbol.asyncIterator]();
  let stopped=false,cancelRead:(()=>void)|undefined;
  const stop=()=>{if(stopped)return;stopped=true;cancelRead?.();void Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});};
  const readNext=()=>new Promise<IteratorResult<Uint8Array>|undefined>((resolve,reject)=>{
    const clear=()=>{res.off('close',cancel);req.off('aborted',cancel);if(cancelRead===cancel)cancelRead=undefined;};
    const cancel=()=>{clear();resolve(undefined);};
    cancelRead=cancel;res.once('close',cancel);req.once('aborted',cancel);
    if(stopped || res.destroyed){cancel();return;}
    Promise.resolve().then(()=>iterator.next()).then(value=>{clear();resolve(value);},error=>{clear();reject(error);});
  });
  res.once('close',stop);req.once('aborted',stop);
  const timer=setTimeout(()=>res.destroy(),30000);
  try {
    if(metadata.artifactId!==artifactId)throw new HttpError('unavailable');
    if(metadata.sizeBytes>maxTransfer)throw new HttpError('payload_too_large');
    const inert=['text/plain','application/json','text/markdown'].includes(metadata.mediaType.toLowerCase().trim());
    const inline=inert && metadata.disposition==='inline' && metadata.sizeBytes<=Math.min(WEB_LIMITS.previewBytes,metadata.previewLimitBytes);
    let size=0;const hash=createHash(metadata.checksum.algorithm);
    // The Runtime/ArtifactStore verifies a complete snapshot before its first chunk. Do not emit headers on first-read failure.
    let next=await observeWithinDeadline(readNext);
    if(stopped || !next)return;
    authenticate();res.statusCode=200;
    res.setHeader('Content-Type',inline?'text/plain; charset=utf-8':'application/octet-stream');
    res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename="artifact.txt"`);
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    // No Content-Length: a failed checksum must abort framing, including failures after the nominal final byte.
    while(!next.done && !stopped){
      const chunk=WebArtifactChunkSchema.parse(next.value);size+=chunk.byteLength;
      if(size>metadata.sizeBytes || size>maxTransfer)throw new HttpError('unavailable');hash.update(chunk);
      if(!res.write(chunk))await new Promise<void>((resolve,reject)=>{
        const clear=()=>{res.off('drain',drain);res.off('close',done);res.off('error',error);};
        const drain=()=>{clear();resolve();},done=()=>{clear();resolve();},error=(e:Error)=>{clear();reject(e);};
        res.once('drain',drain);res.once('close',done);res.once('error',error);
      });
      if(stopped)return;
      next=await observeWithinDeadline(readNext);if(!next)return;
    }
    if(stopped)return;
    if(size!==metadata.sizeBytes || hash.digest('hex')!==metadata.checksum.value.toLowerCase())throw new HttpError('unavailable');
    res.end();
  }finally{stop();clearTimeout(timer);res.off('close',stop);req.off('aborted',stop);}
}
