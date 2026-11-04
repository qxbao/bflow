import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { IdentifierSchema, SessionManifestSchema, type OperationResult } from '@bflow/contracts';
import { WebChatMessageResultSchema, WebChatPageResultSchema, WebChatSendSchema, WebCommandSchema, WebNoticeDisplayedResultSchema,
  WebOperationResponseSchema, WebProjectSchema, WebProjectSessionResultSchema, WebDirectorViewSchema,
  type UserInteractionClient, type WebOperation, type WebProject } from '@bflow/contracts/web';
import { canonicalWebJson, webCommandFingerprint, WebPrincipalSchema, WebAuthenticatedContextSchema,
  WebOperationIndexRecordSchema, WebIssuerRegistrationSchema, WebIssuerCredentialSchema,
  type WebAuthenticatedContext, type WebOperationIndexRecord } from '@bflow/contracts/web-host';
import { findPrivateRuntimeStateDirectory, openLocalDirectorServices, openUserInteractionClient, registerUserInteractionIssuer,
  type LocalDirectorServices } from '@bflow/runtime';
import type { LocalWebDirectorServices, DirectorLaunchOutcome } from '@bflow/local-server';
import { identifyRepository } from './repository.js';
import { readEnvironmentConfig } from './environment-config.js';
import { readPreviewFile } from './preview-files.js';
import { DirectorLaunchError, buildDirectorLaunchPlan, inspectDirectorLaunchOptions, launchDirectorPlan,
  type DirectorLaunchDeps, type DirectorLaunchPresence } from './director-open.js';

type WebIssuerCredential = z.infer<typeof WebIssuerCredentialSchema>;

