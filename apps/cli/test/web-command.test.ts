import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/bin.js';
import { parseWebArgs, startWebCommand } from '../src/web-command.js';
import { getWebAssetDirectory } from '@bflow/web/assets';

const roots: string[] = [];
const running: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function home() { const p = await mkdtemp(join(tmpdir(), 'bflow web spaces ')); roots.push(p); return p; }
const unavailable = async () => { throw new Error('test has no registered project'); };
async function start(overrides: {port?:number;open?:boolean;[key:string]:unknown} = {}) {
 const stateDirectory = join(await home(), 'web');
 const output: string[] = [];
 const server = await startWebCommand({port: overrides.port ?? 0, open: overrides.open ?? false}, {stateDirectory, isTerminal:true, assetsDirectory: getWebAssetDirectory(), resolveProject: unavailable, io: {stdout: s => output.push(s), stderr: s => output.push(s)}, ...overrides});
 running.push(server); return {server, output, stateDirectory};
}
describe('separate web command', () => {
 it('strictly parses its own path, defaults and help', () => {
  expect(parseWebArgs([])).toEqual({port:4317,open:true});
  expect(parseWebArgs(['--port','4321','--no-open'])).toEqual({port:4321,open:false});
  for(const args of [['--port','0'],['--port','4317x'],['--port','65536'],['--json'],['run'],['--port','1','--port','2']]) expect(() => parseWebArgs(args)).toThrow();
 });
 it('serves built production assets independently of cwd and never buffers a pairing secret in telemetry', async () => {
  const {server,output,stateDirectory} = await start();
  const response = await fetch(server.origin); expect(response.status).toBe(200);
  const html = await response.text();
  const asset = html.match(/src="([^"]+\.js)"/); expect(asset).not.toBeNull();
  expect((await fetch(new URL(asset![1]!,server.origin))).status).toBe(200);
  expect(output.join('')).toContain('#');
  expect(await readFile(join(stateDirectory,'instance.json'),'utf8')).not.toContain(output[0]!.split('#')[1]!);
  expect((await stat(join(stateDirectory,'instance.json'))).mode & 0o777).toBe(0o600);
 });
 it('reuses only a verified existing instance and issues a fresh one-time bootstrap', async () => {
  const {server,stateDirectory,output} = await start(); const secondOutput:string[]=[];
  const second = await startWebCommand({port:Number(new URL(server.origin).port),open:false}, {stateDirectory,isTerminal:true,assetsDirectory:getWebAssetDirectory(),resolveProject:unavailable,io:{stdout:s=>secondOutput.push(s),stderr:()=>{}}});
  running.push(second);expect(second.origin).toBe(server.origin);expect(second.reused).toBe(true);
  expect(secondOutput[0]).not.toBe(output[0]);await second.close();expect((await fetch(server.origin)).status).toBe(200);
 });
 it('reports an exact port conflict without selecting another origin', async () => {
  const occupied=createServer(); await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));
  const address=occupied.address(); if(!address || typeof address==='string')throw Error();
  try {await expect(start({port:address.port})).rejects.toThrow(/port|EADDRINUSE/i);} finally {await new Promise<void>(r=>occupied.close(()=>r()));}
 });
 it('gives a manual fragment pairing URL when the argv browser opener fails', async () => {
  const {output} = await start({open:true,openBrowser:async()=>{throw Error('opener secret should not be logged');}});
  expect(output.join('')).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#/);expect(output.join('')).not.toContain('opener secret');
 });
 it('missing built assets fail before acquiring a server lock', async () => {
  const stateDirectory=join(await home(),'web'); const assetsDirectory=join(await home(),'missing');await mkdir(assetsDirectory);
  await expect(start({stateDirectory,assetsDirectory})).rejects.toThrow(/pnpm.*build/);
  await expect(stat(join(stateDirectory,'server.lock'))).rejects.toThrow();
 });
 it('closing the web owner releases listeners and does not invoke project services', async () => {
  const resolveProject=vi.fn(unavailable);const {server}=await start({resolveProject});await server.close();
  expect(resolveProject).not.toHaveBeenCalled();await expect(fetch(server.origin)).rejects.toThrow();
 });
});

