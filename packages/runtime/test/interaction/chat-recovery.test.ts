import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostChat } from '../../src/interaction/chat.js';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it('serializes simultaneous tab intents by ID and does not replay an uncertain dispatch after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-recovery-'));dirs.push(dir);const wires:string[]=[];
 const options={directory:dir,projectId:'p',hostSessionId:'host',session:async()=>({sessionId:'conv',nativeSessionId:'native',paneId:'pane',provider:'codex',ready:true,busy:false}),prompt:async(wire:string)=>{wires.push(wire);throw Error('lost ACK');},admit:async()=>({messageId:'bound'})};
 const input={apiVersion:1,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d42',projectId:'p',sessionId:'conv',content:'Một tin'};
 const a=new HostChat(options),b=new HostChat(options);await Promise.all([a.send(input,'user'),b.send(input,'user')]);expect(wires).toHaveLength(1);
 await new HostChat(options).pump();expect(wires).toHaveLength(1);
 expect((await b.list('conv')).items).toHaveLength(1);
 await b.echo({nativeSessionId:'native',paneId:'pane',prompt:wires[0]!});expect((await b.list('conv')).items[0]?.delivery).toBe('delivered');
});
it('settles only never-dispatched old-native drafts and lets a new native session receive new input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-replace-'));dirs.push(dir);const wires:string[]=[];let nativeSessionId='old',busy=true;
 const options={directory:dir,projectId:'p',hostSessionId:'host',session:async()=>({sessionId:'conv',nativeSessionId,paneId:'pane',provider:'claude',ready:true,busy}),prompt:async(wire:string)=>{wires.push(wire);},admit:async()=>({messageId:'bound'})};
 const chat=new HostChat(options);await chat.send({apiVersion:1,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d42',projectId:'p',sessionId:'conv',content:'old unsent'},'user');
 nativeSessionId='replacement';busy=false;await chat.send({apiVersion:1,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d43',projectId:'p',sessionId:'conv',content:'new intent'},'user');
 expect(wires).toHaveLength(1);expect(wires[0]).toContain('new intent');expect((await chat.list('conv')).items.find(m=>m.content==='old unsent')?.delivery).toBe('failed');
});
it('does not block a new native session behind an older unknown dispatch, while never resending the old one',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-unknown-replace-'));dirs.push(dir);const wires:string[]=[];let nativeSessionId='old';
 const options={directory:dir,projectId:'p',hostSessionId:'host',session:async()=>({sessionId:'conv',nativeSessionId,paneId:'pane',provider:'claude',ready:true,busy:false}),prompt:async(wire:string)=>{wires.push(wire);throw Error('lost ACK');},admit:async()=>({})};
 const chat=new HostChat(options),input={apiVersion:1,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d42',projectId:'p',sessionId:'conv',content:'old unknown'};
 await chat.send(input,'user');nativeSessionId='replacement';await chat.send({...input,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d43',content:'new intent'},'user');
 expect(wires).toHaveLength(2);await chat.pump();expect(wires).toHaveLength(2);expect((await chat.list('conv')).items.find(m=>m.content==='old unknown')?.delivery).toBe('unknown_delivery');
});
it('recovers an already admitted trusted turn after a crash before delivery acknowledgement without admitting it again',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chat-admitted-'));dirs.push(dir);let wire='',admitted=false,admissions=0;
 const input={apiVersion:1,messageId:'2ac8910d-bd7d-4766-bcc1-dc0ab2321d42',projectId:'p',sessionId:'conv',content:'intent'};
 const options={directory:dir,projectId:'p',hostSessionId:'host',session:async()=>({sessionId:'conv',nativeSessionId:'native',paneId:'pane',provider:'claude',ready:true,busy:false}),prompt:async(value:string)=>{wire=value;},admit:async()=>{admissions++;admitted=true;throw Error('after durable intake');},observeAdmission:async()=>admitted?{messageId:input.messageId}:undefined};
 const chat=new HostChat(options);await chat.send(input,'user');await expect(chat.echo({nativeSessionId:'native',paneId:'pane',prompt:wire})).rejects.toThrow();
 const restarted=new HostChat(options);expect((await restarted.list('conv')).items[0]?.delivery).toBe('delivered');expect(admissions).toBe(1);
});
