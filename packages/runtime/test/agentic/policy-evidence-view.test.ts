import { expect, it } from "vitest";
import { policyEvidenceView } from "../../src/agentic/policy-evidence-view.js";
it("surfaces stored phase receipts and rejected outcomes without promoting status text to evidence", () => {
  const result = { verificationId: "receipt", status: "failed", independentExecution: true, metadata: { conditionalTdd: { phase: "red", sourceRevision: "abc", testRevision: "abc" } }, evidenceArtifacts: [{ artifactId: "trusted" }] };
  const run = { runId: "run", tasks: [{ taskId: "task", spec: { strategy: { metadata: { tddEvidence: [result] } } } }] };
  expect(policyEvidenceView([run], [{ message: { run_id: "run", message_id: "request", payload: { taskId: "task", phase: "red", sourceRevision: "prior" } }, phaseFailure: { summary: "invalid assertion", repairable: true }, phaseFailureEvidence: { artifactId: "rejected" } }]))
    .toEqual([{ runId: "run", taskId: "task", acceptedPolicyEvidence: [{ verificationId: "receipt", phase: "red", sourceRevision: "abc", testRevision: "abc", resultStatus: "failed", independentExecution: true, evidenceArtifacts: [{ artifactId: "trusted" }] }], rejectedPolicyOutcomes: [{ requestId: "request", phase: "red", sourceRevision: "prior", summary: "invalid assertion", repairable: true, phaseRecorded: false, evidenceArtifacts: [{ artifactId: "rejected" }] }] }]);
  expect(policyEvidenceView([{ runId: "other", tasks: [] }], [{ message: { run_id: "run", payload: {} }, phaseFailure: {} }])).toEqual([]);
});
it("ignores unrelated JSON messages and receipts with no conditional phase metadata", () => {
  expect(policyEvidenceView([{ runId: "run", tasks: [{ taskId: "task", spec: { strategy: { metadata: { tddEvidence: [{ verificationId: "manual" }] } } } }] }], [
    { message: { run_id: "run", payload: "diagnostic" } }
  ])).toEqual([{ runId: "run", taskId: "task", acceptedPolicyEvidence: [], rejectedPolicyOutcomes: [] }]);
});