it('binary web help/invalid options stay outside business composition and JSON output',async()=>{
 const stdout:string[]=[],stderr:string[]=[];const io={stdout:(s:string)=>stdout.push(s),stderr:(s:string)=>stderr.push(s)};
 expect(await main(['web','--help'],{cwd:'/no/repository',io})).toMatchObject({ok:true,command:'web'});
 expect(stdout.join('')).toContain('bflow web');
 expect(await main(['web','--json'],{cwd:'/no/repository',io})).toMatchObject({ok:false,exitCode:2});
 process.exitCode=0;
});
it('rejects unsafe reuse rather than trusting a locator PID or taking over',async()=>{
 const {writeFile}=await import('node:fs/promises');
 // A listener that is not the authenticated owner keeps the locator: fail closed.
 const impostor=createServer((_req,res)=>{res.writeHead(403);res.end();});await new Promise<void>(r=>impostor.listen(0,'127.0.0.1',r));
 const impostorPort=(impostor.address() as {port:number}).port;
 const first=await start();await first.server.close();
 await writeFile(join(first.stateDirectory,'instance.json'),JSON.stringify({origin:first.server.origin,controlPort:impostorPort,controlSecret:'x'.repeat(43)}),{mode:0o600});
 await expect(start({stateDirectory:first.stateDirectory,port:Number(new URL(first.server.origin).port)})).rejects.toThrow(/xác minh/);
 await new Promise<void>(r=>impostor.close(()=>r()));
 // Control port refused, but the kernel lock on the server state is still held: not provably dead.
 const second=await start();await second.server.close();
 await writeFile(join(second.stateDirectory,'instance.json'),JSON.stringify({origin:second.server.origin,controlPort:1,controlSecret:'x'.repeat(43)}),{mode:0o600});
 const holder=spawn('flock',['--exclusive',join(second.stateDirectory,'server','server.lock'),'sleep','30'],{stdio:'ignore'});
 try{
  await new Promise(r=>setTimeout(r,300));
  await expect(start({stateDirectory:second.stateDirectory,port:Number(new URL(second.server.origin).port)})).rejects.toThrow(/xác minh/);
 }finally{holder.kill();}
});
it('recovers a dead owner only from a refused control port plus a free server-state lock (no PID)',async()=>{
 const {writeFile}=await import('node:fs/promises');
 const dead=await start();await dead.server.close();
 await writeFile(join(dead.stateDirectory,'instance.json'),JSON.stringify({origin:dead.server.origin,controlPort:1,controlSecret:'x'.repeat(43)}),{mode:0o600});
 const recovered=await start({stateDirectory:dead.stateDirectory,port:Number(new URL(dead.server.origin).port)});
 expect(recovered.server.reused).toBe(false);
 expect(recovered.output.join('\n')).toMatch(/Đã dọn web instance cũ/);
 expect((await fetch(recovered.server.origin)).status).toBe(200);
});
it('does not print a pairing secret into redirected output',async()=>{
 const {output}=await start({isTerminal:false});expect(output.join('')).not.toContain('#');expect(output.join('')).toMatch(/terminal/i);
});
it('built CLI runs from a cwd with spaces, uses BFLOW_HOME and handles actual SIGINT without touching a project',async()=>{
 const cwd=await home(), machineHome=join(cwd,'machine state');
 const bin=fileURLToPath(new URL('../dist/bin.js',import.meta.url));
 const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
 const address=reservation.address();if(!address||typeof address==='string')throw Error();const origin=`http://127.0.0.1:${address.port}`;
 await new Promise<void>(r=>reservation.close(()=>r()));
 const child=spawn(process.execPath,[bin,'web','--no-open','--port',String(address.port)],{cwd,env:{...process.env,BFLOW_HOME:machineHome},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const exit=new Promise<{code:number|null,signal:NodeJS.Signals|null}>((accept,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>accept({code,signal}));});
 try {
  await new Promise<void>((accept,reject)=>{const deadline=setTimeout(()=>reject(Error(stderr||stdout||'startup timeout')),15000);const timer=setInterval(()=>{if(stdout.includes(origin)){clearTimeout(deadline);clearInterval(timer);accept();}if(child.exitCode!==null){clearTimeout(deadline);clearInterval(timer);reject(Error(stderr));}},20);});
  const response=await fetch(origin);expect(response.status).toBe(200);
  expect(await response.text()).toContain('/assets/');expect(stdout).not.toContain('#');
  child.kill('SIGINT');expect(await exit).toEqual({code:0,signal:null});
  await expect(stat(join(machineHome,'state/web/instance.json'))).rejects.toThrow();
  await expect(stat(join(cwd,'.bflow'))).rejects.toThrow();
 }finally {if(child.exitCode===null)child.kill('SIGKILL');await exit;}
},20000);

it('reports a partial production build with a missing JavaScript bundle before listening',async()=>{
 const {writeFile}=await import('node:fs/promises');const assetsDirectory=await home();
 await writeFile(join(assetsDirectory,'index.html'),'<script type="module" src="/assets/missing.js"></script>');
 await expect(start({assetsDirectory})).rejects.toThrow(/pnpm.*build/);
});

it('a stale control port rebound by another process cannot impersonate the owner or learn its persistent credential',async()=>{
 const {writeFile}=await import('node:fs/promises');const stateDirectory=join(await home(),'web');await mkdir(stateDirectory,{mode:0o700});
 let received='';const impostor=createServer((req,res)=>{req.on('data',c=>received+=c);req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({apiVersion:1,secret:'a'.repeat(43)}));});});
 await new Promise<void>(accept=>impostor.listen(0,'127.0.0.1',accept));const addr=impostor.address();if(!addr||typeof addr==='string')throw Error();
 const persistent='s'.repeat(43);await writeFile(join(stateDirectory,'instance.json'),JSON.stringify({origin:'http://127.0.0.1:4317',controlPort:addr.port,controlSecret:persistent}),{mode:0o600});
 try {await expect(startWebCommand({port:4317,open:false},{stateDirectory,io:{stdout:()=>{},stderr:()=>{}}})).rejects.toThrow(/xác minh/);expect(received).not.toContain(persistent);}
 finally {await new Promise<void>(r=>impostor.close(()=>r()));}
});

it('an injected capturing IO is not a terminal unless explicitly designated',async()=>{
 const {output}=await start({isTerminal:undefined});expect(output.join('')).not.toContain('#');
});

it('a custom logger requires terminal opt-in even when the surrounding process has a TTY',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');Object.defineProperty(process.stdout,'isTTY',{configurable:true,value:true});
 try {const {output}=await start({isTerminal:undefined});expect(output.join('')).not.toContain('#');}
 finally {if(descriptor)Object.defineProperty(process.stdout,'isTTY',descriptor);else Reflect.deleteProperty(process.stdout,'isTTY');}
});
