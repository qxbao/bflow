import { MetadataSchema, TestStrategySchema, VerificationResultSchema } from "@bflow/contracts";
import type { TestStrategy, VerificationResult } from "@bflow/contracts";
import { z } from "zod";
import { behavioralMethods } from "./policy.js";
import { canonical, TestStrategyResolver } from "./resolver.js";
import { EvidenceDetailsSchema, PolicySnapshotSchema } from "./schema.js";

const resolver = new TestStrategyResolver();
const ResultsSchema = z.array(VerificationResultSchema);

function validateSequence(strategy: TestStrategy, records: VerificationResult[]) {
  const policy = PolicySnapshotSchema.parse(strategy.metadata?.conditionalTdd);
  const required = strategy.tddDecision.mode === "required";
  const criteria = policy.acceptanceCriteria.filter(c => c.required);
  const allCriterionIds = new Set(policy.acceptanceCriteria.map(c => c.id));
  const ids = new Set<string>();
  const attempts = new Set<string>();
  const artifactIds = new Set<string>();
  let previous: VerificationResult | undefined;
  let redDetails: z.infer<typeof EvidenceDetailsSchema> | undefined;
  for (const [index, record] of records.entries()) {
    const details = EvidenceDetailsSchema.parse(record.metadata?.conditionalTdd);
    if (ids.has(record.verificationId)) throw new Error("Duplicate evidence receipt ID");
    ids.add(record.verificationId);
    if (attempts.has(record.attemptId)) throw new Error("Each evidence phase requires a distinct execution attempt");
    attempts.add(record.attemptId);
    for (const artifact of record.evidenceArtifacts) {
      if (artifactIds.has(artifact.artifactId)) throw new Error("Each evidence phase requires distinct stored artifacts");
      artifactIds.add(artifact.artifactId);
    }
    if (record.runId !== strategy.tddDecision.runId || record.taskId !== strategy.tddDecision.taskId ||
        details.specId !== strategy.specId || details.decisionId !== strategy.tddDecision.decisionId) {
      throw new Error("Evidence must match run, task, specification and decision");
    }
    if (Date.parse(record.startedAt) < Date.parse(strategy.createdAt) ||
        (previous && Date.parse(record.startedAt) < Date.parse(previous.completedAt))) {
      throw new Error("Evidence phase times must follow the decision and previous phase");
    }
    if (record.evidenceArtifacts.some(a => a.taskId !== record.taskId || Date.parse(a.createdAt) < Date.parse(record.startedAt))) {
      throw new Error("Evidence artifacts must belong to this task and observation");
    }
    const phase = required ? ["red", "green", "refactor"][index] : "verification";
    if (details.phase !== phase) throw new Error(`Expected ${phase ?? "no further"} evidence phase`);
    const isRed = details.phase === "red";
    if (isRed ? record.status !== "failed" || details.failureKind !== "target_behavior" : record.status !== "passed" || details.failureKind !== undefined) {
      throw new Error("Red must fail for target behavior; all later phases must pass");
    }
    const evaluatedIds = record.evaluatedCriteria.map(c => c.criterionId);
    if (new Set(evaluatedIds).size !== evaluatedIds.length || evaluatedIds.some(id => !allCriterionIds.has(id))) {
      throw new Error("Evidence has unknown or duplicate acceptance criteria");
    }
    const observedMethods = new Set<string>();
    const observedCriteria = new Set<string>();
    for (const observation of details.observations) {
      const evaluated = record.evaluatedCriteria.find(c => c.criterionId === observation.criterionId && c.evidenceArtifactId === observation.evidenceArtifactId);
      if (!evaluated || !policy.requiredVerificationMethods.includes(observation.method)) throw new Error("Unmapped evidence observation or method");
      const manual = observation.method === "manual_review" || observation.method === "visual_review";
      if (!manual) {
        if (!observation.command || !policy.assessment.infrastructure.commands.some(c => c.method === observation.method && c.command === observation.command) ||
            observation.exitCode === undefined || (isRed ? observation.exitCode === 0 : observation.exitCode !== 0)) {
          throw new Error("Automated evidence requires the configured method command and appropriate exit code");
        }
        if ((evaluated.command !== undefined && evaluated.command !== observation.command) ||
            (evaluated.exitCode !== undefined && evaluated.exitCode !== observation.exitCode) ||
            (isRed && evaluated.exitCode === undefined) || evaluated.passed === isRed) {
          throw new Error("Observation must agree with the evaluated criterion command and exit code");
        }
      } else if (isRed || !evaluated.passed) throw new Error("Manual review cannot establish a Red phase");
      observedMethods.add(observation.method);
      observedCriteria.add(observation.criterionId);
    }
    if (isRed) {
      if (!details.observations.some(o => behavioralMethods.includes(o.method))) throw new Error("Red requires a behavioral test");
      const behavioralCriteria = criteria.filter(c => behavioralMethods.includes(c.verificationMethod));
      if (!details.observations.some(o => criteria.some(c => c.id === o.criterionId)) ||
          behavioralCriteria.some(c => !details.observations.some(o => o.criterionId === c.id && o.method === c.verificationMethod))) {
        throw new Error("Red must cover required behavioral acceptance criteria");
      }
      const names = strategy.criterionMappings.filter(m => observedCriteria.has(m.criterionId)).flatMap(m => m.testNames);
      if (!names.every(name => details.testNames.includes(name))) throw new Error("Red tests must derive from the mapped spec criteria");
      redDetails = details;
    } else {
      if (criteria.some(c => !observedCriteria.has(c.id) || !details.observations.some(o => o.criterionId === c.id && o.method === c.verificationMethod)) ||
          policy.requiredVerificationMethods.some(m => !observedMethods.has(m))) {
        throw new Error("Successful evidence must cover every required criterion and verification method");
      }
      if (redDetails) {
        if (details.testRevision !== redDetails.testRevision || canonical([...details.testNames].sort()) !== canonical([...redDetails.testNames].sort()) ||
            details.sourceRevision === redDetails.sourceRevision) throw new Error("Green/refactor must preserve Red tests on the implementation revision");
        for (const observation of redDetails.observations) {
          if (!details.observations.some(o => o.method === observation.method && o.criterionId === observation.criterionId && o.command === observation.command)) {
            throw new Error("Green/refactor must rerun each Red test command and criterion");
          }
        }
      }
    }
    previous = record;
  }
}

