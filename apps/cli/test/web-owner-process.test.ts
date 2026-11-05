import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots:string[]=[],children:ChildProcess[]=[];
afterEach(async()=>{
  for(const child of children.splice(0)){
    if(child.exitCode!==null || child.signalCode!==null)continue;
    const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    child.kill('SIGTERM');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await exit;}finally{clearTimeout(timer);}
  }
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});
async function freePort(){
  const reservation=createServer();
  await new Promise<void>((accept,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',accept);});
  const port=(reservation.address() as {port:number}).port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  return port;
}
async function launch(machineHome:string,port:number){
  const binary=fileURLToPath(new URL('../dist/bin.js',import.meta.url));
  const child=spawn(process.execPath,[binary,'web','--port',String(port),'--no-open'],{
    cwd:machineHome,env:{...process.env,BFLOW_HOME:machineHome},stdio:['ignore','pipe','pipe']
  });children.push(child);
  let output='',error='';
  child.stdout!.on('data',chunk=>{output=(output+String(chunk)).slice(-2000);});
  child.stderr!.on('data',chunk=>{error=(error+String(chunk)).slice(-2000);});
  child.on('error',err=>{error=err.message;});
  await expect.poll(()=>{if(child.exitCode!==null || child.signalCode!==null)throw Error(error || 'Web exited before listening');return output.includes('http://127.0.0.1:'+port);},{timeout:15000}).toBe(true);
  expect(output).not.toContain('#bootstrap=');
  return child;
}
it('only the newest foreground Web owner stays alive for one machine state, even with unchanged assets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bflow-latest-process-'));roots.push(root);
  const firstPort=await freePort(),secondPort=await freePort();
  const a=await launch(root,firstPort);
  const locator=join(root,'state','web','instance.json');
  const first=JSON.parse(await readFile(locator,'utf8'));
  const b=await launch(root,firstPort);
  await expect.poll(()=>a.exitCode,{timeout:10000}).toBe(0);
  expect((await fetch('http://127.0.0.1:'+firstPort)).status).toBe(200);
  const next=JSON.parse(await readFile(locator,'utf8'));
  expect(next.buildId).toBe(first.buildId);
  expect(next.controlSecret).not.toBe(first.controlSecret);
  const c=await launch(root,secondPort);
  await expect.poll(()=>b.exitCode,{timeout:10000}).toBe(0);
  await expect(fetch('http://127.0.0.1:'+firstPort)).rejects.toThrow();
  expect(c.exitCode).toBeNull();
  expect((await fetch('http://127.0.0.1:'+secondPort)).status).toBe(200);
  expect(JSON.parse(await readFile(locator,'utf8')).origin).toBe('http://127.0.0.1:'+secondPort);
},45000);
