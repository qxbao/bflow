import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebEventSchema, WebEventCursorSchema, WEB_LIMITS, type WebEvent } from '@bflow/contracts/web';
import { HttpError, observeWithinDeadline } from './errors.js';
/** Local Server epoch invalidates old cursors even when the Runtime host survives a web restart. */
export function upstreamCursor(epoch: string, cursor?: string): string | undefined {
  if(cursor===undefined)return undefined;
  if(!WebEventCursorSchema.safeParse(cursor).success)throw new HttpError('invalid_request');
  return cursor.startsWith(epoch+'_') ? cursor.slice(epoch.length+1) : undefined;
}
export async function streamEvents(req: IncomingMessage, res: ServerResponse, source: AsyncIterable<WebEvent>, projectId: string,
  epoch: string, authenticate: ()=>void, expiresAt: number): Promise<{maxQueued:number}> {
  const iterator=source[Symbol.asyncIterator]();
  const queue:WebEvent[]=[];let stopped=false,maxQueued=0,wake:(()=>void)|undefined;
  let cancelRead:(()=>void)|undefined;
  const stop=()=>{if(stopped)return;stopped=true;cancelRead?.();wake?.();};
  const readNext=()=>new Promise<IteratorResult<WebEvent>|undefined>((resolve,reject)=>{
    const clear=()=>{res.off('close',cancel);req.off('aborted',cancel);if(cancelRead===cancel)cancelRead=undefined;};
    const cancel=()=>{clear();resolve(undefined);};
    cancelRead=cancel;res.once('close',cancel);req.once('aborted',cancel);
    if(stopped || res.destroyed){cancel();return;}
    Promise.resolve().then(()=>iterator.next()).then(value=>{clear();resolve(value);},error=>{clear();reject(error);});
  });
  const frame=(input:unknown)=>{const event=WebEventSchema.parse(input);if(event.projectId!==projectId)throw new HttpError('unavailable');
    return WebEventSchema.parse({...event,cursor:`${epoch}_${event.cursor}`});};
  const close=()=>{stop();};res.once('close',close);req.once('aborted',close);
  const expiry=setTimeout(()=>res.destroy(),Math.max(0,Math.min(2147483647,expiresAt-Date.now())));
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  const write=async(text:string)=>{
    if(stopped || res.destroyed)return;
    if(res.write(text))return;
    await new Promise<void>((resolve,reject)=>{
      const clear=()=>{res.off('drain',drain);res.off('close',done);res.off('error',error);};
      const drain=()=>{clear();resolve();},done=()=>{clear();stop();resolve();},error=(e:Error)=>{clear();reject(e);};
      res.once('drain',drain);res.once('close',done);res.once('error',error);
    });
  };
  try {
    const first=await observeWithinDeadline(readNext);
    if(!first || stopped || res.destroyed)return {maxQueued};
    if(first.done)throw new HttpError('unavailable');
    queue.push(frame(first.value));maxQueued=1;
    authenticate();
    res.statusCode=200;res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Accel-Buffering','no');res.setTimeout(0);res.flushHeaders();
    heartbeat=setInterval(()=>{
      try{authenticate();if(!stopped && res.writableLength===0)res.write(': heartbeat\n\n');}catch{res.destroy();}
    },WEB_LIMITS.heartbeatSeconds*1000);
    const produce=(async()=>{
      try {while(!stopped){const next=await readNext();if(!next || stopped)break;
        if(next.done){stop();break;}
        const value=frame(next.value);
        if(queue.length>=WEB_LIMITS.eventsPerClient){res.destroy();stop();break;}
        queue.push(value);maxQueued=Math.max(maxQueued,queue.length);wake?.();wake=undefined;
      }}catch{res.destroy();stop();}
    })();
    while(!stopped){const event=queue.shift();if(!event){await new Promise<void>(resolve=>{wake=resolve;if(stopped)resolve();});continue;}
      await write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    await produce;
    if(!res.destroyed)res.end();
    return {maxQueued};
  } finally {
    stop();clearTimeout(expiry);if(heartbeat)clearInterval(heartbeat);res.off('close',close);req.off('aborted',close);
    // A broken source cannot hold server shutdown hostage. Runtime's iterator return wakes its poll timer.
    void Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});
  }
}