function parse(input: unknown) {
  const strategy = resolver.validate(input);
  const records = ResultsSchema.parse(strategy.metadata?.tddEvidence ?? []);
  validateSequence(strategy, records);
  return { strategy, records };
}

/** Returns a new contract value; caller persists it through its existing RunStore/ArtifactStore flow. */
export function recordEvidence(strategyInput: unknown, resultInput: unknown): TestStrategy {
  const { strategy, records } = parse(strategyInput);
  const result = VerificationResultSchema.parse(resultInput);
  const existing = records.find(r => r.verificationId === result.verificationId);
  if (existing) {
    if (canonical(existing) !== canonical(result)) throw new Error("Conflicting evidence receipt ID");
    return strategy;
  }
  const next = [...records, result];
  validateSequence(strategy, next);
  return TestStrategySchema.parse({ ...strategy, metadata: MetadataSchema.parse({ ...strategy.metadata, tddEvidence: next }) });
}

export function assertReadyToImplement(input: unknown): void {
  const { strategy, records } = parse(input);
  if (strategy.tddDecision.mode === "required" && !records.length) throw new Error("Red evidence is required before implementation");
}

export function assertEvidenceComplete(input: unknown): void {
  const { strategy, records } = parse(input);
  const count = strategy.tddDecision.mode === "required" ? 3 : 1;
  if (records.length < count) throw new Error("Required verification evidence is incomplete");
}
