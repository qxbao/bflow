import { streamEvents, upstreamCursor } from './sse.js';
import { artifactResponse } from './artifact-response.js';
import { uniqueHeader } from './security.js';
import { WebChatMessageResultSchema, WebChatPageResultSchema, WebEventsQuerySchema, WebArtifactReadResultSchema, WebNoticeDisplayedResultSchema } from '@bflow/contracts/web';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { WebHttpContracts, WebHttpPathParamsSchema, WebProjectInspectionResultSchema, WebProjectPreviewResultSchema,
  WebProjectMutationStatusResultSchema, WebProjectConfigurationResultSchema, WebProjectInitializationResultSchema, WebProjectSessionResultSchema, WebRunPageResultSchema, WebRunViewResultSchema, WebDecisionPageResultSchema, WEB_LIMITS,
  type UserInteractionClient } from '@bflow/contracts/web';
import { WebAuthenticatedContextSchema, type WebAuthenticatedContext } from '@bflow/contracts/web-host';
import { BrowserSessions } from './session.js';
import { ProjectRegistry } from './project-registry.js';
import { Operations } from './lifecycle-operations.js';
import { HttpError, unwrap, observeWithinDeadline } from './errors.js';

export function json(res:ServerResponse,status:number,body:unknown):void{
  res.statusCode=status;if(status===204){res.end();return;}res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));
}
async function body(req:IncomingMessage):Promise<unknown>{
  if(req.headers['content-type']?.toLowerCase().split(';')[0]?.trim()!=='application/json' || req.headers['content-encoding'])throw new HttpError('invalid_request');
  const length=req.headers['content-length'];if(length!==undefined && (!/^[0-9]+$/.test(length)||Number(length)>WEB_LIMITS.bodyBytes))throw new HttpError('payload_too_large');
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>WEB_LIMITS.bodyBytes)throw new HttpError('payload_too_large');chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new HttpError('invalid_request');}
}
/** Decode before URL normalization: encoded dot segments must never disappear. */
export function requestPath(raw:string):{path:string;query:Record<string,string>}{
  if(!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#'))throw new HttpError('invalid_request');
  const split=raw.indexOf('?'),encoded=split<0?raw:raw.slice(0,split),search=split<0?'':raw.slice(split+1);let path:string;
  try{path=decodeURIComponent(encoded!);}catch{throw new HttpError('invalid_request');}
  if(/[\\\x00-\x1f\x7f%]/.test(path) || path.split('/').some(s=>s==='.'||s==='..'))throw new HttpError('invalid_request');
  const query:Record<string,string>=Object.create(null);for(const [key,value] of new URLSearchParams(search)){if(Object.hasOwn(query,key))throw new HttpError('invalid_request');query[key]=value;}
  return {path,query};
}
export interface RouteContext {eventEpoch:string;sessions:BrowserSessions;registry:ProjectRegistry;operations:Operations;interaction:(id:string,context:WebAuthenticatedContext)=>Promise<UserInteractionClient>;principalId:string;assetsDirectory:string;serialize:<T>(fn:()=>Promise<T>)=>Promise<T>}
export async function route(req:IncomingMessage,res:ServerResponse,ctx:RouteContext):Promise<void>{
  const {path,query}=requestPath(req.url??'/');
  if(path==='/api'||path.startsWith('/api/')){
    const bootstrap=path==='/api/v1/session/bootstrap'&&req.method==='POST';
    const session=bootstrap?undefined:ctx.sessions.authenticate(req);
    const match=Object.entries(WebHttpContracts).map(([name,contract])=>{
      const keys:string[]=[];const pattern=contract.path.replace(/:([A-Za-z]+)/g,(_s,key:string)=>{keys.push(key);return '([^/]+)';});
      const found=new RegExp('^'+pattern+'$').exec(path);return found&&req.method===contract.method?{name,contract,params:Object.fromEntries(keys.map((key,i)=>[key,found[i+1]!]))}:undefined;
    }).find(Boolean);
    if(!match)throw new HttpError('not_found');
    if(req.method==='GET' && (req.headers['transfer-encoding']!==undefined || (req.headers['content-length']!==undefined && req.headers['content-length']!=='0')))throw new HttpError('invalid_request');
    let input:unknown,parsedQuery:unknown;
    try{parsedQuery=match.contract.query.parse(query);input=match.contract.body.parse(req.method==='GET'?undefined:await body(req));
      if(Object.keys(match.params).length)WebHttpPathParamsSchema.parse(match.params);
    }catch(error){if(error instanceof HttpError)throw error;throw new HttpError('invalid_request');}
    await (async()=>{
      const {name,contract,params}=match;const id=params.id;
      const respond=(value:unknown,status=200)=>{let parsed:unknown;try{parsed=contract.response.parse(value);}catch{throw new HttpError('unavailable');}json(res,status,parsed);};
      if(name==='bootstrap'){const b=WebHttpContracts.bootstrap.body.parse(input);respond(ctx.sessions.bootstrap(b.secret,res));return;}
      if(name==='session'){respond(session);return;}
      const authentication=WebAuthenticatedContextSchema.parse({principalId:ctx.principalId,browserSessionId:session!.sessionId,expiresAt:session!.expiresAt});
      if(name==='projects'){respond({apiVersion:1,items:await ctx.registry.list()});return;}
      if(name==='registerProject'){const b=WebHttpContracts.registerProject.body.parse(input);const result=await ctx.serialize(()=>{ctx.sessions.authenticate(req);return ctx.registry.register(b.path);});respond(result.project,result.created?201:200);return;}
      if(!id)throw new HttpError('not_found');
      await ctx.registry.get(id);
      if(name==='unregisterProject'){await ctx.serialize(async()=>{ctx.sessions.authenticate(req);if(ctx.operations.workspace.projectMutationStatus){const value=unwrap(WebProjectMutationStatusResultSchema.parse(await ctx.operations.workspace.projectMutationStatus(id)));if(value.projectId!==id)throw new HttpError('unavailable');if(value.initializationPending)throw new HttpError('operation_conflict');}return ctx.registry.unregister(id);});respond(undefined,204);return;}
      if(name==='operation'){respond(await ctx.operations.read(id,params.operationId!,()=>{ctx.sessions.authenticate(req);},authentication));return;}
      await ctx.registry.require(id);
      if(name==='configuration' || name==='saveConfiguration'){
        const workspace=ctx.operations.workspace;
        const result=name==='configuration'
          ? workspace.readConfiguration && await workspace.readConfiguration(id)
          : workspace.saveConfiguration && await ctx.serialize(()=>{ctx.sessions.authenticate(req);return workspace.saveConfiguration!(id,WebHttpContracts.saveConfiguration.body.parse(input));});
        if(!result)throw new HttpError('operation_not_allowed');
        if(name==='saveConfiguration'){const parsed=WebProjectConfigurationResultSchema.parse(result);if(parsed.ok && parsed.value.projectId!==id)throw new HttpError('unavailable');respond(parsed);return;}
        const value=unwrap(WebProjectConfigurationResultSchema.parse(result));if(value.projectId!==id)throw new HttpError('unavailable');respond(value);return;
      }
      if(name==='initializeProject' || name==='initialization'){
        const workspace=ctx.operations.workspace;
        const result=name==='initialization'
          ? workspace.readInitialization && await workspace.readInitialization(id,params.operationId!)
          : workspace.initializeProject && await ctx.serialize(()=>{ctx.sessions.authenticate(req);return workspace.initializeProject!(id,WebHttpContracts.initializeProject.body.parse(input));});
        if(!result)throw new HttpError('operation_not_allowed');
        const value=unwrap(WebProjectInitializationResultSchema.parse(result));if(value.projectId!==id || value.operationId!==(name==='initialization'?params.operationId:WebHttpContracts.initializeProject.body.parse(input).operationId))throw new HttpError('unavailable');respond(value,name==='initializeProject'?202:200);return;
      }
      if(name==='startSession'||name==='stopSession'){
        const b=WebHttpContracts.startSession.body.parse(name==='startSession'?input:{apiVersion:1,operationId:WebHttpContracts.stopSession.body.parse(input).operationId});
        respond(await ctx.operations.lifecycle(id,b.operationId,name==='startSession'?'session_start':'session_stop',input,()=>{ctx.sessions.authenticate(req);}),202);return;
      }
      if(name==='inspectSession'){
        const value=unwrap(WebProjectInspectionResultSchema.parse(await observeWithinDeadline(()=>ctx.operations.workspace.inspectProject(id))));if(value.projectId!==id)throw new HttpError('unavailable');respond(value);return;
      }
      if(name==='preview'){
        const value=unwrap(WebProjectPreviewResultSchema.parse(await observeWithinDeadline(()=>ctx.operations.workspace.preview(id))));if(value.projectId!==id)throw new HttpError('unavailable');respond(value);return;
      }
      if(name==='command'){const command=WebHttpContracts.command.body.parse(input);if(command.projectId!==id)throw new HttpError('forbidden');respond(await ctx.operations.command(command,()=>{ctx.sessions.authenticate(req);},authentication),202);return;}
      const client=await observeWithinDeadline(()=>ctx.interaction(id,authentication));
      if(name==='projectSession'){const value=unwrap(WebProjectSessionResultSchema.parse(await observeWithinDeadline(()=>client.readProjectSession(id))));if(value.projectId!==id)throw new HttpError('unavailable');respond(value);return;}
      if(name==='runs'){respond(unwrap(WebRunPageResultSchema.parse(await observeWithinDeadline(()=>client.listRuns(id,WebHttpContracts.runs.query.parse(query))))));return;}
      if(name==='run'){const value=unwrap(WebRunViewResultSchema.parse(await observeWithinDeadline(()=>client.readRun(id,params.runId!))));if(value.runId!==params.runId)throw new HttpError('unavailable');respond(value);return;}
      if(name==='decisions'){respond(unwrap(WebDecisionPageResultSchema.parse(await observeWithinDeadline(()=>client.listDecisions(id)))));return;}
      if(name==='events'){
        const header=uniqueHeader(req,'last-event-id'),q=WebEventsQuerySchema.parse(parsedQuery);
        if(header!==undefined && q.cursor!==undefined && header!==q.cursor)throw new HttpError('invalid_request');
        const cursor=upstreamCursor(ctx.eventEpoch,header??q.cursor);
        await streamEvents(req,res,client.events(id,cursor),id,ctx.eventEpoch,()=>{ctx.sessions.authenticate(req);},Date.parse(session!.expiresAt));return;
      }
      if(name==='artifact'){
        const value=unwrap(WebArtifactReadResultSchema.parse(await observeWithinDeadline(()=>client.readArtifact(id,params.artifactId!))));
        await artifactResponse(req,res,value,params.artifactId!,()=>{ctx.sessions.authenticate(req);});return;
      }
      if(name==='noticeDisplayed'){
        const value=await ctx.serialize(()=>{ctx.sessions.authenticate(req);return observeWithinDeadline(()=>client.acknowledgeNotice(id,params.noticeId!));});
        const displayed=unwrap(WebNoticeDisplayedResultSchema.parse(value));if(displayed.noticeId!==params.noticeId)throw new HttpError('unavailable');respond(displayed);return;
      }
      if(name==='messages'){
        const q=WebHttpContracts.messages.query.parse(parsedQuery);
        const value=unwrap(WebChatPageResultSchema.parse(await observeWithinDeadline(()=>client.listMessages(id,params.sessionId!,q.cursor))));
        if(value.items.some(message=>message.sessionId!==params.sessionId))throw new HttpError('unavailable');respond(value);return;
      }
      if(name==='sendMessage'){
        const b=WebHttpContracts.sendMessage.body.parse(input);
        if(b.projectId!==id||b.sessionId!==params.sessionId)throw new HttpError('forbidden');
        const value=unwrap(WebChatMessageResultSchema.parse(await ctx.serialize(()=>{ctx.sessions.authenticate(req);return observeWithinDeadline(()=>client.sendMessage(b));})));
        if(value.messageId!==b.messageId||value.sessionId!==b.sessionId)throw new HttpError('unavailable');respond(value,202);return;
      }
      throw new HttpError('operation_not_allowed');
    })();return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError('not_found');
  await staticAsset(path,req,res,ctx.assetsDirectory);
}
async function staticAsset(path:string,req:IncomingMessage,res:ServerResponse,root:string):Promise<void>{
  const requested=join(root,path==='/'?'index.html':path),extension=extname(path);
  let target:string;
  try{target=await realpath(requested);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new HttpError('not_found');if(extension)throw new HttpError('not_found');target=await realpath(join(root,'index.html'));}
  if(!target.startsWith(root+sep))throw new HttpError('not_found');
  let file;try{file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw new HttpError('not_found');}
  try{const info=await file.stat();if(!info.isFile() || info.size>32*1024*1024)throw new HttpError('not_found');
    const data=await file.readFile();res.statusCode=200;res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'} as Record<string,string>)[extname(target)]??'application/octet-stream');res.setHeader('Content-Length',data.length);res.end(req.method==='HEAD'?undefined:data);
  }finally{await file.close();}
}
