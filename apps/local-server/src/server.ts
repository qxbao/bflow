import { createServer } from 'node:http';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { LocalWorkspaceServices, UserInteractionClient } from '@bflow/contracts/web';
import { PrivateState, OperationIndex } from './operation-index.js';
import { ProjectRegistry } from './project-registry.js';
import { Operations } from './lifecycle-operations.js';
import { BrowserSessions } from './session.js';
import { route, json } from './routes.js';
import { secureRequest, securityHeaders } from './security.js';
import { publicError, WebApiErrorStatus } from './errors.js';
export interface LocalWebServerOptions {
  host:'127.0.0.1';port:number;stateDirectory:string;assetsDirectory:string;
  workspace:LocalWorkspaceServices;interaction:(projectId:string)=>Promise<UserInteractionClient>;
}
export interface LocalWebServer {readonly origin:string;issueBootstrap():Promise<string>;close():Promise<void>}
/** Listener creation is explicit; importing the package has no side effects. No fallback backend. */
export async function createLocalWebServer(options:LocalWebServerOptions):Promise<LocalWebServer>{
  // W00 did not freeze a CLI options schema. Validate locally, pending an integration-owned additive schema.
  if(!options || Object.keys(options).some(k=>!['host','port','stateDirectory','assetsDirectory','workspace','interaction'].includes(k)) || options.host!=='127.0.0.1' || !Number.isInteger(options.port) || options.port<0 || options.port>65535 || typeof options.stateDirectory!=='string' || !isAbsolute(options.stateDirectory) || typeof options.assetsDirectory!=='string' || !isAbsolute(options.assetsDirectory) || typeof options.interaction!=='function' || !options.workspace || ['inspectProject','startSession','stopSession','reconcileSessionOperation','preview'].some(k=>typeof Reflect.get(options.workspace,k)!=='function'))throw new Error('Invalid Local Server options');
  const assetsDirectory=await realpath(options.assetsDirectory),state=await PrivateState.open(options.stateDirectory);
  let queue:Promise<unknown>=Promise.resolve();
  const serialize=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  const index=new OperationIndex(state),registry=new ProjectRegistry(state,index),operations=new Operations(index,options.workspace,options.interaction,serialize,id=>registry.require(id)),sessions=new BrowserSessions();
  const pending=new Set<Promise<void>>();
  let origin='';let closed=false;
  const server=createServer({requestTimeout:15000,headersTimeout:10000,maxHeaderSize:16384},(req,res)=>{
    securityHeaders(res);
    const active=(async()=>{try{secureRequest(req,origin);await route(req,res,{sessions,registry,operations,interaction:options.interaction,assetsDirectory,serialize});}
      catch(error){if(!res.headersSent){const safe=publicError(error);json(res,WebApiErrorStatus[safe.code],safe);}else res.destroy();}
    })();pending.add(active);void active.finally(()=>pending.delete(active));
  });
  server.timeout=15000;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,()=>{server.off('error',reject);resolve();});});}
  catch(error){await state.close();throw error;}
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing loopback address');origin=`http://127.0.0.1:${address.port}`;
  return {origin,async issueBootstrap(){if(closed)throw new Error('Server closed');return sessions.issue();},async close(){if(closed)return;closed=true;operations.shutdown();await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});await Promise.allSettled([...pending]);await queue;await state.close();}};
}
