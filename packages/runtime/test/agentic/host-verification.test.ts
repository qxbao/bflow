import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification, DEFAULT_HOST_CHECKS } from "../../src/agentic/host-verification.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(), "bflow-host-verification-"))), repository=join(root,"repo"); await mkdir(repository);
  const git=(...args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgSign=false",...args],{cwd:repository,encoding:"utf8"}).trim();
  git("init","-b","main"); git("config","user.name","Test");git("config","user.email","test@example.test");
  await writeFile(join(repository,"guide.md"),"before\n");git("add","guide.md");git("commit","-m","base"); const base=git("rev-parse","HEAD");
  await writeFile(join(repository,"guide.md"),"after\n");git("add","guide.md");git("commit","-m","change"); const head=git("rev-parse","HEAD");
  const opened=await openFilesystemArtifactStore({root:join(root,"artifacts"),storeId:"host-test"});if(!opened.ok) throw new Error(opened.error.message);
  cleanups.push(async()=>{opened.value.close();await rm(root,{recursive:true,force:true});});
  const binding=PaneBindingSchema.parse({schemaVersion:2,bindingId:"review-binding",sessionId:"session",role:"reviewer",agentId:"independent-reviewer",paneId:"pane",workspaceId:"workspace",tabId:"tab",provider:"claude",agentKind:"claude",cwd:repository,isolationMode:"dedicated_pane",readOnlyWorkspace:true,session:{source:"test",kind:"id",value:"native-review"},transportState:"idle",boundAt:new Date().toISOString()});
  const definition={...DEFAULT_HOST_CHECKS[0]!,configuration:{kind:"review",method:"manual_review",criterionIds:["ac-1"],testNames:["criterion"],role:"reviewer",levels:[]}};
  const context=QualityGateContextSchema.parse({runId:"run",taskId:"task",attemptId:"attempt",definition,artifacts:[],input:{sourceRevision:head,baseRevision:base,sourceWorktreePath:repository,specFingerprint:"a".repeat(64),scope:"task"}});
  const outbound:Record<string,any>[]=[{status:"accepted",message:{message_id:"request",type:"verification.requested",payload:context},handle:{target:{paneId:binding.paneId,agentId:binding.agentId,session:binding.session}}}];
  const runtime={inspect:async()=>({outbound})} as unknown as AgenticWorkflowRuntime;
  const restore=()=>new HostVerification(()=>runtime,()=>opened.value,new HostReceiptJournal(join(root,"receipts"),repository,"session"));
  return {repository,head,base,git,binding,context,outbound,restore,host:restore()};
}
describe("trusted host observations",()=>{
  it("captures the actual pinned diff before accepting an independent verdict and rejects altered receipts",async()=>{
    const f=await fixture();
    const observation=await f.host.inspectReview(f.binding,{messageId:"request"}) as {reviewId:string;observation:{diff:string}};
    expect(observation.observation.diff).toContain("+after");
    const completed=await f.host.completeReview(f.binding,{reviewId:observation.reviewId,criteria:[{criterionId:"ac-1",passed:true,summary:"The exact documentation change satisfies the criterion"}],summary:"Reviewed committed diff"});
    expect(await f.host.authenticateGate(completed.result)).toBe(true);
    expect(await f.host.authenticateGate({...completed.result,status:"failed"})).toBe(false);
    const restored=f.restore();
    const replay=await restored.completeReview({...f.binding,transportState:"done"},{reviewId:observation.reviewId,criteria:[{criterionId:"ac-1",passed:true,summary:"The exact documentation change satisfies the criterion"}],summary:"Reviewed committed diff"});
    expect(replay.result).toEqual(completed.result); expect(replay.artifact).toEqual(completed.artifact);
    await expect(restored.completeReview(f.binding,{reviewId:observation.reviewId,criteria:[{criterionId:"ac-1",passed:false,summary:"conflicting verdict"}],summary:"changed"})).rejects.toThrow("Conflicting completion");
    await expect(f.host.completeReview({...f.binding,bindingId:"other-pane"},{reviewId:observation.reviewId,criteria:[],summary:"forged"})).rejects.toThrow("another pane");
  });
  it("rejects changed source after observation and independently fails whitespace in the exact committed revision",async()=>{
    const f=await fixture();
    const observation=await f.host.inspectReview(f.binding,{messageId:"request"}) as {reviewId:string};
    await writeFile(join(f.repository,"guide.md"),"trailing space \n");f.git("add","guide.md");f.git("commit","-m","bad-whitespace");
    await expect(f.host.completeReview(f.binding,{reviewId:observation.reviewId,criteria:[{criterionId:"ac-1",passed:true,summary:"stale"}],summary:"stale"})).rejects.toThrow("revision changed");
    const current=f.git("rev-parse","HEAD");
    const result=await f.host.deterministicGate().evaluate({...f.context,definition:DEFAULT_HOST_CHECKS[2]!,input:{...f.context.input as object,sourceRevision:current}});
    expect(result.ok && result.value.status).toBe("failed");
    expect(result.ok && (result.value.metadata?.verification as {exitCode:number}).exitCode).not.toBe(0);
  });
  it("pins the exact native Reviewer and fences stored observations after physical replacement",async()=>{
    const f=await fixture();
    await expect(f.host.inspectReview({...f.binding,agentId:"other-agent"},{messageId:"request"})).rejects.toThrow("No verification request");
    await expect(f.host.inspectReview({...f.binding,session:{source:"test",kind:"id",value:"other-native"}},{messageId:"request"})).rejects.toThrow("No verification request");
    const observed=await f.host.inspectReview(f.binding,{messageId:"request"}) as {reviewId:string};
    f.outbound[0]!.reviewReplacement={disposition:"replaced_without_verdict_claim"};
    await expect(f.host.inspectReview(f.binding,{messageId:"request"})).rejects.toThrow("Replaced workflow review");
    await expect(f.restore().completeReview(f.binding,{reviewId:observed.reviewId,criteria:[{criterionId:"ac-1",passed:true,summary:"old observation"}],summary:"old observation"})).rejects.toThrow("Replaced workflow review");
  });

  it("guides a mistaken reviewId only to this native pane's observation for the exact assigned request",async()=>{
    const f=await fixture(), observed=await f.host.inspectReview(f.binding,{messageId:"request"}) as {reviewId:string};
    await expect(f.host.completeReview(f.binding,{messageId:"request",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.toThrow(observed.reviewId);
    await expect(f.host.completeReview({...f.binding,agentId:"foreign-agent"},{messageId:"request",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.not.toThrow(observed.reviewId);
    await expect(f.host.completeReview({...f.binding,session:{...f.binding.session!,value:"foreign-native"}},{messageId:"request",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.not.toThrow(observed.reviewId);
    await expect(f.host.completeReview(f.binding,{messageId:"another-request",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.not.toThrow(observed.reviewId);
    f.outbound.push({...f.outbound[0],message:{...f.outbound[0]!.message,message_id:"new-identical-context"}});
    await expect(f.host.completeReview(f.binding,{messageId:"new-identical-context",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.not.toThrow(observed.reviewId);
    await expect(f.restore().completeReview(f.binding,{messageId:"new-identical-context",reviewId:observed.reviewId,criteria:[],summary:"not a verdict"})).rejects.toThrow("another verification request");
    f.outbound[0]!.reviewReplacement={disposition:"replaced_without_verdict_claim"};
    await expect(f.host.completeReview(f.binding,{messageId:"request",reviewId:"mistyped-observation",criteria:[],summary:"not a verdict"})).rejects.not.toThrow(observed.reviewId);
    delete f.outbound[0]!.reviewReplacement;
    const completed=await f.host.completeReview(f.binding,{messageId:"request",reviewId:observed.reviewId,criteria:[{criterionId:"ac-1",passed:true,summary:"The exact committed change meets the criterion"}],summary:"Independent observed review"});
    expect(completed.result.status).toBe("passed");
  });

  it("bounds large Agy inspect_review payloads below the 10KB inline tool limit while preserving full observation digests",async()=>{
    const f=await fixture();
    const largeText=Array.from({length:300},(_,i)=>`export const line_${i} = "value_${i}_${"x".repeat(25)}";`).join("\n")+"\n";
    await writeFile(join(f.repository,"guide.md"),largeText);
    f.git("add","guide.md");f.git("commit","-m","large-change");
    const largeHead=f.git("rev-parse","HEAD");
    const agyBinding={...f.binding,provider:"agy" as const,agentKind:"agy" as const};
    const bigRework={
      resolutionId:"res-1",
      reworkGeneration:1,
      developerAttemptId:"dev-attempt-2",
      sourceRevision:largeHead,
      baseRevision:f.base,
      rootCauseSummary:"R".repeat(800),
      fixSummary:"F".repeat(800),
      changedFiles:["guide.md"],
      checkWorkEvidence:{receiptId:"cw-1",sourceRevision:largeHead,exitCode:0,passed:true,rawEvidenceArtifact:"artifact://test/cw-1",checkedAt:new Date().toISOString()},
      findingResolutions:Array.from({length:4},(_,i)=>({
        findingId:`finding-1-${i+1}`,
        rootCauseSummary:`Root cause ${i}: ${"C".repeat(450)}`,
        fixExplanation:`Fix explanation ${i}: ${"E".repeat(450)}`,
        changedFiles:["guide.md"],
        sourceLocations:[{path:"guide.md",startLine:1,endLine:10,symbol:"line_0",summary:"S".repeat(200)}],
        verificationSummary:`Verification ${i}: ${"V".repeat(450)}`,
        evidenceArtifacts:["artifact://test/ev-1","artifact://test/ev-2","artifact://test/ev-3","artifact://test/ev-4"],
        testRefs:["test/guide.test.ts"]
      })),
      verificationOutcome:{status:"pending_independent_re_verification"}
    };
    const bigArtifacts=Array.from({length:12},(_,i)=>({
      artifactId:`art-${i}`,
      uri:`artifact://test/art-${i}`,
      kind:"test-result" as const,
      mediaType:"application/json",
      checksum:{algorithm:"sha256" as const,digest:"b".repeat(64)},
      sizeBytes:1024,
      createdAt:new Date().toISOString(),
      createdBy:{agentId:"dev-1",role:"developer" as const,runId:"run",taskId:"task",attemptId:"attempt"},
      extraMetadata:"M".repeat(300)
    }));
    f.outbound[0]={
      ...f.outbound[0]!,
      message:{
        ...f.outbound[0]!.message,
        payload:{...f.context,artifacts:bigArtifacts,input:{...(f.context.input as object),sourceRevision:largeHead,reworkResolution:bigRework}}
      }
    };
    const first=await f.host.inspectReview(agyBinding,{messageId:"request"}) as {
      reviewId:string;
      reworkResolution?:{findingResolutions:Array<{findingId:string}>};
      observation:{diff:string;diffOffset:number;diffTotalChars:number;diffTruncated:boolean;nextDiffOffset:number|null};
    };
    expect(Buffer.byteLength(JSON.stringify(first),"utf8")).toBeLessThanOrEqual(8500);
    expect(first.reworkResolution?.findingResolutions.map(r=>r.findingId)).toEqual(["finding-1-1","finding-1-2","finding-1-3","finding-1-4"]);
    expect(first.observation.diffTruncated).toBe(true);
    expect(first.observation.nextDiffOffset).toBeGreaterThan(0);
    const second=await f.host.inspectReview(agyBinding,{messageId:"request",diffOffset:first.observation.nextDiffOffset!}) as {
      reviewId:string;
      observation:{diff:string;diffOffset:number;diffTruncated:boolean;nextDiffOffset:number|null};
    };
    expect(second.reviewId).toBe(first.reviewId);
    expect(Buffer.byteLength(JSON.stringify(second),"utf8")).toBeLessThanOrEqual(8500);
    const completed=await f.restore().completeReview(agyBinding,{
      messageId:"request",
      reviewId:first.reviewId,
      criteria:[{criterionId:"ac-1",passed:true,summary:"Full diff verified across paginated inspect_review slices"}],
      summary:"Completed review for Agy large diff"
    });
    expect(completed.result.status).toBe("passed");
  });

});
