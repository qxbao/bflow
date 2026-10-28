import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { IdentifierSchema, type OperationResult } from '@bflow/contracts';
import { WebCommandSchema, WebProjectSchema, WebOperationResponseSchema, type WebOperation, type UserInteractionClient, type WebProject } from '@bflow/contracts/web';
import { canonicalWebJson, webCommandFingerprint, WebPrincipalSchema, WebAuthenticatedContextSchema,
  WebOperationIndexRecordSchema, WebIssuerRegistrationSchema, WebIssuerCredentialSchema,
  type WebAuthenticatedContext, type WebOperationIndexRecord } from '@bflow/contracts/web-host';
import { openUserInteractionClient, registerUserInteractionIssuer } from '@bflow/runtime';
import { identifyRepository } from './repository.js';

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
/** Private signer closure. Only authenticated Local Server composition constructs this port. */
export function createWebInteractionServices(context: InteractionComposition, dependencies: InteractionDependencies = {}) {
  IdentifierSchema.parse(context.principalId);
  const {publicKey, privateKey}=generateKeyPairSync('ed25519');
  const issuerId=`web-${context.principalId}`,keyId=randomUUID(),principalId=`local-user-${process.getuid?.()??'local'}`;
  const register=dependencies.register??registerUserInteractionIssuer,openClient=dependencies.openClient??openUserInteractionClient;
  const session=dependencies.sessionId??(async(project:WebProject)=>(await identifyRepository(project.canonicalPath)).sessionName);
  const authorizedClient=async(project:WebProject,hostSessionId:string,browser?:WebAuthenticatedContext)=>{
    const host={repositoryPath:project.canonicalPath,sessionId:hostSessionId};
    const registration=WebIssuerRegistrationSchema.parse({issuerId,keyId,principalId,projectId:project.projectId,hostSessionId,
      publicKey:publicKey.export({type:'spki',format:'pem'})});
    // Re-registering this exact key is idempotent. A restarted host needs fresh registration,
    // which is owner IPC only and never a retry of an execute mutation.
    const registered=WebIssuerCredentialSchema.parse(await register(host,registration));
    if(registered.principalId!==principalId)throw new Error('Host principal mismatch');
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
      // Register the available channel before action projection. This never ensures a host;
      // missing hosts stay readable as unavailable through the read-only client.
      try{client=await authorizedClient(project,hostSessionId,browser);}
      catch{client=await openClient({repositoryPath:project.canonicalPath,sessionId:hostSessionId});}
      return {...client,
        async execute(input){
          let command;
          try {command=WebCommandSchema.parse(input);if(command.projectId!==projectId)throw new Error();}
          catch {return {ok:false,error:{code:'validation',retryable:false,message:'Foreign or invalid web command.'}};}
          try{return WebOperationResponseSchema.parse(await (await authorizedClient(project,hostSessionId,browser)).execute(command));}
          catch{return unavailable();}
        },
        async readOperation(id,operationId){
          if(id!==projectId)return unavailable();
          try{return WebOperationResponseSchema.parse(await (await authorizedClient(project,hostSessionId)).readOperation(id,operationId));}
          catch{return unavailable();}
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
