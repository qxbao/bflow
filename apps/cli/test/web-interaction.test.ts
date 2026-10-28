import { expect,it,vi } from 'vitest';
import { verify } from 'node:crypto';
import { canonicalWebJson,WebPrincipalSchema } from '@bflow/contracts/web-host';
import { WebCommandSchema } from '@bflow/contracts/web';
import { createWebInteractionServices } from '../src/web-interaction.js';
const project={apiVersion:1 as const,projectId:'project-test',canonicalPath:'/registered',displayName:'repo',registrationState:'registered' as const};
const command=WebCommandSchema.parse({apiVersion:1,commandId:crypto.randomUUID(),projectId:project.projectId,kind:'create_request',title:'A task',requestKind:'feature',objective:'Do work',acceptanceCriteria:[{description:'Works',verificationMethod:'unit_test'}],constraints:[]});
it('signs the exact command with authenticated browser context and the host-enforced local UID',async()=>{
 let material:any,proof:any;const register=vi.fn(async(_o,registration)=>{material=registration;return {credential:'c'.repeat(64),principalId:registration.principalId,socketPath:'/private'};});
 const factory=vi.fn(async(options:any)=>({execute:async(c:any)=>{proof=await options.interaction.sign(c);return {ok:false,error:{code:'validation',retryable:false,message:'test refusal'}};},readOperation:async()=>({ok:false,error:{code:'not_found',retryable:false,message:'missing'}}),listRuns:async()=>({ok:true,value:{apiVersion:1,items:[]}})}));
 const services=createWebInteractionServices({principalId:'ledger',resolveProject:async()=>project},{register:register as any,openClient:factory as any,sessionId:async()=> 'host-1'});
 const expiresAt=new Date(Date.now()+20000).toISOString();const client=await services.interaction(project.projectId,{principalId:'ledger',browserSessionId:'browser-1',expiresAt});
 expect(register).toHaveBeenCalledOnce();await client.execute(command);
 expect(WebPrincipalSchema.parse(proof)).toMatchObject({browserSessionId:'browser-1',principalId:`local-user-${process.getuid?.()??'local'}`,projectId:project.projectId,hostSessionId:'host-1',commandId:command.commandId});
 expect(Date.parse(proof.expiresAt)).toBeLessThanOrEqual(Date.parse(expiresAt));
 const {signature,...body}=proof;expect(verify(null,Buffer.from(canonicalWebJson(body)),material.publicKey,Buffer.from(signature.value,'base64'))).toBe(true);
 await client.execute(command);expect(proof.nonce).not.toBe(body.nonce);
 expect(JSON.stringify(material)).not.toContain('browser-1');
});
it('does not sign expired/foreign browser context or resolve a browser supplied repository path',async()=>{
 const register=vi.fn();const services=createWebInteractionServices({principalId:'ledger',resolveProject:async()=>project},{register:register as any,sessionId:async()=> 'host-1'});
 await expect(services.interaction(project.projectId,{principalId:'other',browserSessionId:'browser',expiresAt:new Date(Date.now()+60000).toISOString()})).rejects.toThrow();
 await expect(services.interaction(project.projectId,{principalId:'ledger',browserSessionId:'browser',expiresAt:new Date(0).toISOString()})).rejects.toThrow();expect(register).not.toHaveBeenCalled();
});
it('observes only the pinned original host session and never executes when reading an old operation',async()=>{
 const execute=vi.fn();const readOperation=vi.fn(async()=>({ok:false,error:{code:'transport_unavailable',retryable:true,message:'stopped'}}));
 const openClient=vi.fn(async()=>({execute,readOperation}));const register=vi.fn(async()=>({credential:'c'.repeat(64),principalId:`local-user-${process.getuid?.()??'local'}`,socketPath:'/private'}));
 const services=createWebInteractionServices({principalId:'ledger',resolveProject:async()=>project},{register:register as any,openClient:openClient as any,sessionId:async()=> 'replacement'});
 const id=crypto.randomUUID();await services.readHistoricalOperation({schemaVersion:1,projectId:project.projectId,principalId:'ledger',commandId:id,receiptId:id,owner:'host_interaction',operationKind:'create_request',fingerprint:'a'.repeat(64),hostSessionId:'original',createdAt:new Date().toISOString()});
 expect(openClient).toHaveBeenCalledWith(expect.objectContaining({sessionId:'original'}));expect(readOperation).toHaveBeenCalledWith(project.projectId,id);expect(execute).not.toHaveBeenCalled();
});
