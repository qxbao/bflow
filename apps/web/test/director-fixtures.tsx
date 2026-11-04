// Synthetic Director data for component tests only; never imported by production.
import { vi } from 'vitest';
import { WebDirectorViewSchema, DirectorMessageSchema, type WebDirectorView, type DirectorMessage } from '@bflow/contracts/web';
export const at='2026-11-04T00:00:00.000Z';
export function view(patch:Partial<WebDirectorView>&{presence?:'active'|'waiting'|'absent'}={}):WebDirectorView{
  const {presence='absent',...rest}=patch;
  return WebDirectorViewSchema.parse({apiVersion:1,projectId:'p',layout:'director',sessionId:'host',
    snapshot:{schemaVersion:1,generatedAt:at,director:{presence,...(presence!=='absent'?{provider:'claude',heartbeatAt:at}:{})},runs:[],pendingApprovals:0,pendingQuestions:0,issues:[]},
    transcriptSeq:0,cliCaptureMayBeIncomplete:false,observedAt:at,...rest});
}
export const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function message(seq:number,patch:Partial<DirectorMessage>={}):DirectorMessage{
  return DirectorMessageSchema.parse({schemaVersion:1,seq,messageId:`m${seq}`,author:seq%2?'user':'director',channel:seq%2?'web':'cli',text:`Tin ${seq}`,at,...patch});
}
export const readySession={apiVersion:1,projectId:'p',sessionId:'host',state:'ready',pendingIntakes:[],blockers:[{code:'chat_adapter_unavailable',message:'legacy'}],updatedAt:at};
export const sessionRead=(data:unknown=readySession)=>({key:'session:p',data:data as never,loading:false});
type Route=(path:string,init:RequestInit)=>unknown|Promise<unknown>;
/** Fake Local Server for the Director routes. Transcript paging follows the private `a<seq>`/`b<seq>` convention, max 100 items. */
export function directorServer(options:{view?:()=>WebDirectorView|Response;messages?:DirectorMessage[];extra?:Route}={}){
  const state={messages:options.messages??[] as DirectorMessage[],posts:[] as {path:string;body:any}[],gets:[] as string[]};
  const page=(cursor:string|null)=>{
    const all=state.messages;let items:DirectorMessage[],nextCursor:string|undefined;
    if(!cursor){items=all.slice(-100);nextCursor=`a${items.at(-1)?.seq??0}`;}
    else if(cursor.startsWith('a')){const after=Number(cursor.slice(1));items=all.filter(m=>m.seq>after).slice(0,100);nextCursor=`a${items.at(-1)?.seq??after}`;}
    else{const before=Number(cursor.slice(1));const older=all.filter(m=>m.seq<before);items=older.slice(-100);nextCursor=older.length>items.length&&items.length?`b${items[0]!.seq}`:undefined;}
    return {apiVersion:1,items,...(nextCursor?{nextCursor}:{})};
  };
  const fetcher=vi.fn(async(path:string,init:RequestInit={})=>{
    const extra=await options.extra?.(path,init);
    if(extra instanceof Response)return extra;
    if(extra!==undefined)return Response.json(extra);
    if(init.method==='POST'){state.posts.push({path,body:JSON.parse(String(init.body))});}
    else state.gets.push(path);
    const url=new URL(path,'http://local');
    if(url.pathname==='/api/v1/projects/p/director'){const value=options.view?.()??view({transcriptSeq:state.messages.at(-1)?.seq??0});return value instanceof Response?value:Response.json(value);}
    if(url.pathname==='/api/v1/projects/p/director/messages'&&init.method==='POST'){
      const body=state.posts.at(-1)!.body;const existing=state.messages.find(m=>m.messageId===body.messageId);
      const stored=existing??message((state.messages.at(-1)?.seq??0)+1,{messageId:body.messageId,author:'user',channel:'web',text:body.content});
      if(!existing)state.messages.push(stored);
      return Response.json(stored,{status:202});
    }
    if(url.pathname==='/api/v1/projects/p/director/messages')return Response.json(page(url.searchParams.get('cursor')));
    if(url.pathname==='/api/v1/projects/p/session')return Response.json(readySession);
    return Response.json({apiVersion:1,code:'not_found',message:'missing',retryable:false,correlationId:'t'},{status:404});
  });
  vi.stubGlobal('fetch',fetcher);
  return {state,fetcher};
}
export const locks={request:async(_key:string,work:()=>Promise<unknown>)=>work()};
