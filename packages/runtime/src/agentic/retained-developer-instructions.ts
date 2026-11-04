import { dirname, join } from 'node:path';
import { z } from 'zod';
import { canonicalReceiptJson, PaneBindingSchema, SkillManifestSchema, type PaneBinding } from '@bflow/contracts';
import type { SkillManager } from '@bflow/skills';
import type { AgenticHostPlatformOptions } from '../platform/host-options.js';
import { FileLaunchJournal } from '../platform/launch-journal.js';
import { RoleEnvironmentResolver, sessionTrustScope, taskIdError } from '../platform/environment.js';
import { readResolutionFile } from './execution-binding.js';
import { launchReceiptName } from './tool-reachability.js';

const recordSchema=z.object({schemaVersion:z.literal(3),manifest:SkillManifestSchema,rendered:z.unknown(),diagnostics:z.array(z.string()),roleProfile:z.never().optional()}).strict();
const startupSchema=z.object({role:z.literal('developer'),paneId:z.string(),source:z.literal('hook'),nativeSessionId:z.string(),launchId:z.string().optional()}).passthrough();

/** Recover instruction evidence only. Retired provider/Gateway launches and their tokens stay retired. */
export async function recoverRetainedDeveloperInstructions(input:{binding:PaneBinding;platform:AgenticHostPlatformOptions;repositoryPath:string;sessionId:string;
  stateDirectory:string;generationFile:string;generation:number|undefined;manager:SkillManager;proveProcess:((binding:PaneBinding)=>Promise<void>)|undefined}) {
  const binding=PaneBindingSchema.parse(input.binding), template=input.platform.roles.find(r=>r.role==='developer');
  const taskId=binding.metadata?.taskId, runId=binding.metadata?.runId, launchId=binding.metadata?.launchId, fingerprint=binding.metadata?.launchFingerprint;
  if(binding.role!=='developer'||binding.roleProfile||binding.permanent||binding.readOnlyWorkspace||binding.metadata?.allocationStatus!=='active'||
    binding.sessionId!==input.sessionId||!binding.session||binding.session.kind!=='id'||!binding.worktreePath||binding.cwd!==binding.worktreePath||
    typeof taskId!=='string'||taskIdError(taskId)||typeof runId!=='string'||!taskId.startsWith(runId+'-')||
    typeof launchId!=='string'||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)||
    !template||binding.provider!==template.provider||binding.session.source!==`herdr:${template.provider}`||!input.generation||
    !input.proveProcess||!z.string().uuid().safeParse(binding.metadata?.processScopeId).success)throw new Error('Retained Developer instruction identity cannot be proven');
  if(template.permissionMode==='unattended_isolated'||template.mcpServiceIds.length||input.platform.toolPolicy?.requirements.some(r=>r.roles.includes('developer')&&r.requiredness==='required'&&r.kind!=='cli_only'))
    throw new Error('Retained Developer requires a fresh Gateway launch; instruction recovery cannot restore tokens');
  await input.proveProcess(binding);
  const journalPath=join(input.stateDirectory,'launch-journal.jsonl');
  await readResolutionFile(journalPath,4*1024*1024); // Same no-follow/ancestor/size guards as private execution inputs.
  const entries=(await new FileLaunchJournal(journalPath).entries()).filter(e=>e.launchId===launchId);
  const intents=entries.filter(e=>e.kind==='intent');const intent=intents.at(-1);
  if(!intent||entries.at(-1)?.kind!=='released'||intents.some(e=>canonicalReceiptJson({...e,recordedAt:undefined})!==canonicalReceiptJson({...intent,recordedAt:undefined}))||
    intent.role!=='developer'||intent.provider!==binding.provider||intent.launchFingerprint!==fingerprint||intent.roleProfile||
    intent.taskId!==undefined&&intent.taskId!==taskId||intent.generation>=input.generation)throw new Error('Retained Developer has no exact retired launch proof');
  const identity={machineId:input.platform.machineId,repositoryId:input.platform.repositoryId,workspaceRoot:input.repositoryPath,sessionId:input.sessionId,generation:intent.generation,stateDirectory:input.stateDirectory};
  const environmentId=new RoleEnvironmentResolver().environmentId(identity,{role:"developer",provider:template.provider,required:false,permissionMode:template.permissionMode,cwd:binding.cwd,taskId,capabilityIds:[],mcpServiceIds:[],toolIds:[],skillSelections:[]});
  if(intent.environmentId!==environmentId)throw new Error('Retained Developer environment differs from its task');
  const startup=startupSchema.parse(JSON.parse((await readResolutionFile(join(dirname(input.generationFile),'launch-receipts',launchReceiptName('developer',binding.paneId)),128*1024)).toString('utf8')));
  if(startup.paneId!==binding.paneId||startup.nativeSessionId!==binding.session.value||startup.launchId!==undefined&&startup.launchId!==launchId)
    throw new Error('Retained Developer native startup proof differs from its binding');
  const stored=recordSchema.parse(JSON.parse((await readResolutionFile(join(input.stateDirectory,`gen-${intent.generation}`,'skills',`developer-${taskId}.json`),2*1024*1024)).toString('utf8')));
  const manifest=await input.manager.recover(stored.manifest.digest);
  if(canonicalReceiptJson(manifest)!==canonicalReceiptJson(stored.manifest)||manifest.environmentId!==environmentId||manifest.role!=='developer'||
    manifest.provider!==binding.provider||canonicalReceiptJson(manifest.scope)!==canonicalReceiptJson(sessionTrustScope(identity)))throw new Error('Retained Developer skill scope differs');
  for(const selection of template.skillSelections){const pin=manifest.bindings.find(b=>canonicalReceiptJson(b.skill)===canonicalReceiptJson(selection.skill));
    if(!pin||pin.required!==selection.required||pin.approvalReceiptId!==selection.approvalReceiptId)throw new Error('Retained Developer skill selections changed');}
  const allowed=new Set<string>();
  const include=(id:string)=>{if(allowed.has(id))return;allowed.add(id);for(const dep of manifest.skills.find(s=>s.skillId===id)?.dependencies??[])include(dep.skillId);};
  for(const selection of template.skillSelections)include(selection.skill.skillId);
  if(manifest.skills.some(skill=>!allowed.has(skill.skillId)))throw new Error('Retained Developer includes no-longer-selected skills');
  // Re-render verified bundle content; never trust saved instruction text as authority.
  const rendered=await input.manager.link(manifest);
  return {launchId,taskId,manifest,instructionText:rendered.instructionText,references:rendered.references.map(r=>({...r}))};
}
