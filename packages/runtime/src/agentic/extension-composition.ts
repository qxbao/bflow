import { join } from "node:path";
import type { ApprovalDecision, ArtifactStore, RoleMessage, RunStore, WorkflowEngine, WorkflowPack } from "@bflow/contracts";
import { AnalysisWorkflowRuntime, type AnalysisAssignment } from "../analysis/workflow.js";
import { QaWorkflowRuntime, type QaAssignment, type QaRuntimePorts } from "../qa/workflow.js";
import { extensionIntent } from "../extension-execution.js";
import { createWorkflowExtensionHost } from "./extension-host.js";
import type { NativeExtensionRolePort } from "./extension-delivery.js";

/** Existing SDK compatibility methods remain functional, but composed SDKs always select their native lifecycle. */
function roleAdapter(family: "analysis" | "qa", sessionId: string, native: NativeExtensionRolePort, now: () => string) {
  return {
    native,
    async dispatch(assignment: AnalysisAssignment | QaAssignment) {
      const request = await native.prepare(extensionIntent(family, sessionId, assignment, assignment, now()));
      await native.dispatch(request);
      const result = await native.waitResult(request.requestId);
      if (!result.sender.agent_id) throw new Error("Native extension output lost its authenticated actor");
      return { agentId: result.sender.agent_id, output: result.output };
    },
    async reconcile(executionId: string) {
      const snapshot = await native.snapshot();
      const out = snapshot.outbound.find(item => item.handle?.executionId === executionId || item.message.message_id === `${family}-native-${executionId}`);
      if (!out?.request) return { status: "unknown" as const };
      const result = await native.reconcile(out.request.requestId);
      if (result.status === "not_delivered") return { status: "not_delivered" as const };
      if (result.status !== "completed") return { status: "unknown" as const };
      if (!result.outcome.sender.agent_id) throw new Error("Reconciled native extension lost its actor");
      return { status: "completed" as const, agentId: result.outcome.sender.agent_id, output: result.outcome.output };
    }
  };
}

/** Compose existing Core/storage/transport ports. No parallel engine, logical role binding or Developer task is introduced. */
export async function openWorkflowExtensionRuntimes(options: {
  repositoryPath: string; sessionId: string; directory: string;
  engine: WorkflowEngine; runStore: RunStore; artifactStore: ArtifactStore; native: NativeExtensionRolePort;
  authorizeHuman(decision: ApprovalDecision): boolean | Promise<boolean>;
  now(): string;
  isLegacyImplementationRun?(runId: string): Promise<boolean>;
  readPack(): Promise<WorkflowPack | undefined>;
  publishToConversation(message: RoleMessage): Promise<void>;
  qa: Pick<QaRuntimePorts, "tools" | "grants" | "leases" | "accounts" | "leaseTtlMs">;
}) {
  const shared = { engine: options.engine, runStore: options.runStore, artifactStore: options.artifactStore,
    repositoryRoot: options.repositoryPath, authorizeHuman: options.authorizeHuman, now: options.now };
  const analysis = await AnalysisWorkflowRuntime.open({ ...shared, roles: roleAdapter("analysis", options.sessionId, options.native, options.now),
    journalPath: join(options.directory, "native-analysis-v2.json") });
  const qa = await QaWorkflowRuntime.open({ ...shared, ...options.qa, roles: roleAdapter("qa", options.sessionId, options.native, options.now),
    journalPath: join(options.directory, "native-qa-v2.json") });
  const host = await createWorkflowExtensionHost({ repositoryPath: options.repositoryPath, sessionId: options.sessionId,
    journalDirectory: join(options.directory, "routes"), analysis, qa, native: options.native, runStore: options.runStore, engine: options.engine,
    ...(options.isLegacyImplementationRun ? { isLegacyImplementationRun: options.isLegacyImplementationRun } : {}),
    readPack: options.readPack, publishToConversation: options.publishToConversation });
  return { host, analysis, qa };
}
