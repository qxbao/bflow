import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath } from 'node:fs/promises';
import { LocalWebServerConfigSchema, WebAuthenticatedContextSchema, type WebAuthenticatedContext, type WebOperationIndexRecord } from '@bflow/contracts/web-host';
import type { OperationResult } from '@bflow/contracts';
import type { LocalWorkspaceServices, UserInteractionClient, WebProject, WebOperation } from '@bflow/contracts/web';
import { PrivateState, OperationIndex } from './operation-index.js';
import { ProjectRegistry } from './project-registry.js';
import { Operations } from './lifecycle-operations.js';
import { BrowserSessions } from './session.js';
import { route, json } from './routes.js';
import { secureRequest, securityHeaders } from './security.js';
import { publicError, WebApiErrorStatus } from './errors.js';
export interface LocalWebServices {
  workspace: LocalWorkspaceServices;
  interaction: (projectId: string, context: WebAuthenticatedContext) => Promise<UserInteractionClient>;
  hostSessionId?: (projectId: string) => Promise<string>;
  readHistoricalOperation?: (record: WebOperationIndexRecord) => Promise<OperationResult<WebOperation>>;
}
export interface LocalWebCompositionContext {
  readonly principalId: string;
  resolveProject(projectId: string): Promise<WebProject>;
}
export interface LocalWebServerOptions {
  host:'127.0.0.1';port:number;stateDirectory:string;assetsDirectory:string;
  workspace?: LocalWorkspaceServices;
  interaction?: LocalWebServices['interaction'];
  readHistoricalOperation?: LocalWebServices['readHistoricalOperation'];
  hostSessionId?: LocalWebServices['hostSessionId'];
  compose?: (context: LocalWebCompositionContext) => LocalWebServices | Promise<LocalWebServices>;
}
export interface LocalWebServer {readonly origin:string;issueBootstrap():Promise<string>;close():Promise<void>}
/** Listener creation is explicit; importing the package has no side effects. No fallback backend. */
export async function createLocalWebServer(options:LocalWebServerOptions):Promise<LocalWebServer>{
  const config = LocalWebServerConfigSchema.parse({host:options.host,port:options.port,stateDirectory:options.stateDirectory,assetsDirectory:options.assetsDirectory});
  if (Object.keys(options).some(k=>!['host','port','stateDirectory','assetsDirectory','workspace','interaction','compose','readHistoricalOperation','hostSessionId'].includes(k)) ||
      (options.compose && (options.workspace || options.interaction || options.readHistoricalOperation || options.hostSessionId)) ||
      (options.compose !== undefined && typeof options.compose !== 'function')) throw new Error('Invalid Local Server options');
  const assetsDirectory=await realpath(config.assetsDirectory),state=await PrivateState.open(config.stateDirectory);
  let queue:Promise<unknown>=Promise.resolve();
  const serialize=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const index=new OperationIndex(state),registry=new ProjectRegistry(state,index),sessions=new BrowserSessions();
  let services: LocalWebServices;
  try {
    services = options.compose ? await options.compose({principalId:state.principalId, resolveProject:id=>registry.require(id)}) :
      {workspace:options.workspace!,interaction:options.interaction!,...(options.hostSessionId?{hostSessionId:options.hostSessionId}:{}),...(options.readHistoricalOperation?{readHistoricalOperation:options.readHistoricalOperation}:{})};
    if (!services || typeof services.interaction !== 'function' || !services.workspace ||
        ['inspectProject','startSession','stopSession','reconcileSessionOperation','preview'].some(k=>typeof Reflect.get(services.workspace,k)!=='function') ||
        (services.hostSessionId !== undefined && typeof services.hostSessionId !== 'function') ||
        (services.readHistoricalOperation !== undefined && typeof services.readHistoricalOperation !== 'function')) throw new Error('Invalid Local Server services');
  } catch(error) { await state.close(); throw error; }
  const interaction:LocalWebServices['interaction']=(id,context)=>services.interaction(id,WebAuthenticatedContextSchema.parse(context));
  const operations=new Operations(index,services.workspace,interaction,serialize,id=>registry.require(id),services.readHistoricalOperation,services.hostSessionId);
  const eventEpoch=randomUUID();
  const pending=new Set<Promise<void>>();
  let origin='';let closed=false;
  const server=createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:16384},(req,res)=>{
    securityHeaders(res);
    const active=(async()=>{try{secureRequest(req,origin);await route(req,res,{eventEpoch,sessions,registry,operations,interaction,principalId:state.principalId,assetsDirectory,serialize});}
      catch(error){if(!res.headersSent){const safe=publicError(error);json(res,WebApiErrorStatus[safe.code],safe);}else res.destroy();}
    })();pending.add(active);void active.finally(()=>pending.delete(active));
  });
  server.timeout=15000;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,()=>{server.off('error',reject);resolve();});});}
  catch(error){await state.close();throw error;}
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing loopback address');origin=`http://127.0.0.1:${address.port}`;
  return {origin,async issueBootstrap(){if(closed)throw new Error('Server closed');return sessions.issue();},async close(){if(closed)return;closed=true;operations.shutdown();await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});await Promise.allSettled([...pending]);await queue;await state.close();}};
}
