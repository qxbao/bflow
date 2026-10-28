import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, unlink, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openFilesystemArtifactStore } from '@bflow/artifact-store';
import { readScopedArtifact } from '../../src/interaction/artifacts.js';
const unwrap=<T>(r:import('@bflow/contracts').OperationResult<T>):T=>{if(!r.ok)throw Error(r.error.message);return r.value;};
it('reads only catalog-owned project/session runs and verifies integrity before yielding bytes',async()=>{
 const root=await mkdtemp('/tmp/w05-artifact-'); const store=unwrap(await openFilesystemArtifactStore({root,storeId:'store'}));
 try {
 const bytes=Buffer.from('<script>alert(1)</script>');
 const ref=unwrap(await store.put({options:{artifactId:'a',runId:'r',kind:'document',mediaType:'text/html',expectedIntegrity:{checksum:{algorithm:'sha256',value:createHash('sha256').update(bytes).digest('hex')},sizeBytes:bytes.length},idempotencyKey:'a'},content:(async function*(){yield bytes;})()}));
 const read=()=>readScopedArtifact(store,'p','p','a',async id=>id==='r');
 const value=unwrap(await read());expect(value.metadata.disposition).toBe('attachment');
 const chunks=[];for await(const c of value.chunks)chunks.push(c);expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
 expect(await readScopedArtifact(store,'p','foreign','a',async()=>true)).toMatchObject({ok:false});
 expect(await readScopedArtifact(store,'p','p','a',async()=>false)).toMatchObject({ok:false});
 for(const id of ['../a','%2e%2e','https://example.test/a'])expect(await readScopedArtifact(store,'p','p',id,async()=>true)).toMatchObject({ok:false});
 const blob=(await readdir(root)).find(n=>n.startsWith('blob-'))!;
 await writeFile(join(root,blob),'wrong');await expect(async()=>{for await(const _ of unwrap(await read()).chunks){}}).rejects.toThrow();
 await unlink(join(root,blob));await symlink('/etc/passwd',join(root,blob));await expect(async()=>{for await(const _ of unwrap(await read()).chunks){}}).rejects.toThrow();
 await unlink(join(root,blob));execFileSync('mkfifo',[join(root,blob)]);await expect(async()=>{for await(const _ of unwrap(await read()).chunks){}}).rejects.toThrow();
 await unlink(join(root,blob));await expect(async()=>{for await(const _ of unwrap(await read()).chunks){}}).rejects.toThrow();
 await store.delete(ref.artifactId);expect(await read()).toMatchObject({ok:false});
 } finally {store.close();await rm(root,{recursive:true,force:true});}
});
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { serveArtifact, connectArtifact, ARTIFACT_TRANSFER_BYTES } from '../../src/interaction/artifacts.js';
it('streams verified bytes over private IPC with bounded chunks and cleans up on disconnect',async()=>{
 const directory=await mkdtemp('/tmp/w05-stream-'),path=join(directory,'socket');
 const bytes=Buffer.alloc(200000,7);let finished=0;
 const server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>{void serveArtifact(socket,{ok:true,value:{metadata:{apiVersion:1,artifactId:'a',runId:'r',mediaType:'text/plain',checksum:{algorithm:'sha256',value:createHash('sha256').update(bytes).digest('hex')},sizeBytes:bytes.length,disposition:'inline',previewLimitBytes:1048576},chunks:(async function*(){try{for(let i=0;i<bytes.length;i+=65536)yield bytes.subarray(i,i+65536);}finally{finished++;}})()}}).catch(()=>socket.destroy());});});
 server.listen(path);await once(server,'listening');
 try{
 const value=unwrap(await connectArtifact(path,'private',{id:'p',artifactId:'a'}));const output=[];for await(const chunk of value.chunks){expect(chunk.byteLength).toBeLessThanOrEqual(65536);output.push(chunk);}
 expect(Buffer.concat(output)).toEqual(bytes);expect(finished).toBe(1);
 const other=unwrap(await connectArtifact(path,'private',{id:'p',artifactId:'a'}));const iterator=other.chunks[Symbol.asyncIterator]();await iterator.next();await iterator.return?.();
 expect(ARTIFACT_TRANSFER_BYTES).toBe(64*1024*1024);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
it('releases a store iterator when a disconnected reader leaves IPC backpressured',async()=>{
 const directory=await mkdtemp('/tmp/w05-backpressure-'),path=join(directory,'socket');let cleaned=false;
 const server=createServer(socket=>{socket.on('error',()=>{});socket.once('data',()=>{void serveArtifact(socket,{ok:true,value:{metadata:{apiVersion:1,artifactId:'a',runId:'r',mediaType:'application/octet-stream',checksum:{algorithm:'sha256',value:'a'.repeat(64)},sizeBytes:64*1024*1024,disposition:'attachment',previewLimitBytes:1048576},chunks:(async function*(){try{for(let i=0;i<1024;i++)yield Buffer.alloc(65536);}finally{cleaned=true;}})()}}).catch(()=>socket.destroy());});});server.listen(path);await once(server,'listening');
 const reader=connect(path);reader.on('error',()=>{});await once(reader,'connect');reader.write('{}\n');reader.pause();
 await new Promise(r=>setTimeout(r,30));reader.destroy();
 try{await expect.poll(()=>cleaned,{timeout:1000}).toBe(true);}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
it('closes IPC when a caller abandons artifact bytes before starting the returned iterator',async()=>{
 const directory=await mkdtemp('/tmp/w05-unread-'),path=join(directory,'socket');let disconnected=false;let peer:import('node:net').Socket|undefined;
 const server=createServer(socket=>{peer=socket;socket.on('error',()=>{});socket.once('close',()=>{disconnected=true;});socket.once('data',()=>socket.write(JSON.stringify({ok:true,value:{apiVersion:1,artifactId:'a',runId:'r',mediaType:'text/plain',checksum:{algorithm:'sha256',value:'a'.repeat(64)},sizeBytes:1,disposition:'inline',previewLimitBytes:1048576}})+'\n'));});server.listen(path);await once(server,'listening');
 try{const value=unwrap(await connectArtifact(path,'private',{id:'p',artifactId:'a'}));await value.chunks[Symbol.asyncIterator]().return?.();await expect.poll(()=>disconnected,{timeout:500}).toBe(true);}
 finally{peer?.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
