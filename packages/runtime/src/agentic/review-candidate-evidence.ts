import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtifactReferenceSchema, QualityGateContextSchema, QualityGateResultSchema, TestStrategySchema, VerificationResultSchema,
  type ArtifactStore, type QualityGateResult, type VerificationResult } from "@bflow/contracts";
import { EvidenceDetailsSchema } from "@bflow/test-strategy";
import { digest, json, record } from "./journal.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const behavioral = new Set(["unit_test", "integration_test", "e2e_test"]);
const gateMeasurement = z.object({ runId:z.string(), taskId:z.string(), attemptId:z.string(), sourceRevision:z.string(), specFingerprint:z.string(),
  scope:z.literal("task"), independentExecution:z.literal(true), isolated:z.literal(true), executorId:z.literal("bflow-host-behavioral-check"),
  method:z.string(), command:z.string().min(1), exitCode:z.literal(0), testNames:z.array(z.string()),
  criteria:z.array(z.object({criterionId:z.string(),passed:z.literal(true)}).passthrough()) }).passthrough();

/** Read-only provenance view. Reuse retains the original attempt; no record here grants acceptance. */
export async function reviewCandidateEvidence(input: { context:unknown; state:unknown; store:ArtifactStore;
  authenticateEvidence:(value:VerificationResult)=>Promise<boolean>; authenticateGate:(value:QualityGateResult)=>Promise<boolean> }) {
  const context=QualityGateContextSchema.parse(input.context), details=object(context.input), config=object(context.definition.configuration);
  const run=list(object(input.state).runs).map(object).find(r=>r.runId===context.runId);
  const task=list(run?.tasks).map(object).find(t=>t.taskId===context.taskId);
  const strategy=TestStrategySchema.safeParse(object(task?.spec).strategy);
  const expectedNames=list(config.testNames).filter((n):n is string=>typeof n==="string");
  const expectedCriteria=list(config.criterionIds).filter((n):n is string=>typeof n==="string");
  const entries:unknown[]=[];let readBytes=0;let limited=false;
  const matches=(names:readonly string[], criteria:readonly string[])=>expectedNames.length>0 && expectedCriteria.length>0 &&
    expectedNames.every(n=>names.includes(n)) && expectedCriteria.every(c=>criteria.includes(c));
  async function artifactVerified(raw:unknown) {
    const parsed=ArtifactReferenceSchema.safeParse(raw);if(!parsed.success)return false;
    const ref=parsed.data;
    if(ref.runId!==context.runId || ref.taskId!==context.taskId || ref.kind!=="test-result" || ref.checksum?.algorithm!=="sha256")return false;
    try {
      const hash=createHash("sha256");let size=0;
      for await(const chunk of input.store.get(ref)){if(!chunk.ok)return false;size+=chunk.value.byteLength;readBytes+=chunk.value.byteLength;if(size>4*1024*1024 || readBytes>12*1024*1024){limited=true;return false;}hash.update(chunk.value);}
      return hash.digest("hex")===ref.checksum.value && (ref.sizeBytes===undefined || ref.sizeBytes===size);
    } catch {return false;}
  }
  if(details.scope==="task" && context.taskId && strategy.success && details.specId===strategy.data.specId) {
    for(const raw of list(strategy.data.metadata?.tddEvidence).slice(-32).reverse()) {
      const parsed=VerificationResultSchema.safeParse(raw);if(!parsed.success)continue;
      const result=parsed.data, phase=EvidenceDetailsSchema.safeParse(result.metadata?.conditionalTdd);
      if(!phase.success || !["green","refactor","verification"].includes(phase.data.phase) || result.status!=="passed" ||
        result.runId!==context.runId || result.taskId!==context.taskId || phase.data.sourceRevision!==details.sourceRevision ||
        phase.data.specId!==strategy.data.specId || phase.data.decisionId!==strategy.data.tddDecision.decisionId ||
        !matches(phase.data.testNames,result.evaluatedCriteria.filter(c=>c.passed && c.exitCode===0).map(c=>c.criterionId)) ||
        !await input.authenticateEvidence(result))continue;
      const observations=phase.data.observations.filter(o=>expectedCriteria.includes(o.criterionId) && behavioral.has(o.method) && o.exitCode===0 && o.command);
      if(!expectedCriteria.every(c=>observations.some(o=>o.criterionId===c)))continue;
      const refs=result.evidenceArtifacts.filter(ref=>observations.some(o=>o.evidenceArtifactId===ref.artifactId));
      if(!observations.every(o=>refs.some(ref=>ref.artifactId===o.evidenceArtifactId)) || !refs.length || refs.length>3)continue;
      if(!(await Promise.all(refs.map(artifactVerified))).every(Boolean))continue;
      entries.push({source:"host_policy_phase",receiptId:result.verificationId,receiptDigest:digest(result),attemptId:result.attemptId,
        sourceRevision:phase.data.sourceRevision,testRevision:phase.data.testRevision,phase:phase.data.phase,
        testNames:expectedNames,observations:observations.map(o=>({criterionId:o.criterionId,command:o.command,exitCode:o.exitCode,summary:o.summary.slice(0,256)})),
        artifacts:refs.map(ref=>({artifactId:ref.artifactId,checksum:ref.checksum}))});
      if (entries.length >= 3) {limited=true;break;}
    }
    for(const history of list(object(task?.cycle).history).slice(-3)) for(const raw of list(object(history).qualityGateResults)) {
      const parsed=QualityGateResultSchema.safeParse(raw);if(!parsed.success)continue;
      const gate=parsed.data, measured=gateMeasurement.safeParse(gate.metadata?.verification);
      if(!measured.success || !gate.gateId.startsWith("host-behavioral-") || gate.status!=="passed" || gate.runId!==context.runId || gate.taskId!==context.taskId ||
        measured.data.runId!==context.runId || measured.data.taskId!==context.taskId || measured.data.sourceRevision!==details.sourceRevision ||
        measured.data.specFingerprint!==details.specFingerprint || !behavioral.has(measured.data.method) ||
        !matches(measured.data.testNames,measured.data.criteria.map(c=>c.criterionId)) || !await input.authenticateGate(gate))continue;
      entries.push({source:"host_behavioral_gate",receiptId:gate.evaluationId,receiptDigest:digest(gate),attemptId:measured.data.attemptId,
        sourceRevision:measured.data.sourceRevision,testNames:expectedNames,command:measured.data.command,exitCode:0,criteria:expectedCriteria});
    }
  }
  return json({status:entries.length?"available":"missing",sourceRevision:details.sourceRevision,runId:context.runId,taskId:context.taskId,
    purpose:"Read-only trusted measurements at this source revision. Frozen testRevision may differ. Original attempts are retained; independent verdicts and gates remain required.",
    entries:entries.slice(-3),truncated:limited || entries.length>3});
}
