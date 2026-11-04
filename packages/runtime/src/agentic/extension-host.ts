import { isAbsolute } from "node:path";
import { z } from "zod";
import { ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema, DelegationRequestSchema, DomainEventSchema, IdentifierSchema, JsonValueSchema,
  PaneBindingSchema, RoleMessageSchema, WorkflowRunSnapshotSchema, WorkflowPackSchema, type ApprovalDecision, type ApprovalRequest, type DelegationRequest, type JsonValue,
  type PaneBinding, type RoleMessage, type RunStore, type WorkflowEngine, type WorkflowPack } from "@bflow/contracts";
import { AnalysisWorkflowRuntime } from "../analysis/workflow.js";
import { AnalysisIntakeSchema, type AnalysisIntakeInput } from "../analysis/model.js";
import { analysisBusinessAnswers } from "../analysis/business-decision.js";
import { extensionDecisionRequest } from "../extension-decisions.js";
import { ANALYSIS_WORKFLOW_ID, resolveAnalysisPack, type AnalysisPackPin } from "../analysis/pack.js";
import { QaWorkflowRuntime } from "../qa/workflow.js";
import { QaIntakeSchema, type QaIntakeInput } from "../qa/model.js";
import { QA_WORKFLOW_ID, QA_WORKFLOW_VERSION } from "../qa/plan.js";
import { canonicalPlanDigest, resolveWorkflowPack, verifyWorkflowPackDigest } from "../planning/index.js";
import { AgenticJournal, digest, json, record } from "./journal.js";
import type { NativeExtensionIntent, NativeExtensionRolePort } from "./extension-delivery.js";
import { ExtensionProjectionSchema, extensionSdlcStatus } from "./extension-projection.js";

