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

});
