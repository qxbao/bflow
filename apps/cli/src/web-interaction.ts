import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { IdentifierSchema, type OperationResult } from '@bflow/contracts';
import { WebChatMessageResultSchema, WebChatPageResultSchema, WebChatSendSchema, WebCommandSchema, WebNoticeDisplayedResultSchema,
  WebOperationResponseSchema, WebProjectSchema, WebProjectSessionResultSchema,
  type UserInteractionClient, type WebOperation, type WebProject } from '@bflow/contracts/web';
import { canonicalWebJson, webCommandFingerprint, WebPrincipalSchema, WebAuthenticatedContextSchema,
  WebOperationIndexRecordSchema, WebIssuerRegistrationSchema, WebIssuerCredentialSchema,
  type WebAuthenticatedContext, type WebOperationIndexRecord } from '@bflow/contracts/web-host';
import { findPrivateRuntimeStateDirectory, openUserInteractionClient, registerUserInteractionIssuer } from '@bflow/runtime';
import { identifyRepository } from './repository.js';

type WebIssuerCredential = z.infer<typeof WebIssuerCredentialSchema>;

interface InteractionComposition {
  principalId: string;
  resolveProject(id: string): Promise<WebProject>;
}
interface InteractionDependencies {
  register?: typeof registerUserInteractionIssuer;
  openClient?: typeof openUserInteractionClient;
  sessionId?: (project: WebProject) => Promise<string>;
}
const unavailable = (): OperationResult<WebOperation> => ({ok:false,error:{code:'transport_unavailable',retryable:true,
  message:'Host interaction unavailable; observe the same operation ID. No command was resent.'}});
const transportUnavailable = <T>(message: string): OperationResult<T> => ({
  ok: false,
  error: { code: 'transport_unavailable', retryable: true, message }
});
const IPC_PROBE_TIMEOUT_Symbol = Symbol('ipc-probe-timeout');
const COLD_REGISTER_PROBE_MS = 2500;
const HEALTHY_SESSION_PROBE_MS = 3800;
const DEGRADED_SESSION_PROBE_MS = 1200;

async function withProbeTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(IPC_PROBE_TIMEOUT_Symbol), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readLiveHostOwnerStamp(repositoryPath: string, hostSessionId: string): Promise<string | undefined> {
  try {
    const stateRoot = findPrivateRuntimeStateDirectory(repositoryPath);
    if (!stateRoot) return undefined;
    const raw = await readFile(join(stateRoot, 'host', hostSessionId, 'owner.json'), 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 1) return undefined;
    process.kill(Number(parsed.pid), 0);
    return raw;
  } catch {
    return undefined;
  }
}

