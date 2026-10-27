import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema, ArtifactReferenceSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostVerification, DEFAULT_HOST_CHECKS } from "../../src/agentic/host-verification.js";
import { availableTools } from "../../src/agentic/host.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
const source = (body: string) => `import { test, expect } from 'vitest';\ntest('response', () => { ${body} });\n`;
async function fixture(before = source("expect(result).toBe(5)"), after = source("expect(result).toBeTruthy()")) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bflow-test-integrity-'))), repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false', ...args], {cwd: repo, encoding:'utf8'}).trim();
  git('init','-b','main'); git('config','user.name','Test'); git('config','user.email','test@example.test');
  await writeFile(join(repo,'value.test.ts'), before); git('add','.');git('commit','-m','base'); const base = git('rev-parse','HEAD');
  await writeFile(join(repo,'value.test.ts'), after);git('add','.');git('commit','-m','candidate'); const head = git('rev-parse','HEAD');
  const opened = await openFilesystemArtifactStore({root: join(root,'artifacts'),storeId:'test-integrity'}); if (!opened.ok) throw Error(opened.error.message);
  cleanup.push(async () => { opened.value.close(); await rm(root,{recursive:true,force:true}); });
  const binding = PaneBindingSchema.parse({schemaVersion:2,bindingId:'review',sessionId:'session',role:'reviewer',agentId:'independent',paneId:'pane',workspaceId:'workspace',tabId:'tab',provider:'claude',agentKind:'claude',cwd:repo,isolationMode:'dedicated_pane',readOnlyWorkspace:true,session:{source:'test',kind:'id',value:'native'},transportState:'idle',boundAt:new Date().toISOString()});
  const definition = {...DEFAULT_HOST_CHECKS[0]!,configuration:{kind:'review',method:'manual_review',criterionIds:['ac'],testNames:['response'],role:'reviewer',levels:[]}};
  const context = QualityGateContextSchema.parse({runId:'run',taskId:'task',attemptId:'attempt',definition,artifacts:[],input:{sourceRevision:head,baseRevision:base,sourceWorktreePath:repo,specFingerprint:'a'.repeat(64),scope:'task'}});
  const outbound = [{status:'accepted',message:{message_id:'request',type:'verification.requested',payload:context},handle:{target:{paneId:binding.paneId,agentId:binding.agentId,session:binding.session}}}];
  const grants: Array<{findingId:string;approvalId:string;reason:string;decidedBy:string}> = [];
  const requests: unknown[] = [];
  const runView: Record<string,unknown> = {};
  const runtime = {inspect:async(runId?:string)=>runId?runView:({outbound}),testIntegrityExceptions:async()=>grants,requestTestIntegrityException:async(_binding:unknown,input:unknown)=>{requests.push(input);return {approvalId:'owner-request',status:'pending'};}} as unknown as AgenticWorkflowRuntime;
  const host = () => new HostVerification(()=>runtime,()=>opened.value,new HostReceiptJournal(join(root,'receipts'),repo,'session'));
  const reviewArgs = (reviewId:string) => ({reviewId,messageId:'request',criteria:[{criterionId:'ac',passed:true,summary:'Verified actual response behavior'}],summary:'Independent review'});
  const gateContext = () => ({...context,definition:DEFAULT_HOST_CHECKS.find(item=>item.id==='host-test-integrity')!});
  return {root,repo,git,base,head,binding,context,outbound,host,reviewArgs,gateContext,grants,requests,runView,store:opened.value,sourceEvidence:[{revision:head,path:"value.test.ts",line:2,excerpt:after.split("\n")[1]!.trim()}]};
}
describe('host test-integrity integration',()=>{
  it('registers a required task/workflow check independently of behavioral runner configuration',()=>{
    const definition = DEFAULT_HOST_CHECKS.find(item=>item.id==='host-test-integrity');
    expect(definition).toMatchObject({required:true,evaluator:'host-test-integrity'});
  });
  it('exposes exception requests only to Reviewer and validates verdict evidence in the native tool schema',()=>{
    const tools=availableTools('reviewer');
    expect(tools.map(tool=>tool.name)).toContain('request_test_integrity_exception');
    for(const role of ['developer','qa','tester','coordinator'] as const)expect(availableTools(role).map(tool=>tool.name)).not.toContain('request_test_integrity_exception');
    const review=tools.find(tool=>tool.name==='complete_review')!;
    expect((review.inputSchema as any).properties.testIntegrityVerdicts.items.required).toContain('evidence');
  });
  it('stores pinned report evidence and treats weakening as review-required, not a failed heuristic',async()=>{
    const f=await fixture(); const result=await f.host().testIntegrityGate().evaluate(f.gateContext());
    expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error.message);
    expect(result.value.status).toBe('passed');expect(result.value.findings.some(item=>item.severity==='warning')).toBe(true);
    const evidence=ArtifactReferenceSchema.parse(result.value.metadata?.evidence);
    const chunks: Uint8Array[]=[]; for await (const chunk of f.store.get(evidence)) { expect(chunk.ok).toBe(true); if(chunk.ok) chunks.push(chunk.value); }
    const stored=JSON.parse(Buffer.concat(chunks).toString("utf8"));expect(stored.testIntegrity).toMatchObject({baseRevision:f.base,candidateRevision:f.head});
    expect(result.value.metadata?.testIntegrity).toMatchObject({baseRevision:f.base,candidateRevision:f.head});
  });
  it('requires complete exact Reviewer dispositions after receipt journal restart',async()=>{
    const f=await fixture(), host=f.host(); const view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    expect(view.testIntegrityObservation.report.findings.length).toBeGreaterThan(0);
    await expect(f.host().completeReview(f.binding,f.reviewArgs(view.reviewId))).rejects.toThrow(/test.integrity.*verdict/i);
    const verdicts=view.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,evidence:f.sourceEvidence,verdict:'equivalent',reason:'The response is a boolean, verified against the accepted boolean criterion'}));
    const completed=await f.host().completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts});
    expect(completed.result.status).toBe('passed');
    await expect(f.host().completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts.map((v:any)=>({...v,reason:'Different decision after immutable receipt'}))})).rejects.toThrow(/Conflicting/);
  });
  it('accepts a legitimate platform skip only after independent evidence-backed disposition',async()=>{
    const candidate=source('expect(result).toBe(5)').replace("test('response'","test.skipIf(process.platform === 'win32')('response'");
    const f=await fixture(undefined,candidate),host=f.host(),view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    expect(view.testIntegrityObservation.report.findings.some((item:any)=>item.ruleId==='TI_TEST_DISABLED')).toBe(true);
    const verdicts=view.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,verdict:'equivalent',reason:'The predicate limits a POSIX-only fixture to supported platforms and preserves its exact oracle elsewhere',evidence:f.sourceEvidence}));
    const completed=await host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts});expect(completed.result.status).toBe('passed');
  });
  it('rejects duplicate, unknown verdict IDs and Developer attempts',async()=>{
    const f=await fixture(),host=f.host(),view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    const v={findingId:view.testIntegrityObservation.report.findings[0].id,evidence:f.sourceEvidence,verdict:'equivalent',reason:'Verified equivalent behavior in independent review'};
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:[v,v]})).rejects.toThrow(/duplicate/i);
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:[{...v,findingId:'foreign'}]})).rejects.toThrow(/exact|unknown/i);
    await expect(host.requestTestIntegrityException({...f.binding,role:'developer'},{reviewId:view.reviewId,findingId:v.findingId,reason:'Developer cannot waive a gate'})).rejects.toThrow(/reviewer/i);
  });
  it('requires exact committed source evidence anchors for every Reviewer disposition',async()=>{
    const f=await fixture(),host=f.host(),view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    const missing=view.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,verdict:'equivalent',reason:'Supposed equivalent oracle with no checkable evidence'}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:missing})).rejects.toThrow();
    const verdicts=missing.map((v:any)=>({...v,evidence:f.sourceEvidence.map(anchor=>({...anchor,revision:'f'.repeat(40)}))}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts})).rejects.toThrow(/revision/);
    const foreign=missing.map((v:any)=>({...v,evidence:f.sourceEvidence.map(anchor=>({...anchor,path:'missing.test.ts'}))}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:foreign})).rejects.toThrow(/blob|evidence/);
    const fabricated=missing.map((v:any)=>({...v,evidence:f.sourceEvidence.map(anchor=>({...anchor,excerpt:'fabricated assertion'}))}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:fabricated})).rejects.toThrow(/evidence/);
  });
  it('fails literal tautologies independently and never accepts equivalent as their disposition',async()=>{
    const f=await fixture(undefined,source('expect(1).toBe(1)')),host=f.host();
    const result=await host.testIntegrityGate().evaluate(f.gateContext()); expect(result.ok&&result.value.status).toBe('failed');
    const view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    const verdicts=view.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,evidence:f.sourceEvidence,verdict:'equivalent',reason:'Attempt to waive a proven tautology without owner'}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts})).rejects.toThrow(/proven|owner/i);
  });
  it('requests the real owner path for the exact finding and records authenticated exceptions in evidence',async()=>{
    const f=await fixture(),host=f.host(),view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    const findings=view.testIntegrityObservation.report.findings;
    await host.requestTestIntegrityException(f.binding,{reviewId:view.reviewId,findingId:findings[0].id,reason:'Temporary exception while the replacement oracle is prepared'});
    expect(f.requests[0]).toMatchObject({messageId:'request',findingId:findings[0].id,context:expect.objectContaining({runId:'run'})});
    const verdicts=findings.map((item:any)=>({findingId:item.id,evidence:f.sourceEvidence,verdict:'confirmed_violation',reason:'Owner must approve this exact temporary relaxation'}));
    const denied=await host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts});expect(denied.result.status).toBe('failed');
    // A fresh independent observation after an owner decision has a distinct submission receipt.
    const g=await fixture(),second=g.host(),observed=await second.inspectReview(g.binding,{messageId:'request'}) as any;
    g.grants.push(...observed.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,approvalId:'apr-owner',reason:'Approved narrowly for this exact candidate with replacement tracking',decidedBy:'human-owner'})));
    const accepted=await second.completeReview(g.binding,{...g.reviewArgs(observed.reviewId),testIntegrityVerdicts:observed.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,evidence:g.sourceEvidence,verdict:'confirmed_violation',reason:'Actual relaxation explicitly approved by owner'}))});
    expect(accepted.result.status).toBe('passed');expect(accepted.result.metadata?.testIntegrityExceptions).toEqual(g.grants);
  });
  it('fences a replaced Reviewer even when the stored context contains an integrity report',async()=>{
    const f=await fixture(),host=f.host(),view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    (f.outbound[0] as any).reviewReplacement={disposition:'replaced_without_verdict_claim'};
    const verdicts=view.testIntegrityObservation.report.findings.map((item:any)=>({findingId:item.id,evidence:f.sourceEvidence,verdict:'equivalent',reason:'The original oracle was confirmed equivalent independently'}));
    await expect(host.completeReview(f.binding,{...f.reviewArgs(view.reviewId),testIntegrityVerdicts:verdicts})).rejects.toThrow(/Replaced/);
  });
  it('does not mistake a file move, rename or deleted fixture for a removed test',async()=>{
    const f=await fixture(source('expect(result).toBe(5)'),source('expect(result).toEqual(5)'));
    f.git('mv','value.test.ts','renamed.test.ts');f.git('commit','-m','move');const revision=f.git('rev-parse','HEAD');
    const result=await f.host().testIntegrityGate().evaluate({...f.gateContext(),input:{...f.context.input as object,sourceRevision:revision}});
    expect(result.ok&&result.value.findings).toEqual([]);
  });
  it('permits deleted binary fixtures without parsing data as test source',async()=>{
    const f=await fixture(source('expect(result).toBe(5)'),source('expect(result).toEqual(5)'));
    await mkdir(join(f.repo,'tests','fixtures'),{recursive:true});await writeFile(join(f.repo,'tests','fixtures','logo.png'),Buffer.from([137,80,78,71,0,1,2]));
    f.git('add','.');f.git('commit','-m','fixture');const base=f.git('rev-parse','HEAD');
    f.git('rm','tests/fixtures/logo.png');f.git('commit','-m','remove data fixture');const revision=f.git('rev-parse','HEAD');
    const result=await f.host().testIntegrityGate().evaluate({...f.gateContext(),input:{...f.context.input as object,baseRevision:base,sourceRevision:revision}});
    expect(result.ok&&result.value.status).toBe('passed');expect(result.ok&&result.value.findings).toEqual([]);
  });
  it('pages large reports for every provider without hiding unresolved finding IDs',async()=>{
    const f=await fixture(source(Array.from({length:180},(_,i)=>`expect(x${i}).toBe(${i});`).join('\n')),source('runProductScenario();')),host=f.host();
    const view=await host.inspectReview(f.binding,{messageId:'request'}) as any;
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(65536);
    expect(view.testIntegrityObservation.findingTotal).toBe(180);
    expect(view.testIntegrityObservation.nextFindingOffset).toBe(20);
    const next=await host.inspectReview(f.binding,{messageId:'request',integrityOffset:20}) as any;
    expect(next.reviewId).toBe(view.reviewId);expect(next.testIntegrityObservation.findingOffset).toBe(20);
  });
  it('pages one large Agy finding while retaining the full report in ArtifactStore',async()=>{
    const f=await fixture(undefined,`import { test, expect } from 'vitest';\ntest.skip('response', () => { const padding = '${'x'.repeat(16000)}'; expect(result).toBe(5); });\n`),host=f.host();
    const binding={...f.binding,provider:'agy' as const,agentKind:'agy' as const};
    const view=await host.inspectReview(binding,{messageId:'request'}) as any;
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(8500);
    expect(view.testIntegrityObservation.evidence.uri).toMatch(/^artifact:/);
  });
  it('reruns the gate at workflow scope and blocks symbolic-link test inputs',async()=>{
    const f=await fixture(undefined,source('expect(1).toBe(1)'));
    const workflow=await f.host().testIntegrityGate().evaluate({...f.gateContext(),taskId:'workflow-verification',input:{...f.context.input as object,scope:'workflow'}});
    expect(workflow.ok&&workflow.value.status).toBe('failed');expect(workflow.ok&&(workflow.value.metadata?.verification as any).scope).toBe('workflow');
    f.git('rm','value.test.ts');await symlink('other.ts',join(f.repo,'value.test.ts'));f.git('add','.');f.git('commit','-m','symlink test');const revision=f.git('rev-parse','HEAD');
    const invalid=await f.host().testIntegrityGate().evaluate({...f.gateContext(),input:{...f.context.input as object,sourceRevision:revision}});expect(invalid.ok).toBe(false);
  });
  it('retains the initial trusted base across rework rather than laundering weakened tests into the next baseline',async()=>{
    const f=await fixture(undefined,source('expect(1).toBe(1)'));
    f.runView.baseRevision=f.base;f.runView.tasks=[{taskId:'task',worktrees:[{baseCommitHash:f.base},{baseCommitHash:f.head}]}];
    await writeFile(join(f.repo,'product.ts'),'export const repaired=true;\n');f.git('add','.');f.git('commit','-m','rework leaves weak oracle');const revision=f.git('rev-parse','HEAD');
    const result=await f.host().testIntegrityGate().evaluate({...f.gateContext(),input:{...f.context.input as object,baseRevision:f.head,sourceRevision:revision}});
    expect(result.ok&&result.value.status).toBe('failed');
    expect(result.ok&&result.value.metadata?.testIntegrity).toMatchObject({baseRevision:f.base,candidateRevision:revision});
  });
  it('reads the pinned original objects even when local replace refs try to hide the base delta',async()=>{
    const f=await fixture(undefined,source('expect(1).toBe(1)'));
    f.git('replace',f.base,f.head);
    const result=await f.host().testIntegrityGate().evaluate(f.gateContext());
    expect(result.ok&&result.value.status).toBe('failed');
    expect(result.ok&&result.value.findings.some(finding=>finding.code==='TI_LITERAL_TAUTOLOGY')).toBe(true);
  });
  it('rejects dirty, unknown and missing revisions before issuing gate evidence',async()=>{
    const f=await fixture();await writeFile(join(f.repo,'value.test.ts'),'dirty');
    const result=await f.host().testIntegrityGate().evaluate(f.gateContext());expect(result.ok).toBe(false);
  });
});