export type WorkflowFamily = "implementation" | "analysis" | "qa";
const PinSchema = z.object({ id: IdentifierSchema, version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const RouteSchema = z.object({ schemaVersion: z.literal(1), runId: IdentifierSchema,
  kind: z.enum(["implementation", "analysis", "qa"]), delegation: DelegationRequestSchema, pack: WorkflowPackSchema.optional(),
  decisions: z.array(z.object({ decision: ApprovalDecisionSchema, state: z.enum(["queued", "applied"]) }).strict()).default([]),
  input: JsonValueSchema.optional(), started: z.boolean().default(false), completionNotice: RoleMessageSchema.optional(),
  completionNotified: z.boolean().default(false), projection: ExtensionProjectionSchema.optional() }).strict();
type Route = z.infer<typeof RouteSchema>;
export type ExtensionStart = { kind: "analysis"; runId: string; intake: AnalysisIntakeInput; packPin: AnalysisPackPin } |
  { kind: "qa"; runId: string; intake: QaIntakeInput; packPin: AnalysisPackPin };
export interface WorkflowExtensionHost {
  admit(delegation: DelegationRequest): Promise<WorkflowFamily>;
  owns(runId: string): Promise<boolean>;
  start(input: ExtensionStart): Promise<JsonValue>;
  drive(runId: string): Promise<JsonValue>;
  inspect(runId?: string): Promise<JsonValue>;
  recover(): Promise<JsonValue>;
  quiesce(): Promise<JsonValue>;
  cancel(runId: string, reason: string): Promise<JsonValue>;
  receive(message: RoleMessage): Promise<void>;
  decide(decision: ApprovalDecision): Promise<void>;
  validateDecision(decision: ApprovalDecision): Promise<void>;
  decisionRecorded(decision: ApprovalDecision): Promise<boolean>;
  authorizeNative(intent: NativeExtensionIntent, binding: PaneBinding): Promise<void>;
  pendingApprovals(): Promise<ApprovalRequest[]>;
}

/** Pack capabilities select a workflow; they never become provider permissions. */
export function workflowPackFamily(input: unknown): WorkflowFamily {
  if (input === undefined) return "implementation";
  const pack = WorkflowPackSchema.parse(input);
  if (!verifyWorkflowPackDigest(pack)) throw new Error("Workflow pack digest mismatch");
  const id = pack.defaults["workflow.id"];
  if (id === undefined) return "implementation";
  if (id === ANALYSIS_WORKFLOW_ID) { resolveAnalysisPack(pack, pack); return "analysis"; }
  if (id === QA_WORKFLOW_ID) {
    if (!pack.lockedFields.includes("workflow.id")) throw new Error("QA workflow family identity must be locked");
    if (pack.defaults["workflow.version"] !== QA_WORKFLOW_VERSION || !pack.lockedFields.includes("capabilities.required") ||
        !Array.isArray(pack.defaults["capabilities.required"]) || !pack.defaults["capabilities.required"].includes("workflow.qa_only"))
      throw new Error("Unsupported QA workflow policy/version");
    const resolution = resolveWorkflowPack({ pack });
    if (resolution.blockers.length) throw new Error("QA workflow pack is blocked");
    return "qa";
  }
  return "implementation";
}

export async function createWorkflowExtensionHost(options: {
  repositoryPath: string; sessionId: string; journalDirectory: string;
  analysis: AnalysisWorkflowRuntime; qa: QaWorkflowRuntime; native: NativeExtensionRolePort; runStore: RunStore; engine: WorkflowEngine;
  isLegacyImplementationRun?(runId: string): Promise<boolean>;
  readPack(): Promise<WorkflowPack | undefined>;
  publishToConversation(message: RoleMessage): Promise<void>;
}): Promise<WorkflowExtensionHost> {
  if (!isAbsolute(options.repositoryPath) || !isAbsolute(options.journalDirectory)) throw new Error("Extension host paths must be absolute");
  const journal = new AgenticJournal(options.journalDirectory, options.repositoryPath);
  let quiesced = false;
  const routes = () => journal.exclusive(async state => state.inbox.filter(item => item.status === "applied" &&
    record(item.message.payload).kind === "extension.route").map(item => RouteSchema.parse(record(item.message.payload).route)));
  const route = async (runId: string) => {
    const found = (await routes()).find(item => item.runId === runId);
    if (!found) throw new Error("Extension run has no admitted Conversation delegation"); return found;
  };
  const saveRoute = async (entry: Route) => journal.exclusive(async (state, save) => {
    const id = `extension-route-${digest(entry.runId)}`;
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: entry.delegation.correlationId,
      run_id: entry.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
      payload: { kind: "extension.route", route: json(RouteSchema.parse(entry)) }, artifact_references: [], idempotency_key: id });
    const existing = state.inbox.find(item => item.message.message_id === id);
    if (existing) {
      const prior = RouteSchema.parse(record(existing.message.payload).route);
      if (prior.kind !== entry.kind || digest(prior.delegation) !== digest(entry.delegation) || digest(prior.pack) !== digest(entry.pack) ||
          prior.input && entry.input && digest(prior.input) !== digest(entry.input)) throw new Error("Conflicting frozen extension admission");
      const decisions = [...prior.decisions];
      for (const incoming of entry.decisions) {
        const previous = decisions.find(item => item.decision.approvalId === incoming.decision.approvalId);
        if (previous && digest(previous.decision) !== digest(incoming.decision)) throw new Error("Conflicting queued human decision");
        if (!previous) decisions.push(incoming); else if (incoming.state === "applied") previous.state = "applied";
      }
      if (prior.completionNotice && entry.completionNotice && digest(prior.completionNotice) !== digest(entry.completionNotice))
        throw new Error("Conflicting extension completion notice");
      message.payload = json({ kind: "extension.route", route: { ...entry, decisions, started: prior.started || entry.started,
        completionNotified: prior.completionNotified || entry.completionNotified,
        ...(prior.completionNotice ? { completionNotice: prior.completionNotice } : {}),
        ...(prior.projection && (!entry.projection || prior.projection.coreVersion > entry.projection.coreVersion) ? { projection: prior.projection } : {}),
        ...(prior.input ? { input: prior.input } : {}) } });
      existing.message = RoleMessageSchema.parse(message);
    } else state.inbox.push({ message, status: "applied" });
    await save();
  });
  const runtime = (entry: Route) => {
    if (entry.kind === "implementation") throw new Error("Implementation run belongs to the existing Developer workflow");
    return entry.kind === "analysis" ? options.analysis : options.qa;
  };
  const assertActive = () => { if (quiesced) throw new Error("Extension host is quiesced"); };
  const currentPack = async (entry: Route) => {
    const pack = await options.readPack();
    if (!pack || !entry.pack || digest(WorkflowPackSchema.parse(pack)) !== digest(entry.pack)) throw new Error("Frozen extension pack/pin drift");
    if (workflowPackFamily(pack) !== entry.kind) throw new Error("Workflow family drift"); return pack;
  };
  const pending = async (entry: Route): Promise<ApprovalRequest[]> => {
    if (!entry.started) return [];
    if (["cancelling", "cancelled"].includes(runtime(entry).status(entry.runId).status)) return [];
    const requests = new Map<string, ApprovalRequest>(); let cursor: string | undefined;
    do {
      const page = await options.runStore.readEvents(entry.runId, { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error("Cannot read authoritative extension approval history");
      for (const input of page.value.items) {
        const event = DomainEventSchema.parse(input);
        if (event.type === "approval.requested") {
          const request = ApprovalRequestSchema.parse(event.payload); requests.set(request.approvalId, request);
        } else if (event.type === "approval.decided") requests.delete(ApprovalDecisionSchema.parse(event.payload).approvalId);
      }
      cursor = page.value.nextCursor;
    } while (cursor);
    return [...requests.values()].filter(request => request.sessionId === options.sessionId);
  };
  const inspect = async (runId?: string): Promise<JsonValue> => {
    if (!runId) return json({ schemaVersion: 1, runs: await Promise.all((await routes()).filter(item => item.kind !== "implementation").map(item => inspect(item.runId))) });
    const entry = await route(runId);
    const state = entry.started ? runtime(entry).status(runId) : undefined;
    const status = state?.status;
    const sdlc = extensionSdlcStatus(status, entry.kind === "analysis" ? "analysis" : "qa");
    return json({ runId, kind: entry.kind, pack: entry.pack ? { id: entry.pack.id, version: entry.pack.version, digest: entry.pack.digest } : undefined,
      delegation: entry.delegation, status: sdlc, extensionStatus: status ?? "admitted", coreCreated: entry.started,
      cancelled: status === "cancelled" || status === "cancelling",
      queuedDecisions: entry.decisions.filter(item => item.state === "queued").map(item => item.decision.approvalId),
      outputType: entry.kind === "analysis" ? "analysis_document" : "qa_report", ...(state ? { extension: state } : {}),
      approval: (await pending(entry))[0] });
  };
  const saveProjection = async (entry: Route) => {
    if (!entry.started || entry.kind === "implementation") return;
    const state = runtime(entry).status(entry.runId), snapshot = await options.engine.getSnapshot(entry.runId);
    if (!snapshot.ok || !snapshot.value) throw new Error("Extension Core read projection is unavailable");
    const core = WorkflowRunSnapshotSchema.parse(snapshot.value);
    entry.projection = ExtensionProjectionSchema.parse({ schemaVersion: 1, runId: entry.runId,
      sessionId: entry.delegation.sessionId, delegationDigest: digest(entry.delegation), kind: entry.kind,
      status: extensionSdlcStatus(state.status, entry.kind), cancelled: state.status === "cancelled" || state.status === "cancelling",
      coreVersion: core.version, definition: state.definition, approvals: await pending(entry) });
    await saveRoute(entry);
  };
  const publish = async (entry: Route) => {
    for (const request of await pending(entry)) {
      const id = `extension-approval-${digest(request)}`;
      await options.publishToConversation(RoleMessageSchema.parse({ schema_version: 2, message_id: id,
        correlation_id: entry.delegation.correlationId, run_id: entry.runId, sender: { role: "runtime" }, recipient: { role: "conversation" },
        type: "approval.request", payload: json(request), artifact_references: request.evidence, occurred_at: request.requestedAt, idempotency_key: id }));
    }
    if (!entry.started || entry.completionNotified) return;
    const state = runtime(entry).status(entry.runId);
    if (state.status !== "published" && state.status !== "reported") return;
    if (!entry.completionNotice) {
      const artifact = ArtifactReferenceSchema.parse("handoff" in state ? state.handoff?.artifact : state.report?.artifact);
      if (artifact.runId !== entry.runId) throw new Error("Extension output artifact belongs to another run");
      const snapshot = await options.engine.getSnapshot(entry.runId);
      if (!snapshot.ok || !snapshot.value) throw new Error("Extension completion needs its authoritative successful Core run");
      const core = WorkflowRunSnapshotSchema.parse(snapshot.value);
      if (core.status !== "succeeded" || core.runId !== entry.runId) throw new Error("Extension completion needs its authoritative successful Core run");
      const id = `extension-completed-${digest([entry.runId, artifact.checksum])}`;
      entry.completionNotice = RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: entry.delegation.correlationId,
        run_id: entry.runId, sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
        payload: { kind: "extension_completed", sdlcStatus: "completed", outputType: entry.kind === "analysis" ? "analysis_document" : "qa_report",
          headline: entry.kind === "analysis" ? "Tài liệu phân tích đã được duyệt và xuất." : "Báo cáo QA đã sẵn sàng.",
          ...(entry.kind === "analysis" ? { productAcceptance: "not_established" } : { productChange: "not_authorized" }) },
        artifact_references: [artifact], occurred_at: core.updatedAt, idempotency_key: id });
      await saveRoute(entry); // Replay the exact same envelope if delivery succeeds but its acknowledgement is lost.
    }
    await options.publishToConversation(entry.completionNotice);
    entry.completionNotified = true; await saveRoute(entry);
  };
  const host: WorkflowExtensionHost = {
    async admit(input) {
      assertActive(); const delegation = DelegationRequestSchema.parse(input);
      if (delegation.sessionId !== options.sessionId || delegation.requestedBy !== "conversation" || delegation.targetRole !== "coordinator" || !delegation.runId)
        throw new Error("Extension admission requires its actual Conversation delegation");
      const prior = (await routes()).find(item => item.runId === delegation.runId);
      if (prior) { if (prior.kind === "implementation") return "implementation"; if (digest(prior.delegation) !== digest(delegation)) throw new Error("Conflicting frozen delegation"); return prior.kind; }
      const legacy = await options.isLegacyImplementationRun?.(delegation.runId) ?? false;
      const inputPack = legacy ? undefined : await options.readPack(), pack = inputPack === undefined ? undefined : WorkflowPackSchema.parse(inputPack);
      const kind = workflowPackFamily(pack);
      await saveRoute({ schemaVersion: 1, runId: delegation.runId, kind, delegation, ...(pack ? { pack } : {}), started: false, decisions: [], completionNotified: false }); return kind;
    },
    async owns(runId) { return (await routes()).some(item => item.runId === runId && item.kind !== "implementation"); },
    async start(input) {
      assertActive(); z.enum(["analysis", "qa"]).parse(input.kind);
      const entry = await route(IdentifierSchema.parse(input.runId));
      if (input.kind !== entry.kind) throw new Error("Extension kind/family does not match admitted intake");
      const pack = await currentPack(entry), pin = PinSchema.parse(input.packPin);
      if (pin.id !== pack.id || pin.version !== pack.version || pin.digest !== pack.digest) throw new Error("Extension start pin mismatch");
      const intake = input.kind === "analysis" ? AnalysisIntakeSchema.parse(input.intake) : QaIntakeSchema.parse(input.intake);
      if (intake.sessionId !== entry.delegation.sessionId) throw new Error("Extension intake belongs to another session");
      const normalized = json({ kind: input.kind, intake, packPin: pin });
      if (entry.input && digest(entry.input) !== digest(normalized)) throw new Error("Conflicting immutable extension intake");
      let existing: ReturnType<AnalysisWorkflowRuntime["status"]> | ReturnType<QaWorkflowRuntime["status"]> | undefined;
      try { existing = runtime(entry).status(entry.runId); } catch { /* absent SDK run */ }
      if (existing && (!entry.input || existing.executionMode !== "native" || existing.intakeDigest !== canonicalPlanDigest(intake)))
        throw new Error("Existing SDK history does not belong to this frozen host intake");
      entry.input = normalized; await saveRoute(entry);
      if (!entry.started) {
        // SDK.start persists before Core creation; a restart adopts only the exact journaled host intent.
        const exists = existing !== undefined;
        if (!exists) {
          if (input.kind === "analysis") await options.analysis.start({ runId: entry.runId, intake: AnalysisIntakeSchema.parse(intake), pack, packPin: pin });
          else await options.qa.start({ runId: entry.runId, intake: QaIntakeSchema.parse(intake) });
        }
        entry.started = true; await saveProjection(entry);
      }
      return inspect(entry.runId);
    },
    async drive(runId) { assertActive(); const entry = await route(runId); await currentPack(entry);
      if (!entry.started) throw new Error("Coordinator has not started the admitted extension");
      try {
      if (["cancelling", "cancelled"].includes(runtime(entry).status(runId).status)) {
        await runtime(entry).cancel(runId, "Run cancelled"); return inspect(runId);
      }
      for (const receipt of entry.decisions.filter(item => item.state === "queued")) {
        await runtime(entry).applyHumanDecision(receipt.decision);
        receipt.state = "applied"; await saveRoute(entry);
      }
      const status = runtime(entry).status(runId).status;
      if (status === "running" || status === "blocked") await runtime(entry).drive(runId);
      } finally { await saveProjection(entry); }
      await publish(entry); return inspect(runId); },
    inspect,
    async cancel(runId, reason) {
      const entry = await route(runId);
      if (!entry.started) throw new Error("Extension has not started; cancel its admitted intake instead");
      try { await runtime(entry).cancel(runId, reason); }
      finally { await saveProjection(entry); }
      return inspect(runId);
    },
    async recover() { assertActive(); const results: JsonValue[] = [];
      for (const entry of (await routes()).filter(item => item.kind !== "implementation" && item.started)) results.push(await host.drive(entry.runId));
      return json(results); },
    async quiesce() {
      const state = await options.native.snapshot();
      if (state.outbound.some(out => ["sending", "unknown_delivery", "accepted"].includes(out.status) || out.status === "queued" && out.lease))
        throw new Error("Native extension delivery is unsettled; reconcile or cancel it before shutdown");
      quiesced = true; return json({ quiesced: true });
    },
    async receive(input) { const message = RoleMessageSchema.parse(input);
      if (!message.run_id || !await host.owns(message.run_id)) throw new Error("Native output has no admitted extension run");
      await options.native.receive(message); },
    async decide(input) { assertActive(); const decision = ApprovalDecisionSchema.parse(input), entry = await route(decision.runId);
      await currentPack(entry);
      const previous = entry.decisions.find(item => item.decision.approvalId === decision.approvalId);
      if (previous) { if (digest(previous.decision) !== digest(decision)) throw new Error("Conflicting queued human decision"); return; }
      await host.validateDecision(decision);
      entry.decisions.push({ decision, state: "queued" }); await saveRoute(entry); },
    async validateDecision(input) {
      assertActive(); const decision = ApprovalDecisionSchema.parse(input), entry = await route(decision.runId);
      await currentPack(entry);
      const request = (await pending(entry)).find(item => item.approvalId === decision.approvalId);
      if (!request || request.sessionId !== decision.sessionId || request.revision !== decision.revision || request.generation !== decision.generation ||
          digest(request.target) !== digest(decision.target) || request.metadata?.approvalScope !== decision.metadata?.approvalScope ||
          ["documentDigest", "designDigest"].some(key => request.metadata?.[key] !== decision.metadata?.[key]))
        throw new Error("Human receipt does not match the current extension approval");
      const scope = z.string().min(1).parse(request.metadata?.approvalScope);
      await extensionDecisionRequest(options.runStore, decision, scope, new Date().toISOString());
      if (entry.kind === "analysis" && scope === "business_decisions") {
        const state = options.analysis.status(entry.runId);
        analysisBusinessAnswers(decision, state.questions, state.decisions);
      }
    },
    async decisionRecorded(input) {
      const decision = ApprovalDecisionSchema.parse(input), entry = await route(decision.runId);
      const prior = entry.decisions.find(item => item.decision.approvalId === decision.approvalId);
      if (prior && digest(prior.decision) !== digest(decision)) throw new Error("Conflicting extension human receipt");
      return prior !== undefined;
    },
    async authorizeNative(intent, bindingInput) {
      const entry = await route(intent.runId), binding = PaneBindingSchema.parse(bindingInput);
      await currentPack(entry);
      if (!entry.started || intent.family !== entry.kind || !entry.input || !binding.readOnlyWorkspace || binding.role === "developer")
        throw new Error("Native assignment has no active extension scope");
      const current = await options.engine.getSnapshot(entry.runId);
      if (!current.ok || !current.value) throw new Error("Native extension authoritative Core snapshot is unavailable");
      const snapshot = WorkflowRunSnapshotSchema.parse(current.value);
      const task = snapshot.tasks.find(item => item.taskId === intent.taskId);
      const sdk = runtime(entry).status(entry.runId);
      const definition = sdk.definition.tasks.find(item => item.id === intent.taskId);
      if (sdk.executionMode !== "native" || ["succeeded", "failed", "cancelled", "cancelling"].includes(snapshot.status) ||
          !task || task.status !== "running" || task.attemptId !== intent.attemptId || !definition || definition.role !== binding.role ||
          intent.outputKind !== `${entry.kind}.${intent.taskId}` || intent.message.recipient.role !== binding.role)
        throw new Error("Native assignment role/attempt scope is stale");
      const intakeInput = record(entry.input).intake;
      const read = entry.kind === "analysis" ? AnalysisIntakeSchema.parse(intakeInput).surveyPaths : [];
      if (entry.kind === "qa") QaIntakeSchema.parse(intakeInput);
      const assignment = record(intent.message.payload), permissions = record(assignment.permissions);
      if (assignment.runId !== entry.runId || assignment.taskId !== intent.taskId || assignment.attemptId !== intent.attemptId ||
          assignment.role !== binding.role || digest(intent.allowedReadPaths) !== digest(read) || digest(permissions.read) !== digest(read) ||
          permissions.write !== "none" || permissions.commands !== "none" || entry.kind === "qa" && permissions.network !== "none")
        throw new Error("Native assignment permission/read scope differs from the accepted intake");
    },
    async pendingApprovals() { return (await Promise.all((await routes()).filter(item => item.kind !== "implementation").map(pending))).flat(); }
  };
  return host;
}