/** Private signer closure. Only authenticated Local Server composition constructs this port. */
export function createWebInteractionServices(context: InteractionComposition, dependencies: InteractionDependencies = {}) {
  IdentifierSchema.parse(context.principalId);
  const {publicKey, privateKey}=generateKeyPairSync('ed25519');
  const issuerId=`web-${context.principalId}`,keyId=randomUUID(),principalId=`local-user-${process.getuid?.()??'local'}`;
  const register=dependencies.register??registerUserInteractionIssuer,openClient=dependencies.openClient??openUserInteractionClient;
  const session=dependencies.sessionId??(async(project:WebProject)=>(await identifyRepository(project.canonicalPath)).sessionName);
  const publicKeyPem=publicKey.export({type:'spki',format:'pem'});
  const credentialCache=new Map<string,{credential:WebIssuerCredential;ownerStamp:string}>();
  const inFlightRegistrations=new Map<string,Promise<WebIssuerCredential>>();

  const resolveCredential=async(project:WebProject,hostSessionId:string,forceRefresh=false):Promise<WebIssuerCredential>=>{
    const cacheKey=canonicalWebJson([project.projectId,hostSessionId]);
    const ownerStamp=await readLiveHostOwnerStamp(project.canonicalPath,hostSessionId);
    if(!forceRefresh && ownerStamp!==undefined){
      const cached=credentialCache.get(cacheKey);
      if(cached && cached.ownerStamp===ownerStamp)return cached.credential;
    }
    if(forceRefresh)credentialCache.delete(cacheKey);
    const existing=inFlightRegistrations.get(cacheKey);
    if(existing && !forceRefresh)return existing;
    const pending=(async()=>{
      const host={repositoryPath:project.canonicalPath,sessionId:hostSessionId};
      const registration=WebIssuerRegistrationSchema.parse({issuerId,keyId,principalId,projectId:project.projectId,hostSessionId,
        publicKey:publicKeyPem});
      // Re-registering this exact key is idempotent. A restarted host needs fresh registration,
      // which is owner IPC only and never a retry of an execute mutation.
      const registered=WebIssuerCredentialSchema.parse(await register(host,registration));
      if(registered.principalId!==principalId)throw new Error('Host principal mismatch');
      const liveStamp=ownerStamp??await readLiveHostOwnerStamp(project.canonicalPath,hostSessionId);
      if(liveStamp!==undefined)credentialCache.set(cacheKey,{credential:registered,ownerStamp:liveStamp});
      else credentialCache.delete(cacheKey);
      return registered;
    })();
    inFlightRegistrations.set(cacheKey,pending);
    try{return await pending;}
    finally{if(inFlightRegistrations.get(cacheKey)===pending)inFlightRegistrations.delete(cacheKey);}
  };

  const clientFromCredential=async(project:WebProject,hostSessionId:string,registered:WebIssuerCredential,browser?:WebAuthenticatedContext)=>{
    const host={repositoryPath:project.canonicalPath,sessionId:hostSessionId};
    return openClient({...host,interaction:{credential:registered.credential,sign(input){
      if(!browser || Date.parse(browser.expiresAt)<=Date.now())throw new Error('Browser session expired');
      const command=WebCommandSchema.parse(input);
      if(command.projectId!==project.projectId)throw new Error('Foreign command');
      const now=Date.now(),body={schemaVersion:1,source:'local_web',issuerId,keyId,principalId,browserSessionId:browser.browserSessionId,
        projectId:project.projectId,hostSessionId,capability:'user_interaction',commandId:command.commandId,commandDigest:webCommandFingerprint(command),
        issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(now+60000,Date.parse(browser.expiresAt))).toISOString(),nonce:randomUUID()};
      return WebPrincipalSchema.parse({...body,signature:{algorithm:'ed25519',value:sign(null,Buffer.from(canonicalWebJson(body)),privateKey).toString('base64')}});
    }}});
  };

  const authorizedClient=async(project:WebProject,hostSessionId:string,browser?:WebAuthenticatedContext,forceRefresh=false)=>{
    const registered=await resolveCredential(project,hostSessionId,forceRefresh);
    return clientFromCredential(project,hostSessionId,registered,browser);
  };

  return {
    async hostSessionId(projectId:string):Promise<string>{
      const project=WebProjectSchema.parse(await context.resolveProject(IdentifierSchema.parse(projectId)));
      if(project.projectId!==projectId)throw new Error('Foreign registered project');
      return IdentifierSchema.parse(await session(project));
    },
    async interaction(projectId:string,input:WebAuthenticatedContext):Promise<UserInteractionClient>{
      const browser=WebAuthenticatedContextSchema.parse(input);
      if(browser.principalId!==context.principalId || Date.parse(browser.expiresAt)<=Date.now())throw new Error('Invalid browser context');
      const project=WebProjectSchema.parse(await context.resolveProject(IdentifierSchema.parse(projectId)));
      if(project.projectId!==projectId)throw new Error('Foreign registered project');
      const hostSessionId=await session(project);
      let client:UserInteractionClient;
      let sessionCredential:WebIssuerCredential|undefined;
      let registerTimedOut=false;
      // Register the available channel before action projection. This never ensures a host;
      // missing/frozen hosts stay readable as unavailable through the read-only client.
      try{
        sessionCredential=await withProbeTimeout(()=>resolveCredential(project,hostSessionId),COLD_REGISTER_PROBE_MS);
        client=await clientFromCredential(project,hostSessionId,sessionCredential,browser);
      }catch(error){
        registerTimedOut=error===IPC_PROBE_TIMEOUT_Symbol;
        client=await openClient({repositoryPath:project.canonicalPath,sessionId:hostSessionId});
      }
      const acquireAuthenticated=async(withSigner:boolean,forceRefresh=false)=>{
        if(!forceRefresh && sessionCredential){
          const liveStamp=await readLiveHostOwnerStamp(project.canonicalPath,hostSessionId);
          const cacheKey=canonicalWebJson([project.projectId,hostSessionId]);
          const cached=credentialCache.get(cacheKey);
          if(liveStamp===undefined || (cached && cached.ownerStamp===liveStamp)){
            return clientFromCredential(project,hostSessionId,sessionCredential,withSigner?browser:undefined);
          }
        }
        sessionCredential=await resolveCredential(project,hostSessionId,forceRefresh);
        return clientFromCredential(project,hostSessionId,sessionCredential,withSigner?browser:undefined);
      };
      const sessionProbeMs=registerTimedOut?DEGRADED_SESSION_PROBE_MS:HEALTHY_SESSION_PROBE_MS;
      return {...client,
        async readProjectSession(id){
          if(id!==projectId)return client.readProjectSession(id);
          try{return await withProbeTimeout(()=>client.readProjectSession(id),sessionProbeMs);}
          catch(error){
            if(error!==IPC_PROBE_TIMEOUT_Symbol)throw error;
            return WebProjectSessionResultSchema.parse({
              ok:true,
              value:{
                apiVersion:1,
                projectId,
                sessionId:hostSessionId,
                state:'unavailable',
                pendingIntakes:[],
                blockers:[{code:'host_unavailable',message:'Start the session explicitly to connect.'}],
                updatedAt:new Date().toISOString()
              }
            });
          }
        },
        async execute(input){
          let command;
          try {command=WebCommandSchema.parse(input);if(command.projectId!==projectId)throw new Error();}
          catch {return {ok:false,error:{code:'validation',retryable:false,message:'Foreign or invalid web command.'}};}
          try{return WebOperationResponseSchema.parse(await (await acquireAuthenticated(true)).execute(command));}
          catch{return unavailable();}
        },
        async readOperation(id,operationId){
          if(id!==projectId)return unavailable();
          try{
            const first=WebOperationResponseSchema.parse(await (await acquireAuthenticated(false)).readOperation(id,operationId));
            if(!first.ok && first.error.code==='transport_unavailable'){
              return WebOperationResponseSchema.parse(await (await acquireAuthenticated(false,true)).readOperation(id,operationId));
            }
            return first;
          }catch{return unavailable();}
        },
        async acknowledgeNotice(id,noticeId){
          if(id!==projectId)return {ok:false,error:{code:'validation',retryable:false,message:'Foreign notice project scope.'}};
          try{
            const first=WebNoticeDisplayedResultSchema.parse(await (await acquireAuthenticated(false)).acknowledgeNotice(id,noticeId));
            if(!first.ok && first.error.code==='transport_unavailable'){
              return WebNoticeDisplayedResultSchema.parse(await (await acquireAuthenticated(false,true)).acknowledgeNotice(id,noticeId));
            }
            return first;
          }catch{return transportUnavailable('Host interaction unavailable; notice acknowledgement was not confirmed.');}
        },
        async listMessages(id,conversationSessionId,cursor){
          if(id!==projectId)return {ok:false,error:{code:'validation',retryable:false,message:'Foreign chat project scope.'}};
          const normalize=(raw:unknown):Awaited<ReturnType<UserInteractionClient['listMessages']>>=>{
            const parsed=WebChatPageResultSchema.parse(raw);
            if(!parsed.ok)return parsed;
            return {ok:true,value:{apiVersion:1,items:parsed.value.items,...(parsed.value.nextCursor?{nextCursor:parsed.value.nextCursor}:{})}};
          };
          try{
            const first=normalize(await (await acquireAuthenticated(false)).listMessages(id,conversationSessionId,cursor));
            if(!first.ok && first.error.code==='validation' && first.error.details && typeof first.error.details==='object' &&
               (first.error.details as {reason?:unknown}).reason==='chat_adapter_unavailable'){
              return normalize(await (await acquireAuthenticated(false,true)).listMessages(id,conversationSessionId,cursor));
            }
            return first;
          }catch{return transportUnavailable('Host chat history is currently unavailable.');}
        },
        async sendMessage(raw){
          let parsed;
          try{parsed=WebChatSendSchema.parse(raw);if(parsed.projectId!==projectId)throw new Error();}
          catch{return {ok:false,error:{code:'validation',retryable:false,message:'Foreign or invalid web chat message.'}};}
          let authed:UserInteractionClient;
          try{authed=await acquireAuthenticated(false);}
          catch{return transportUnavailable('Host interaction unavailable; message was not sent.');}
          try{return WebChatMessageResultSchema.parse(await authed.sendMessage(parsed));}
          catch{return {ok:false,error:{code:'unknown_delivery',retryable:false,manualInterventionRequired:true,message:'Observe the original message ID; do not resend.'}};}
        },
      };
    },
    async readHistoricalOperation(input:WebOperationIndexRecord):Promise<OperationResult<WebOperation>>{
      try{
        const record=WebOperationIndexRecordSchema.parse(input);
        if(record.owner!=='host_interaction' || record.principalId!==context.principalId || !record.hostSessionId)throw new Error('Foreign operation index');
        const project=WebProjectSchema.parse(await context.resolveProject(record.projectId));
        if(project.projectId!==record.projectId)throw new Error('Foreign registered project');
        // Use the original recorded host ID even if current lifecycle configuration changed.
        // Missing/stopped host means uncertain; never redirect this lookup into a replacement.
        return WebOperationResponseSchema.parse(await (await authorizedClient(project,record.hostSessionId)).readOperation(record.projectId,record.receiptId));
      }catch{return unavailable();}
    },
  };
}
