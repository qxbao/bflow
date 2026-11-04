import { join } from "node:path";
import { DelegationRequestSchema, type WorkflowPack, type RoleMessage } from "@bflow/contracts";
import { createWorkflowExtensionHost } from "../../src/agentic/extension-host.js";
import { AnalysisWorkflowRuntime } from "../../src/analysis/workflow.js";
import { QaWorkflowRuntime } from "../../src/qa/workflow.js";
import { buildAnalysisPack } from "../../src/analysis/pack.js";
import { nativeExtensionFixture } from "./native-extension.js";

export function extensionDelegation(runId = "run-native", director = true) {
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: `delegation-${runId}`, messageId: `message-${runId}`,
    correlationId: `correlation-${runId}`, sessionId: "session-native", runId, requestedBy: director ? "director" : "conversation",
    targetRole: "coordinator", title: "Health analysis", objective: "Specify health", specificationId: `spec-${runId}`, sddLevel: "lightweight",
    acceptanceCriteria: [{ id: "AC-1", description: "Traceable health specification", category: "functional", verificationMethod: "manual_review",
      required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "normal",
    requestedAt: "2026-11-04T00:00:00.000Z", idempotencyKey: `delegation-${runId}`,
    ...(director ? { metadata: { origin: "director", nativeFamily: "analysis" } } : {}) });
}

export async function directorExtensionFixture() {
  const a = await nativeExtensionFixture("analysis"), q = await nativeExtensionFixture("qa");
  const opened = await a.open(), qaOpened = await q.open();
  if (!(opened.sdk instanceof AnalysisWorkflowRuntime) || !(qaOpened.sdk instanceof QaWorkflowRuntime)) throw new Error("Wrong SDK fixture");
  const analysis = opened.sdk, qa = qaOpened.sdk;
  let pack: WorkflowPack | undefined = buildAnalysisPack({ id: "director-analysis", version: "1" });
  const notices: RoleMessage[] = [];
  const options = { repositoryPath: a.repo, sessionId: "session-native", journalDirectory: join(a.root, "routes"),
    analysis, qa, engine: opened.engine, native: a.native, runStore: a.runStore, admissionOrigin: "director" as const,
    readPack: async () => pack, publishToConversation: async (message: RoleMessage) => { notices.push(message); } };
  const create = (extra: Partial<Parameters<typeof createWorkflowExtensionHost>[0]> = {}) => createWorkflowExtensionHost({ ...options, ...extra });
  const intake = { schemaVersion: 1 as const, requestId: "director-ba", sessionId: "session-native", title: "Health analysis",
    userStatements: [{ id: "U-1", text: "Specify health" }],
    deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary"] as const,
    acceptanceCriteria: [{ id: "AC-1", description: "Traceable health specification", required: true }],
    requiredDecisions: [{ id: "D-1", question: "Who owns health?", blocking: true }], surveyPaths: ["src"], documentRoot: "docs/ba" };
  return { a, analysis, qa, engine: opened.engine, create, notices, intake, options,
    pin: { id: pack.id, version: pack.version, digest: pack.digest }, setPack: (value: WorkflowPack | undefined) => { pack = value; } };
}