interface InteractionComposition {
  principalId: string;
  resolveProject(id: string): Promise<WebProject>;
}
interface InteractionDependencies {
  register?: typeof registerUserInteractionIssuer;
  openClient?: typeof openUserInteractionClient;
  sessionId?: (project: WebProject) => Promise<string>;
  openDirector?: typeof openLocalDirectorServices;
  director?: DirectorWebDependencies;
}
/** D-CD-01 Director Web port composition (tests inject; production uses the Task 3 launcher and the running host). */
export interface DirectorWebDependencies {
  inspect?: typeof inspectDirectorLaunchOptions;
  build?: typeof buildDirectorLaunchPlan;
  launch?: typeof launchDirectorPlan;
  deps?: DirectorLaunchDeps;
  /** Presence from the running host; read failure must be `unknown`, a stopped host `host_stopped`. */
  readPresence?: (project: WebProject, hostSessionId: string) => Promise<DirectorLaunchPresence>;
  /** Bound on the presence read (default 10 s); a late read counts as `unknown`, which requires replaceActive. */
  presenceTimeoutMs?: number;
  /** The host's activated Conversation session (manifest), undefined when unknown; checked against a Director view. */
  conversationSessionId?: (project: WebProject, hostSessionId: string) => Promise<string | undefined>;
  /** Machine paths that must never reach the browser (BFLOW_HOME, provider homes). */
  sensitivePaths?: () => string[];
}
const PRESENCE_TIMEOUT_MS = 10000;
/** Reads the activated manifest's Conversation session; any failure is "unknown" (undefined), never a mismatch. */
async function manifestConversationSessionId(project: WebProject, hostSessionId: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(project.canonicalPath, '.bflow/state/panes', `${hostSessionId}.manifest.json`), 'utf8');
    if (raw.length > 4 * 1024 * 1024) return undefined;
    const manifest = SessionManifestSchema.parse(JSON.parse(raw));
    if (manifest.sessionId !== hostSessionId || manifest.workspaceRoot !== project.canonicalPath) return undefined;
    return manifest.conversationSessionId;
  } catch { return undefined; }
}
const TOKEN_TEXT = /\b[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{32,256}\b|\b(?:sk|ghp|gho|xox[abp]|AIza)[A-Za-z0-9_-]{16,}\b/g;
/** Default machine paths kept out of Web responses: BFLOW_HOME and provider homes (never HOME itself, which may hold the repository). */
function defaultSensitivePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME;
  return [env.BFLOW_HOME, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.GEMINI_HOME, env.XDG_STATE_HOME,
    ...(home ? [join(home, '.bflow'), join(home, '.claude'), join(home, '.codex'), join(home, '.gemini')] : [])]
    .filter((path): path is string => typeof path === 'string' && path.startsWith('/') && path.length > 1);
}
/** Redacts machine paths and token shapes; `keep` (the canonical project path) survives so manual commands stay usable. */
export function redactDirectorWebText(text: string, sensitive: readonly string[], keep?: string): string {
  const scrub = (part: string) => {
    let out = part.replace(TOKEN_TEXT, '[REDACTED]');
    for (const path of [...sensitive].sort((a, b) => b.length - a.length)) out = out.split(path).join('[REDACTED]');
    return out;
  };
  return keep ? text.split(keep).map(scrub).join(keep) : scrub(text);
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

  const openDirector=dependencies.openDirector??openLocalDirectorServices;
  const directorDeps=dependencies.director??{};
  const sensitive=()=>(directorDeps.sensitivePaths??(()=>defaultSensitivePaths()))();
  const directorUnavailable=<T>(message='Host của phiên chưa chạy; Director chưa đọc/gửi được.'):OperationResult<T>=>({ok:false,error:{code:'transport_unavailable',retryable:true,message,details:{reason:'unavailable'}}});
  const directorRefused=<T>(reason:'forbidden'|'invalid_request'|'operation_not_allowed',message:string):OperationResult<T>=>({ok:false,error:{code:'validation',retryable:false,message,details:{reason}}});
  /** Validates the authenticated browser context and resolves the registered project and its host session (never a browser path). */
  const directorScope=async(projectId:string,input:WebAuthenticatedContext)=>{
    const browser=WebAuthenticatedContextSchema.parse(input);
    if(browser.principalId!==context.principalId || Date.parse(browser.expiresAt)<=Date.now())throw new Error('Invalid browser context');
    const project=WebProjectSchema.parse(await context.resolveProject(IdentifierSchema.parse(projectId)));
    if(project.projectId!==projectId)throw new Error('Foreign registered project');
    return {project,hostSessionId:IdentifierSchema.parse(await session(project))};
  };
  /** Owner reads use no credential; message methods use the registered Web credential only (never owner/Director tokens). */
  const directorService=async(project:WebProject,hostSessionId:string,withCredential:boolean):Promise<LocalDirectorServices>=>{
    const host={repositoryPath:project.canonicalPath,sessionId:hostSessionId};
    if(!withCredential)return openDirector(host);
    const registered=await withProbeTimeout(()=>resolveCredential(project,hostSessionId),COLD_REGISTER_PROBE_MS);
    return openDirector({...host,interaction:{credential:registered.credential}});
  };
  const readPresence=directorDeps.readPresence??(async(project:WebProject,hostSessionId:string):Promise<DirectorLaunchPresence>=>{
    try{
      const {EnvironmentLifecycle}=await import('./environment.js');
      const status=await new EnvironmentLifecycle(project.canonicalPath).status();
      if(status.server!=='running')return 'host_stopped';
      const view=await (await openDirector({repositoryPath:project.canonicalPath,sessionId:hostSessionId})).readDirector(project.projectId);
      return view.ok?view.value.snapshot.director.presence:'unknown';
    }catch{return 'unknown';}
  });
  const launchDeps=async():Promise<DirectorLaunchDeps>=>directorDeps.deps??{pathEntries:(await import('./gateway-repositories.js')).resolveSetupPlatform().pathEntries};
  // Startup cannot depend on the host it is meant to start. Only a positively stopped
  // host permits this offline projection; an unresponsive live host remains unknown.
  const stoppedDirectorView=async(project:WebProject,hostSessionId:string):ReturnType<LocalWebDirectorServices['readView']>=>{
    if(await readPresence(project,hostSessionId)!=='host_stopped')return directorUnavailable();
    const repository=await identifyRepository(project.canonicalPath);
    await readEnvironmentConfig(repository);
    let legacy=false;
    try{
      const manifest=SessionManifestSchema.parse(JSON.parse(await readPreviewFile(join(project.canonicalPath,'.bflow/state/session.json'),4*1024*1024)));
      if(manifest.sessionId!==hostSessionId || manifest.workspaceRoot!==project.canonicalPath)return directorUnavailable();
      legacy=manifest.schemaVersion===2 && manifest.status!=='down';
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const at=new Date().toISOString();
    return {ok:true as const,value:WebDirectorViewSchema.parse({apiVersion:1,projectId:project.projectId,
      layout:legacy?'legacy_v2':'not_started',snapshot:{schemaVersion:1,generatedAt:at,director:{presence:'absent'},
        runs:[],pendingApprovals:0,pendingQuestions:0,issues:[]},transcriptSeq:0,cliCaptureMayBeIncomplete:true,observedAt:at})};
  };
  const director:LocalWebDirectorServices={
    async readView(projectId,input){
      let scope;try{scope=await directorScope(projectId,input);}catch{return directorRefused('forbidden','Invalid Director scope.');}
      try{
        const view=await (await directorService(scope.project,scope.hostSessionId,false)).readDirector(projectId);
        // Defence in depth: a view served by another host's Conversation session is never shown as this project's Director.
        if(view.ok && view.value.sessionId!==undefined){
          const expected=await (directorDeps.conversationSessionId??manifestConversationSessionId)(scope.project,scope.hostSessionId).catch(()=>undefined);
          if(expected!==undefined && expected!==view.value.sessionId)return directorUnavailable('Director view không khớp phiên host hiện tại.');
        }
        if(!view.ok && view.error.code==='transport_unavailable')return await stoppedDirectorView(scope.project,scope.hostSessionId);
        return view;
      }catch{
        try{return await stoppedDirectorView(scope.project,scope.hostSessionId);}catch{return directorUnavailable();}
      }
    },
    async issues(projectId,cursor,input){
      let scope;try{scope=await directorScope(projectId,input);}catch{return directorRefused('forbidden','Invalid Director scope.');}
      try{return await (await directorService(scope.project,scope.hostSessionId,false)).listDirectorIssues(projectId,cursor);}catch{return directorUnavailable();}
    },
    async messages(projectId,cursor,input){
      let scope;try{scope=await directorScope(projectId,input);}catch{return directorRefused('forbidden','Invalid Director scope.');}
      let service;try{service=await directorService(scope.project,scope.hostSessionId,true);}catch{return directorUnavailable();}
      try{return await service.listDirectorMessages(projectId,cursor);}catch{return directorUnavailable();}
    },
    async send(raw,input){
      let body;try{body=WebChatSendSchema.parse(raw);}catch{return directorRefused('invalid_request','Invalid Director message.');}
      let scope;try{scope=await directorScope(body.projectId,input);}catch{return directorRefused('forbidden','Invalid Director scope.');}
      // No credential means no connection was made: the message was not written and may be sent again with the same ID.
      let service;try{service=await directorService(scope.project,scope.hostSessionId,true);}
      catch{return directorUnavailable('Host chưa sẵn sàng; tin chưa được gửi.');}
      try{return await service.sendDirectorMessage(body);}
      catch{return {ok:false,error:{code:'unknown_delivery',retryable:false,manualInterventionRequired:true,message:'Observe the transcript for this message ID before resending.',details:{reason:'reconciliation_required',messageId:body.messageId}}};}
    },
    async launchOptions(projectId,input){
      let scope;try{scope=await directorScope(projectId,input);}catch{return directorRefused('forbidden','Invalid Director scope.');}
      try{
        const canonicalPath=await realpath(scope.project.canonicalPath),paths=sensitive();
        const options=await (directorDeps.inspect??inspectDirectorLaunchOptions)({projectId,canonicalPath},await launchDeps());
        return {ok:true,value:{...options,
          terminal:options.terminal.reason===undefined?options.terminal:{...options.terminal,reason:redactDirectorWebText(options.terminal.reason,paths)},
          providers:options.providers.map(option=>({...option,manualCommand:redactDirectorWebText(option.manualCommand,paths,canonicalPath),
            ...(option.reason===undefined?{}:{reason:redactDirectorWebText(option.reason,paths)})}))}};
      }catch{return directorUnavailable('Không kiểm tra được cách mở Director cho kho này.');}
    },
    async launch(projectId,request,input):Promise<OperationResult<DirectorLaunchOutcome>>{
      // Everything before launchDirectorPlan is pre-effect: a failure there is a definitive refusal.
      // The plan (argv, cwd and the user's environment) stays in this closure: it is never returned, persisted or logged.
      const refused=(reason:string):OperationResult<DirectorLaunchOutcome>=>({ok:false,error:{code:'validation',retryable:false,message:'Director launch refused before any effect.',details:{reason}}});
      let plan,presence:DirectorLaunchPresence,canonicalPath:string,deps:DirectorLaunchDeps;
      try{
        const scope=await directorScope(projectId,input);
        canonicalPath=await realpath(scope.project.canonicalPath);deps=await launchDeps();
        plan=await (directorDeps.build??buildDirectorLaunchPlan)({projectId,canonicalPath},request.provider,deps);
        // Bounded so a slow presence read cannot push the spawn past the operation deadline (into the "uncertain" window).
        let timer:ReturnType<typeof setTimeout>|undefined;
        presence=await Promise.race([readPresence(scope.project,scope.hostSessionId).catch(():DirectorLaunchPresence=>'unknown'),
          new Promise<DirectorLaunchPresence>(resolve=>{timer=setTimeout(()=>resolve('unknown'),directorDeps.presenceTimeoutMs??PRESENCE_TIMEOUT_MS);})])
          .finally(()=>{if(timer)clearTimeout(timer);});
      }catch(error){return refused(error instanceof DirectorLaunchError?error.code:'not_started');}
      try{
        const result=await (directorDeps.launch??launchDirectorPlan)(plan,{presence,replaceActive:request.replaceActive,deps});
        return {ok:true,value:{kind:'director_launch',provider:request.provider,mode:result.mode,
          manualCommand:redactDirectorWebText(result.manualCommand,sensitive(),canonicalPath),launchedAt:result.launchedAt}};
      }catch(error){
        if(error instanceof DirectorLaunchError && error.code!=='launch_uncertain')return refused(error.code);
        return {ok:false,error:{code:'unknown_delivery',retryable:false,manualInterventionRequired:true,
          message:'Director launch outcome is uncertain; it is never retried automatically.',details:{reason:'launch_uncertain'}}};
      }
    }
  };

  return {
    director,
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
