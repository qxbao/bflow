import { expect, it } from 'vitest';
import { ProjectionFeed } from '../../src/interaction/events.js';
it('replays a bounded presentation ring and resets expired, foreign, future and restart cursors', () => {
  const feed = new ProjectionFeed('p', 3);
  const initial = feed.read(); expect(initial.items[0]?.type).toBe('reset');
  const cursor = initial.items[0]!.cursor;
  feed.publish('notice', ['n']);
  expect(feed.read(cursor).items.map(e=>e.type)).toEqual(['notice']);
  expect(feed.read(feed.read(cursor).items[0]!.cursor).items).toEqual([]);
  for(let i=0;i<4;i++)feed.publish('invalidate',[]);
  expect(feed.read(cursor).items[0]?.type).toBe('reset');
  expect(feed.size).toBe(3);
  for(const value of ['invalid','foreign:1',cursor.split(':')[0]+':99999999999999999999',new ProjectionFeed('other').read().items[0]!.cursor]) {
    expect(feed.read(value).items[0]?.type).toBe('reset');
  }
  expect(new ProjectionFeed('p').read(cursor).items[0]?.type).toBe('reset');
});
it('returns no more than 100 events without skipping retained events',()=>{
 const f=new ProjectionFeed('p'); const start=f.read().items[0]!.cursor;
 for(let i=0;i<205;i++)f.publish('invalidate',[]);
 const a=f.read(start), b=f.read(a.items.at(-1)!.cursor), c=f.read(b.items.at(-1)!.cursor);
 expect([a.items.length,b.items.length,c.items.length]).toEqual([100,100,5]);
});
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureAgenticHost, queryAgenticHostInteraction } from '../../dist/agentic/host-controller.js';
import { openUserInteractionClient, interactionProjectId } from '../../src/interaction/client.js';
import { WebEventSchema, WebPageSchema } from '@bflow/contracts';
it('polls an actual host, rejects cross-project reads and resets after host restart without starting a workflow',async()=>{
 const repositoryPath=await mkdtemp('/tmp/w05-events-host-'),sessionId='events-host',herdrBinary=join(repositoryPath,'herdr.mjs');
 await writeFile(herdrBinary,"#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+'\\n');",{mode:0o700});
 let host=await ensureAgenticHost({repositoryPath,sessionId,herdrBinary});
 const projectId=interactionProjectId(repositoryPath),client=await openUserInteractionClient({repositoryPath,sessionId});
 const poll=async(cursor?:string)=>WebPageSchema(WebEventSchema).parse(await queryAgenticHostInteraction({repositoryPath,sessionId},{projectId,query:cursor?{cursor}:{}},'interaction_events'));
 try{
 const first=await poll();expect(first.items[0]?.type).toBe('reset');const cursor=first.items[0]!.cursor;
 await expect(queryAgenticHostInteraction({repositoryPath,sessionId},{projectId:'foreign',query:{}},'interaction_events')).rejects.toThrow();
 const iter=client.events(projectId,cursor)[Symbol.asyncIterator]();const pending=iter.next();await new Promise(r=>setTimeout(r,25));await iter.return?.();await pending;
 expect((await readdir(repositoryPath))).not.toContain('workflow-created');
 await host.shutdown();host=await ensureAgenticHost({repositoryPath,sessionId,herdrBinary});expect((await poll(cursor)).items[0]?.type).toBe('reset');
 expect(await client.acknowledgeNotice(projectId,'n')).toMatchObject({ok:false});
 expect(await client.readArtifact('foreign','a')).toMatchObject({ok:false});
 }finally{await host.shutdown();await rm(repositoryPath,{recursive:true,force:true});}
});
it('publishes nothing while the projection is unchanged, so polling clients cannot self-sustain a refresh loop',async()=>{
 const repositoryPath=await mkdtemp('/tmp/w09-events-quiet-'),sessionId='events-quiet',herdrBinary=join(repositoryPath,'herdr.mjs');
 await writeFile(herdrBinary,"#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+'\\n');",{mode:0o700});
 const host=await ensureAgenticHost({repositoryPath,sessionId,herdrBinary});
 const projectId=interactionProjectId(repositoryPath);
 const poll=async(cursor?:string)=>WebPageSchema(WebEventSchema).parse(await queryAgenticHostInteraction({repositoryPath,sessionId},{projectId,query:cursor?{cursor}:{}},'interaction_events'));
 try{
  let cursor=(await poll()).items[0]!.cursor;const seen:string[]=[];
  for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,1100));const page=await poll(cursor);for(const event of page.items){seen.push(event.type);cursor=event.cursor;}}
  expect(seen).toEqual([]);
 }finally{await host.shutdown();await rm(repositoryPath,{recursive:true,force:true});}
},30000);
