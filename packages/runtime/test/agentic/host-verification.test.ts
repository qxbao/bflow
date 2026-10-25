import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaneBindingSchema, QualityGateContextSchema, QualityGateDefinitionSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification, DEFAULT_HOST_CHECKS } from "../../src/agentic/host-verification.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
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
    f.outbound[0]={
      ...f.outbound[0]!,
      message:{...f.outbound[0]!.message,payload:{...f.context,input:{...(f.context.input as object),sourceRevision:largeHead}}}
    };
    const first=await f.host.inspectReview(agyBinding,{messageId:"request"}) as {
      reviewId:string;
      observation:{diff:string;diffOffset:number;diffTotalChars:number;diffTruncated:boolean;nextDiffOffset:number|null};
    };
    expect(Buffer.byteLength(JSON.stringify(first),"utf8")).toBeLessThanOrEqual(8500);
    expect(first.observation.diffTotalChars).toBeGreaterThan(8500);
    expect(first.observation.diffTruncated).toBe(true);
    expect(first.observation.nextDiffOffset).toBeGreaterThan(0);
    const second=await f.host.inspectReview(agyBinding,{messageId:"request",diffOffset:first.observation.nextDiffOffset!}) as {
      reviewId:string;
      observation:{diff:string;diffOffset:number;diffTruncated:boolean;nextDiffOffset:number|null};
    };
    expect(second.reviewId).toBe(first.reviewId);
    expect(second.observation.diffOffset).toBe(first.observation.nextDiffOffset);
    expect(Buffer.byteLength(JSON.stringify(second),"utf8")).toBeLessThanOrEqual(8500);
    const completed=await f.restore().completeReview(agyBinding,{
      messageId:"request",
      reviewId:first.reviewId,
      criteria:[{criterionId:"ac-1",passed:true,summary:"Full diff verified across paginated inspect_review slices"}],
      summary:"Completed review for Agy large diff"
    });
    expect(completed.result.status).toBe("passed");
  });

  it("fails auto:static for changed files it cannot analyze instead of passing them unexamined",async()=>{
    const f=await fixture();
    const source=new TestRunnerSource([],f.repository,async()=>({status:"detected",profiles:[],notes:[]}));await source.refresh();
    const host=new HostVerification(()=>({inspect:async()=>({outbound:f.outbound})}) as unknown as AgenticWorkflowRuntime,()=>{throw new Error("no artifacts");},undefined,source);
    const gate=host.behavioralGates().find(item=>item.id==="host-static-auto-static")!;
    const definition=QualityGateDefinitionSchema.parse({id:"host-static-auto-static",name:"static",evaluator:"host-static-analysis",required:true,
      timeout:{executionTimeoutMs:30_000,onTimeout:"block"},configuration:{kind:"deterministic",method:"static_analysis",command:"auto:static",criterionIds:[],testNames:[],role:"quality_gate",levels:[]}});
    const evaluate=async(revision:string)=>{const result=await gate.evaluate({...f.context,definition,input:{...f.context.input as object,sourceRevision:revision}});
      if(!result.ok) throw new Error(result.error.message);return result.value;};
    expect((await evaluate(f.head)).status).toBe("passed");
    await writeFile(join(f.repository,"feature.ts"),"export const value: number = 1;\n");f.git("add","feature.ts");f.git("commit","-m","ts");
    const ts=await evaluate(f.git("rev-parse","HEAD"));
    expect(ts.status).toBe("failed");
    expect((ts.metadata?.verification as {summary:string}).summary).toContain("cannot analyze feature.ts");
    f.git("rm","-q","feature.ts");await writeFile(join(f.repository,"broken.js"),"const value = ;\n");f.git("add","broken.js");f.git("commit","-m","js");
    expect((await evaluate(f.git("rev-parse","HEAD"))).status).toBe("failed");
  });

  it("includes host-regression-* checks only when scope is affected, not owner-configured, and profile has no adapter",async()=>{
    const f=await fixture();
    const jsProfile={
      id:"node-tap-pnpm",
      command:"detected:node-tap",
      executable:process.execPath,
      args:["--test","--test-reporter=tap"],
      method:"unit_test" as const,
      levels:["unit" as const,"regression" as const],
      reporter:"node_tap" as const,
      timeoutMs:30_000,
      checkoutDependencyRoots:[],
      dependencySource:f.repository,
      source:"detected" as const
    };
    const adapterProfile={
      ...jsProfile,
      id:"pytest-adapter",
      command:"detected:pytest",
      adapter:{format:"node_tap" as const,projectDirectory:".",bind:()=>({args:[]})}
    };
    const source=new TestRunnerSource([],f.repository,async()=>({status:"detected",profiles:[jsProfile,adapterProfile],notes:[]}));
    await source.refresh();
    const runtime={inspect:async()=>({outbound:f.outbound})} as unknown as AgenticWorkflowRuntime;

    const affectedHost=new HostVerification(()=>runtime,()=>{throw new Error("no artifacts");},undefined,source,undefined,{
      scope:"affected",
      index:{importersOf:async()=>({status:"unavailable",code:"not_configured",detail:"not configured"})}
    });
    expect(affectedHost.behavioralChecks().map(c=>c.id)).toContain("host-regression-node-tap-pnpm");
    expect(affectedHost.behavioralChecks().map(c=>c.id)).not.toContain("host-regression-pytest-adapter");
    expect(affectedHost.behavioralGates().map(g=>g.id)).toContain("host-regression-node-tap-pnpm");
    expect(affectedHost.behavioralGates().map(g=>g.id)).not.toContain("host-regression-pytest-adapter");

    const fullHost=new HostVerification(()=>runtime,()=>{throw new Error("no artifacts");},undefined,source,undefined,{
      scope:"full",
      index:{importersOf:async()=>({status:"unavailable",code:"not_configured",detail:"not configured"})}
    });
    expect(fullHost.behavioralChecks().map(c=>c.id)).toContain("host-regression-node-tap-pnpm");
    expect(fullHost.behavioralChecks().map(c=>c.id)).not.toContain("host-regression-pytest-adapter");
    expect(fullHost.behavioralGates().map(g=>g.id)).toContain("host-regression-node-tap-pnpm");
    expect(fullHost.behavioralGates().map(g=>g.id)).not.toContain("host-regression-pytest-adapter");

    const mappedOnlyHost=new HostVerification(()=>runtime,()=>{throw new Error("no artifacts");},undefined,source,undefined,{
      scope:"mapped_only",
      index:{importersOf:async()=>({status:"unavailable",code:"not_configured",detail:"not configured"})}
    });
    expect(mappedOnlyHost.behavioralChecks().map(c=>c.id)).not.toContain("host-regression-node-tap-pnpm");
    expect(mappedOnlyHost.behavioralGates().map(g=>g.id)).not.toContain("host-regression-node-tap-pnpm");

    const ownerSource=new TestRunnerSource([{
      id:"owner-unit",
      command:"owner:unit",
      executable:process.execPath,
      args:["--test","--test-reporter=tap"],
      method:"unit_test",
      levels:["unit"],
      testNames:["test-1"],
      testPaths:["test/unit.test.js"],
      reporter:"node_tap",
      timeoutMs:30_000
    }],f.repository,async()=>({status:"detected",profiles:[jsProfile],notes:[]}));
    const ownerHost=new HostVerification(()=>runtime,()=>{throw new Error("no artifacts");},undefined,ownerSource,undefined,{
      scope:"affected",
      index:{importersOf:async()=>({status:"unavailable",code:"not_configured",detail:"not configured"})}
    });
    expect(ownerHost.behavioralChecks().map(c=>c.id)).not.toContain("host-regression-node-tap-pnpm");
    expect(ownerHost.behavioralGates().map(g=>g.id)).not.toContain("host-regression-node-tap-pnpm");
  });

});
