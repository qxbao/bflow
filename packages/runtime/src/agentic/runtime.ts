import {
  AgentBindingReceiptSchema, canonicalReceiptJson, hasAuthenticatedBindings, CreateCheckpointCommandSchema, RecoveryCheckpointSchema, WorkflowAggregateCheckpointStateSchema,
  AgentResultSchema, AgentTransportCapabilitiesSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  CancellationRequestSchema, DelegationRequestSchema, GitChangeSetSchema,
  PaneBindingSchema, QualityGateContextSchema, QualityGateResultSchema, RoleMessageSchema, SessionManifestSchema,
  SpecificationSchema, TestStrategySchema, VerificationCycleSchema, VerificationResultSchema,
  WorkflowDefinitionSchema, type AgentExecutionHandle, type ApprovalDecision,
  type ArtifactReference, type JsonValue, type RoleMessage, type QualityGate, type QualityGateResult, type Specification,
  type PaneBinding, type TaskDefinition, type AgentRole
} from "@bflow/contracts";
import { AgenticJournal, digest, json, record, strings, textField, type JournalState,
  type Outbound, type RunRecord, type SpecRecord, type TaskRecord, type UserDecisionRecord } from "./journal.js";
import { buildDecisionRequestMessage, buildUserDecisionRequest, USER_DECISION_EXPIRED_KIND, validateUserDecisionAnswer, type UserDecisionToolInput } from "./decision-routing.js";
import { captureIntegratedChange } from "./integration-change.js";
import { CoreSession } from "./core-session.js";
import { HerdrOutbox, unwrap } from "./outbox.js";
import type { AgenticRuntimePorts, Integration, VerificationPlan } from "./ports.js";

const VERIFICATION_GATE = "p19-independent-task-verification";
const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled", "escalated"];
const FINAL_TASK = "workflow-verification";

/** Durable single-writer orchestration. No LLM calls, polling artifacts, or synchronous inter-agent waits. */
export class AgenticWorkflowRuntime {
  private readonly journal: AgenticJournal;
  constructor(readonly ports: AgenticRuntimePorts, options: { journalDirectory: string; repositoryPath: string }) {
    this.journal = new AgenticJournal(options.journalDirectory, options.repositoryPath);
  }
  private quiesced = false;
  /** Stop new scheduling before lifecycle checkpointing; retain in-flight receipts and worktrees. */
  async quiesce(): Promise<void> {
    this.quiesced = true;
    await this.transaction(async (_state, _save, core) => { await core.flush(); });
  }
  async checkpoint(input: unknown) {
    const command = CreateCheckpointCommandSchema.parse(input);
    return this.transaction(async () => {
      const checkpoint = RecoveryCheckpointSchema.parse(unwrap(await this.ports.engine.createCheckpoint(command)));
      WorkflowAggregateCheckpointStateSchema.parse(checkpoint.state);
      unwrap(await this.ports.runStore.saveCheckpoint(checkpoint, command.expectedVersion));
      return checkpoint;
    });
  }
  private initialization: Promise<void> | undefined;
  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      AgentTransportCapabilitiesSchema.parse(unwrap(await this.ports.transport.initialize({
        runtimeId: `p19-${digest(this.journal.repository).slice(0, 16)}`, configuration: {}, recoveryMode: true, initializedAt: this.now()
      })));
      SessionManifestSchema.parse(unwrap(await this.ports.panes.getManifest()));
    })();
    return this.initialization;
  }
  private now(): string { return (this.ports.clock?.() ?? new Date()).toISOString(); }
  private async transaction<T>(action: (state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox) => Promise<T>): Promise<T> {
    return this.journal.exclusive(async (state, save) => {
      const core = new CoreSession(this.ports, state, save);
      await core.restore();
      const outbox = new HerdrOutbox(this.ports, state, save);
      await this.recoverPhaseFailures(state, save, outbox);
      return action(state, save, core, outbox);
    });
  }
  private run(state: JournalState, runId: string): RunRecord {
    const run = state.runs.find(item => item.runId === runId);
    if (!run) throw new Error(`Unknown delegation run ${runId}`);
    return run;
  }
  private live(run: RunRecord): void {
    if (run.cancelled || ["completed", "failed", "cancelled", "escalated"].includes(run.status)) throw new Error(`Run is ${run.status}`);
  }
  private emit(state: JournalState, outbox: HerdrOutbox, run: RunRecord, type: RoleMessage["type"], payload: unknown,
    key: string, recipient: RoleMessage["recipient"]["role"] = "conversation", artifacts: ArtifactReference[] = []): Outbound {
    const messageId = `p19-${digest([run.runId, key])}`;
    const existing = state.outbound.find(out => out.message.message_id === messageId);
    if (existing) return existing;
    return outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
      correlation_id: run.delegation.correlationId, causation_id: run.delegation.messageId,
      run_id: run.runId, sender: { role: "coordinator" }, recipient: { role: recipient }, type,
      payload: json(payload), artifact_references: artifacts, occurred_at: this.now(), idempotency_key: messageId }));
  }
  private progress(state: JournalState, outbox: HerdrOutbox, run: RunRecord, headline: string): void {
    this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status, headline,
      ...(run.error ? { blockageReason: run.error } : {}),
      ...(run.status === "completed" ? { verified: true, completedVerified: true } : {}) }, `progress:${run.status}:${headline}`,
      "conversation", run.status === "completed" ? run.workflowCycle?.history.at(-1)?.evidenceArtifacts ?? [] : []);
  }
  /** Trusted local host enqueues a message; actual inter-agent delivery always uses Herdr. */
  async queueHerdr(input: unknown): Promise<JsonValue> {
    if (this.quiesced) throw new Error("Runtime is quiesced");
    const message = RoleMessageSchema.parse(input);
    return this.transaction(async (_state, save, _core, outbox) => {
      const out = outbox.enqueue(message); await save(); return json(out.message);
    });
  }
  async flushOutbound(): Promise<void> {
    await this.initialize();
    if (this.quiesced) return;
    await this.transaction(async (state, save, core, outbox) => {
      await outbox.flush((out, handle) => this.bind(state, core, out, handle)); await save();
    });
  }
  private readonly gateWaiters = new Map<string, { runId: string; accept(result: QualityGateResult): void; reject(error: Error): void }>();
  /** Reviewer/QA checks are delivered through Herdr; awaiting a reply never holds the Runtime journal lock. */
  herdrQualityGate(id: string): QualityGate {
    return { id, evaluate: async (rawContext, options) => {
      const context = QualityGateContextSchema.parse(rawContext);
      const configuration = record(context.definition.configuration);
      const role = textField(configuration.role);
      if (!["reviewer", "qa", "tester"].includes(role)) throw new Error("Herdr checks require an independent verification role");
      const key = `gate-${digest(context)}`;
      let finish!: (result: QualityGateResult) => void;
      let rejectReply!: (error: Error) => void;
      const reply = new Promise<QualityGateResult>((resolve, reject) => { finish = resolve; rejectReply = reject; });
      reply.catch(() => undefined);
      this.gateWaiters.set(key, { runId: context.runId, accept: finish, reject: rejectReply });
      const abort = () => rejectReply(new Error("Verification operation aborted"));
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await this.transaction(async (state, save, _core, outbox) => {
          const run = this.run(state, context.runId); this.live(run);
          const stored = state.inbox.find(item => item.status === "applied" && item.message.causation_id === key && item.message.type === "review.verdict");
          if (stored) { finish(QualityGateResultSchema.parse(stored.message.payload)); return; }
          outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: key, correlation_id: run.delegation.correlationId,
            run_id: run.runId, sender: { role: "coordinator" }, recipient: { role }, type: "verification.requested",
            payload: context, artifact_references: context.artifacts, occurred_at: this.now(), idempotency_key: key }), role,
            `check-${digest([context.taskId, context.definition.id, context.attemptId])}`, context.attemptId!, role === "reviewer" ? ["review"] : role === "tester" ? ["testing"] : ["verification"]);
          await save();
        });
        await this.flushOutbound();
        const outcome = await Promise.race([reply, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Herdr verification reply timeout; delivery remains reconcilable")), context.definition.timeout.executionTimeoutMs);
        })]);
        return { ok: true, value: outcome };
      } finally { if (timer) clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); this.gateWaiters.delete(key); }
    } };
  }
  async inspect(runId?: string): Promise<JsonValue> {
    return this.transaction(async state => json(runId ? this.run(state, runId) : {
      runs: state.runs, outbound: state.outbound, inbox: state.inbox
    }));
  }
  async loadSpecification(specId: string): Promise<Specification> {
    return this.transaction(async state => {
      for (const run of state.runs) for (const spec of [run.workflowSpec, ...run.tasks.map(task => task.spec)])
        if (spec?.specification.specId === specId) return SpecificationSchema.parse(spec.specification);
      throw new Error("Specification unavailable");
    });
  }

  /** Called only for envelopes received through the Herdr host integration. */
  async receiveHerdr(input: unknown): Promise<JsonValue> {
    const message = RoleMessageSchema.parse(input);
    if (!message.idempotency_key) throw new Error("Inbound handoff lacks idempotency key");
    if (!await this.ports.authenticateMessage(message)) throw new Error("Unauthenticated Herdr envelope");
    return this.transaction(async (state, save, core, outbox) => {
      if (!["coordinator", "runtime"].includes(message.recipient.role)) throw new Error("Wrong inbound recipient");
      const old = state.inbox.find(item => item.message.message_id === message.message_id || item.message.idempotency_key === message.idempotency_key);
      if (old && digest(old.message) !== digest(message)) throw new Error("Conflicting inbound idempotency key");
      if (old?.status === "applied") return json({ duplicate: true });
      const inbox = old ?? { message, status: "received" as const };
      if (!old) { state.inbox.push(inbox); await save(); }
      if (message.type === "conversation.intake" || message.type === "conversation.clarification") {
        // Dialogue-only traffic has no DelegationRequest and must never create a workflow.
        inbox.status = "applied"; await save(); return json({ workflowCreated: false });
      }
      if (message.type === "delegation.request") {
        const delegation = DelegationRequestSchema.parse(message.payload);
        if (message.sender.role !== "conversation" || delegation.requestedBy !== "conversation" || delegation.targetRole !== "coordinator" ||
            delegation.runId !== message.run_id || delegation.correlationId !== message.correlation_id || delegation.messageId !== message.message_id)
          throw new Error("Delegation envelope mismatch");
        const manifest = SessionManifestSchema.parse(unwrap(await this.ports.panes.getManifest()));
        if (manifest.conversationSessionId !== delegation.sessionId) throw new Error("Cross-session delegation");
        if (delegation.metadata?.action === "cancel") {
          const target = this.run(state, textField(delegation.metadata.targetRunId));
          const cancellation = CancellationRequestSchema.parse(delegation.metadata.cancellationRequest);
          if (target.delegation.sessionId !== delegation.sessionId || cancellation.runId !== target.runId) throw new Error("Foreign cancellation");
          await this.cancelRun(state, save, core, outbox, target, cancellation.reason ?? "User requested cancellation");
          inbox.status = "applied"; await save(); return json({ cancellationRequested: true });
        }
        let run = state.runs.find(item => item.runId === message.run_id);
        if (run && digest(run.delegation) !== digest(delegation)) throw new Error("Run already belongs to another delegation");
        if (!run) {
          run = { runId: delegation.runId!, delegation, status: "intake", tasks: [], coreCreated: false,
            cancelled: false, maxIterations: 3 };
          state.runs.push(run);
        }
        this.emit(state, outbox, run, "delegation.accepted", { delegationId: delegation.delegationId,
          sdlcStatus: "intake", headline: "Coordinator accepted the objective" }, "accepted");
      } else {
        const run = this.run(state, message.run_id!);
        if (message.correlation_id !== run.delegation.correlationId) throw new Error("Wrong run correlation");
        this.live(run);
        if (message.type === "approval.decision") {
          if (message.sender.role !== "conversation") throw new Error("Approval must return via Conversation");
          const decision = ApprovalDecisionSchema.parse(message.payload);
          if (run.userDecisions?.[decision.approvalId] !== undefined) await this.answerUserDecision(state, save, outbox, run, decision);
          else await this.applyDecision(state, save, core, outbox, run, decision);
        } else if (message.type === "execution.receipt") {
          const receipt = AgentBindingReceiptSchema.parse(message.payload);
          const out = state.outbound.find(item => item.message.message_id === message.causation_id);
          if (!out?.handle || out.message.type !== "task.assignment" || out.status !== "accepted" ||
              message.sender.agent_id !== out.handle.target.agentId || message.sender.pane_id !== out.handle.target.paneId ||
              message.sender.role !== out.message.recipient.role || canonicalReceiptJson(out.handle) !== canonicalReceiptJson(receipt.handle))
            throw new Error("Receipt is not correlated to the current Herdr assignment");
          const engine = this.ports.engine;
          if (!hasAuthenticatedBindings(engine)) throw new Error("Core does not support authenticated binding receipts");
          await outbox.renew(out);
          const bytes = Buffer.from(canonicalReceiptJson(receipt));
          const { createHash } = await import("node:crypto");
          const checksum = createHash("sha256").update(bytes).digest("hex");
          const evidence = ArtifactReferenceSchema.parse(unwrap(await this.ports.artifactStore.put({ options: {
            artifactId: `binding-receipt-${checksum}`, runId: receipt.handle.runId, taskId: receipt.handle.taskId,
            kind: "report", mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length },
            idempotencyKey: `binding-receipt:${checksum}`
          }, content: (async function* () { yield bytes; })() })));
          const previous = (await core.snapshot(run.runId)).tasks.find(task => task.taskId === receipt.handle.taskId)?.bindingVerification;
          if (previous && canonicalReceiptJson(previous.receipt) !== canonicalReceiptJson(receipt)) throw new Error("Execution already has another binding proof");
          if (!previous) await core.mutate(run.runId, snapshot => engine.verifyAgentBinding({ runId: run.runId, taskId: receipt.handle.taskId,
            expectedVersion: snapshot.version, verification: { receipt, evidence, verifiedAt: message.occurred_at ?? receipt.observedAt },
            occurredAt: message.occurred_at ?? receipt.observedAt, idempotencyKey: `verify-binding:${receipt.receiptId}` }));
        } else if (message.type === "implementation.submitted") {
          await this.submit(state, save, core, outbox, run, message);
        } else if (message.type === "verification.result") {
          const result = VerificationResultSchema.parse(message.payload);
          if (!["tester", "qa"].includes(message.sender.role) || result.runId !== run.runId || result.verificationScope === "workflow")
            throw new Error("Invalid conditional TDD evidence sender/scope");
          const task = run.tasks.find(item => item.taskId === result.taskId);
          if (!task) throw new Error("Evidence task missing");
          const request = state.outbound.find(item => item.message.message_id === message.causation_id &&
            item.message.type === "verification.requested" && record(item.message.payload).kind === "conditional_evidence");
          if (request) {
            if (!request.handle || request.handle.target.agentId !== message.sender.agent_id ||
                request.handle.target.paneId !== message.sender.pane_id || request.message.recipient.role !== message.sender.role ||
                record(request.message.payload).taskId !== result.taskId ||
                record(request.message.payload).phase !== undefined && record(request.message.payload).phase !== record(result.metadata?.conditionalTdd).phase)
              throw new Error("Policy evidence is not correlated to its assigned verifier");
            if (request.status === "accepted") await outbox.renew(request);
            else if (request.status !== "released") throw new Error("Policy evidence delivery is unresolved");
          }
          if (!await this.ports.authenticateEvidence(result, message)) throw new Error("Untrusted independent TDD evidence");
          await this.verifyReferences(result.evidenceArtifacts, run.runId);
          task.spec.strategy = TestStrategySchema.parse(this.ports.policies.recordEvidence(task.spec.strategy, result));
          if (request?.status === "accepted") await outbox.release(request);
          if (request && typeof record(request.message.payload).phase === "string")
            this.phaseNotice(state, outbox, run, task, textField(record(request.message.payload).phase), "passed",
              "Independent policy phase recorded. Continue the accepted TDD sequence; do not modify frozen Red tests.", result.verificationId);
        } else if (message.type === "review.verdict") {
          const result = QualityGateResultSchema.parse(message.payload);
          const outbound = state.outbound.find(out => out.message.message_id === message.causation_id);
          if (!outbound?.handle || outbound.message.type !== "verification.requested" ||
              message.sender.agent_id !== outbound.handle.target.agentId || message.sender.pane_id !== outbound.handle.target.paneId ||
              message.sender.role !== outbound.message.recipient.role || result.runId !== run.runId ||
              result.taskId !== record(outbound.message.payload).taskId || result.gateId !== record(record(outbound.message.payload).definition).id ||
              !await this.ports.authenticateGateResult(result, message))
            throw new Error("Untrusted verification gate reply");
          await outbox.release(outbound);
          inbox.status = "applied"; await save();
          this.gateWaiters.get(message.causation_id!)?.accept(result);
        } else if (message.type === "task.status" && record(message.payload).action === "cancel") {
          if (message.sender.role !== "conversation") throw new Error("Cancellation must return via Conversation");
          await this.cancelRun(state, save, core, outbox, run, textField(record(message.payload).reason));
        } else if (!["spec.draft", "task.status", "review.verdict", "verification.escalation"].includes(message.type)) {
          throw new Error(`Unsupported inbound message ${message.type}`);
        }
      }
      inbox.status = "applied"; await save();
      return json({ accepted: true });
    });
  }

  /** Coordinator chooses these calls adaptively. No fixed chain of Analyst -> Architect -> Planner. */
  async reportProgress(runId: string, headline: string, questions: string[] = []): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      if (questions.length) run.status = "clarifying";
      this.emit(state, outbox, run, questions.length ? "conversation.clarification" : "conversation.progress",
        { headline: textField(headline), questions: strings(questions), sdlcStatus: run.status }, `coordinator-progress:${digest([headline, questions])}`);
      await save(); return json({ queued: true });
    });
  }
  async requestSpecialist(runId: string, role: string, objective: string, requiredCapabilities: string[]): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      if (!["specifier", "architect", "planner", "security", "reviewer", "qa", "tester"].includes(role)) throw new Error("Not a specialist role");
      const pane = unwrap(await this.ports.panes.getRoleBinding(role));
      if (!pane || requiredCapabilities.some(cap => !this.ports.roleCapabilities[role]?.includes(cap))) throw new Error("No capable specialist available");
      const key = `specialist:${role}:${digest([objective, requiredCapabilities])}`;
      const delegation = DelegationRequestSchema.parse({ ...run.delegation, delegationId: `delegation-${digest([runId, key])}`,
        messageId: `p19-${digest([runId, key])}`, requestedBy: "coordinator", targetRole: role, objective,
        idempotencyKey: key, requestedAt: this.now() });
      const out = this.emit(state, outbox, run, "delegation.request", delegation, key, pane.role, run.delegation.inputArtifacts);
      out.capabilities = strings(requiredCapabilities);
      run.status = role === "planner" ? "planning" : "specifying";
      await save(); return json(out.message);
    });
  }
  async assess(specificationInput: unknown): Promise<JsonValue> {
    const spec = SpecificationSchema.parse(specificationInput);
    const assessment = record(spec.metadata?.sdd).assessment;
    const classification = this.ports.policies.classifyChange(assessment, spec.affectedPaths);
    const unresolved = strings(record(assessment).unresolvedQuestions);
    return json({ ...classification, clarificationRequired: unresolved.length > 0,
      suggestedRoles: unresolved.length ? ["specifier"] : classification.complexity === "complex" ? ["architect", "planner"] : [],
      availableCapabilities: this.ports.roleCapabilities });
  }

  async proposeWorkflow(runId: string, specificationInput: unknown, definitionInput: unknown, maxIterations = 3): Promise<JsonValue> {
    if (this.quiesced) throw new Error("Runtime is quiesced");
    const draft = SpecificationSchema.parse(specificationInput);
    const proposed = WorkflowDefinitionSchema.parse(definitionInput);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw new Error("Invalid verification limit");
    return this.transaction(async (state, save, core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      if (run.definition) {
        if (digest(run.definition.metadata?.proposalFingerprint) === digest(digest([draft, proposed, maxIterations]))) return json(run);
        throw new Error("Workflow already proposed; requirement changes need a newly approved delegation");
      }
      if (draft.runId !== runId || draft.specId !== run.delegation.specificationId || draft.sessionId !== run.delegation.sessionId || draft.status !== "draft")
        throw new Error("Specification does not match delegation");
      // Intake criteria cannot be weakened by a planning shortcut.
      for (const criterion of run.delegation.acceptanceCriteria) {
        const accepted = draft.acceptanceCriteria.find(item => item.id === criterion.id);
        if (!accepted || accepted.description !== criterion.description || accepted.verificationMethod !== criterion.verificationMethod || criterion.required && !accepted.required)
          throw new Error("Planning weakens the delegated acceptance criteria");
      }
      if (proposed.qualityGates.length || proposed.tasks.some(task => task.qualityGates.length))
        throw new Error("Configure independent project gates through taskChecks/workflowChecks, not agent-controlled gate definitions");
      if (proposed.tasks.some(task => task.role !== "developer")) throw new Error("Implementation DAG nodes must be Developer tasks; request read-only specialists through requestSpecialist");
      if (proposed.dependencies.some(dep => dep.condition !== "succeeded")) throw new Error("Dependencies must require verified success");
      const classification = this.ports.policies.classifyChange(record(draft.metadata?.sdd).assessment, draft.affectedPaths);
      if (classification.level !== draft.level) throw new Error("SDD level conflicts with assessed policy");
      const definition = WorkflowDefinitionSchema.parse({ ...proposed,
        maxConcurrency: Math.min(proposed.maxConcurrency, this.ports.maxConcurrency ?? 2), tasks: proposed.tasks.map(task => ({ ...task,
        retry: { ...task.retry, maxAttempts: task.retry.maxAttempts + maxIterations - 1 },
        qualityGates: [...task.qualityGates, { gateId: VERIFICATION_GATE, phase: "before_completion", required: true }]
      })), qualityGates: [...proposed.qualityGates, { id: VERIFICATION_GATE, name: "Independent task verification",
        evaluator: "p19-verification", required: true, timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
        metadata: { boundedVerificationRetry: true } }],
        metadata: { ...proposed.metadata, proposalFingerprint: digest([draft, proposed, maxIterations]) } });
      // Build every dossier before publishing any implementation intent.
      const workflowSpec = await this.reviewSpec({ ...draft, metadata: { ...draft.metadata,
        conditionalTdd: { ...record(draft.metadata?.conditionalTdd), taskId: FINAL_TASK } } });
      const tasks: TaskRecord[] = [];
      for (const task of definition.tasks) {
        const ownedPaths = strings(record(task.metadata).ownedPaths);
        if (!ownedPaths.length || ownedPaths.some(path => !draft.affectedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))))
          throw new Error("Task ownership must be within approved literal affectedPaths");
        const criteria = draft.acceptanceCriteria.filter(c => task.acceptanceCriteria.includes(c.id));
        if (!criteria.length) throw new Error("Every task must have mapped acceptance criteria");
        const sdd = record(draft.metadata?.sdd);
        const taskSpec = await this.reviewSpec({ ...draft, specId: `${draft.specId}-${digest(task.id).slice(0, 12)}`,
          acceptanceCriteria: criteria, traceabilityTaskIds: [task.id], metadata: { ...draft.metadata,
            sdd: { ...sdd, traceability: criteria.map(c => ({ criterionId: c.id, taskIds: [task.id] })) },
            conditionalTdd: { ...record(task.metadata?.conditionalTdd ?? draft.metadata?.conditionalTdd), taskId: task.id } } });
        // P15 checks the precise per-task matrix against its graph projection.
        tasks.push({ taskId: task.id, spec: taskSpec, worktrees: [], outboundIds: [] });
      }
      run.definition = definition; run.workflowSpec = workflowSpec; run.tasks = tasks; run.maxIterations = maxIterations;
      run.baseRevision = textField((await this.ports.policies.git.inspect()).head);
      run.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `design-${digest([runId, definition])}`,
        runId, sessionId: run.delegation.sessionId, target: { type: "run" }, revision: draft.version ?? 1,
        generation: 0, status: "pending", requestedBy: "coordinator", requestedAt: this.now(),
        reason: classification.humanApprovalRequired ? "Human design approval required before implementation" : "Specification acceptance",
        evidence: [workflowSpec.specification.artifactRef!, ...tasks.map(task => task.spec.specification.artifactRef!)],
        idempotencyKey: `design:${runId}`, metadata: { bundleFingerprint: digest([definition, workflowSpec, tasks]) } });
      run.approvalKind = "design"; run.status = "awaiting_approval";
      await save();
      if (classification.humanApprovalRequired || this.ports.projectApprovalRequired?.("implementation", json(definition))) {
        this.emit(state, outbox, run, "approval.request", run.approval, `approval:${run.approval.approvalId}`, "conversation", run.approval.evidence);
      } else {
        await this.acceptDesign(run, ApprovalDecisionSchema.parse({ ...this.decisionFields(run.approval), decision: "approved",
          decidedBy: "coordinator", decidedAt: this.now(), feedbackArtifacts: [], idempotencyKey: `autonomous:${run.approval.approvalId}` }));
        await core.create(run);
        this.progress(state, outbox, run, "Accepted specification and test policy; implementation is ready");
      }
      await save(); return json(run);
    });
  }
  private async reviewSpec(input: unknown): Promise<SpecRecord> {
    const original = SpecificationSchema.innerType().parse(input);
    const strategy = TestStrategySchema.parse(this.ports.policies.strategy.resolve(original));
    const draft = this.ports.policies.specification.createDraft({ ...original, testStrategy: strategy, tddDecision: strategy.tddDecision });
    const specification = SpecificationSchema.parse(await this.ports.policies.specification.submitForReview(draft));
    const request = ApprovalRequestSchema.parse(await this.ports.policies.specification.requestApproval(specification, {
      approvalId: `spec-approval-${digest([specification.specId, specification.artifactRef])}`, requestedBy: "coordinator"
    }));
    return { specification, request, strategy };
  }
  private decisionFields(request: import("@bflow/contracts").ApprovalRequest) {
    return { schemaVersion: 2, approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId,
      target: request.target, revision: request.revision, generation: request.generation };
  }
  private async acceptDesign(run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const dossiers = [run.workflowSpec!, ...run.tasks.map(task => task.spec)];
    for (const dossier of dossiers) {
      const bound = ApprovalDecisionSchema.parse({ ...decision, ...this.decisionFields(dossier.request),
        idempotencyKey: `bundle:${decision.idempotencyKey}:${dossier.specification.specId}`,
        metadata: { approvedBundleId: decision.approvalId } });
      dossier.specification = SpecificationSchema.parse(await this.ports.policies.specification.approve(dossier.specification, dossier.request, bound));
      dossier.decision = bound;
    }
    await this.ports.policies.specification.assertImplementationReady(run.workflowSpec!.specification,
      run.workflowSpec!.request, run.workflowSpec!.decision, run.definition);
    for (const task of run.tasks) {
      const projected = { ...run.definition!, tasks: run.definition!.tasks.filter(t => t.id === task.taskId), dependencies: [] };
      await this.ports.policies.specification.assertImplementationReady(task.spec.specification, task.spec.request, task.spec.decision, projected);
    }
    run.decision = decision; run.status = "implementing";
  }
  /** P30 T9b: a specialist or Coordinator asks the user through Runtime -> Herdr -> Conversation; the answer resumes only the asker. */
  async requestUserDecision(bindingInput: PaneBinding, role: AgentRole, input: UserDecisionToolInput): Promise<JsonValue> {
    const binding = PaneBindingSchema.parse(bindingInput);
    if (role === "conversation" || binding.role !== role) throw new Error("User decisions are requested by the bound non-Conversation role");
    return this.transaction(async (state, save, _core, outbox) => {
      if (this.quiesced) throw new Error("Runtime is quiesced");
      const run = this.run(state, input.runId); this.live(run);
      if (role !== "coordinator" && !state.outbound.some(out => out.message.run_id === run.runId && ["accepted", "released"].includes(out.status) &&
          out.handle !== undefined && out.handle.target.paneId === binding.paneId && out.handle.target.agentId === binding.agentId &&
          (out.message.type === "task.assignment" ? out.taskId === input.taskId : out.message.type === "delegation.request")))
        throw new Error("Only the Runtime-bound specialist execution for this run may request a user decision");
      const decisions = run.userDecisions ?? (run.userDecisions = {});
      // Revision counts resolved decisions for the task, so a still-pending identical request keeps its approvalId (idempotent).
      const revision = Object.values(decisions).filter(item => item.taskId === input.taskId && item.status !== "pending").length + 1;
      const request = buildUserDecisionRequest({ input, role, sessionId: run.delegation.sessionId, revision,
        generation: run.approval?.generation ?? 0, now: this.now() });
      const existing = decisions[request.approvalId];
      if (existing) {
        if (existing.status !== "pending" || existing.paneId !== binding.paneId) throw new Error("This user decision request was already resolved or belongs to another pane");
        return json(this.userDecisionReceipt(request.approvalId));
      }
      decisions[request.approvalId] = { request, role, agentId: binding.agentId, paneId: binding.paneId, taskId: input.taskId, status: "pending" };
      outbox.enqueue(buildDecisionRequestMessage({ request, correlationId: run.delegation.correlationId,
        sender: { role: "runtime" }, conversation: { role: "conversation" } }), "conversation");
      this.progress(state, outbox, run, `Waiting for a user decision requested by ${role}`);
      await save();
      return json(this.userDecisionReceipt(request.approvalId));
    });
  }
  private userDecisionReceipt(approvalId: string) {
    return { approvalId, status: "pending", instruction: "End your turn; Runtime resumes you with the answer." };
  }
  private async answerUserDecision(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const entry = run.userDecisions?.[decision.approvalId];
    if (!entry || entry.status !== "pending") throw new Error("User decision is not pending");
    if (!await this.ports.authorizeHuman(decision)) throw new Error("Human approval is not authenticated");
    const now = this.now();
    if (entry.request.expiresAt !== undefined && Date.parse(now) >= Date.parse(entry.request.expiresAt)) {
      this.expireUserDecision(state, outbox, run, entry); await save(); return;
    }
    // Throws on any approvalId, revision, generation, target, option or timing mismatch; nothing is mutated before this.
    const answer = validateUserDecisionAnswer(entry.request, decision, now);
    entry.status = answer.outcome === "rejected" ? "rejected" : "answered";
    entry.answer = answer;
    this.resumeUserDecisionAsker(outbox, run, entry, { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: answer.outcome,
      ...(answer.selectedOption !== undefined ? { selectedOption: answer.selectedOption } : {}),
      ...(answer.reason !== undefined ? { reason: answer.reason } : {}) });
    await save();
  }
  /** Conversation must drop the prompt, otherwise the user keeps answering a question Runtime no longer accepts. */
  private notifyUserDecisionClosed(state: JournalState, outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord): void {
    this.emit(state, outbox, run, "conversation.progress", { kind: USER_DECISION_EXPIRED_KIND, approvalId: entry.request.approvalId,
      requestedByRole: entry.role, taskId: entry.taskId, headline: `User decision expired [${entry.request.approvalId}]` },
    `user-decision-expired:${entry.request.approvalId}`, "conversation");
  }
  private expireUserDecision(state: JournalState, outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord): void {
    entry.status = "expired";
    this.notifyUserDecisionClosed(state, outbox, run, entry);
    this.resumeUserDecisionAsker(outbox, run, entry, { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: "expired" });
  }
  private expireUserDecisions(state: JournalState, outbox: HerdrOutbox): boolean {
    const now = Date.parse(this.now());
    let changed = false;
    for (const run of state.runs) for (const entry of Object.values(run.userDecisions ?? {})) {
      if (entry.status !== "pending") continue;
      if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) {
        // A terminal run never resumes its askers, but Conversation still drops the now-unanswerable prompt.
        entry.status = run.cancelled ? "cancelled" : "expired"; changed = true;
        this.notifyUserDecisionClosed(state, outbox, run, entry);
      } else if (entry.request.expiresAt !== undefined && now >= Date.parse(entry.request.expiresAt)) {
        this.expireUserDecision(state, outbox, run, entry); changed = true;
      }
    }
    return changed;
  }
  /** Resumes the asking pane through the normal Herdr outbox (lease, pane health and recipient checks apply). */
  private resumeUserDecisionAsker(outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord, payload: Record<string, unknown>): void {
    const id = `user-decision-answer-${digest([run.runId, entry.request.approvalId, entry.status])}`;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
      causation_id: `decision-${entry.request.approvalId}`, run_id: run.runId, sender: { role: "coordinator" },
      recipient: { role: entry.role, agent_id: entry.agentId, pane_id: entry.paneId }, type: "task.status",
      payload: json(payload), artifact_references: [], occurred_at: this.now(), idempotency_key: id }), entry.role, entry.taskId, `attempt-${id}`);
  }
  private async applyDecision(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const request = run.approval;
    if (!request || run.status !== "awaiting_approval" || decision.approvalId !== request.approvalId || decision.runId !== request.runId ||
        decision.sessionId !== request.sessionId || decision.revision !== request.revision || decision.generation !== request.generation ||
        digest(decision.target) !== digest(request.target) || Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) ||
        Date.parse(decision.decidedAt) > Date.parse(this.now()) || request.expiresAt && Date.parse(this.now()) >= Date.parse(request.expiresAt))
      throw new Error("Stale or mismatched approval decision");
    if (!await this.ports.authorizeHuman(decision)) throw new Error("Human approval is not authenticated");
    if (decision.decision !== "approved") {
      if (run.approvalKind === "task") await core.mutate(run.runId, snapshot => this.ports.engine.applyApproval({
        decision, expectedVersion: snapshot.version, idempotencyKey: decision.idempotencyKey }));
      run.decision = decision; run.status = decision.decision === "rejected" ? "failed" : "escalated";
      run.error = decision.reason ?? "Approval refused";
      this.progress(state, outbox, run, run.error); await save(); return;
    }
    await this.verifyReferences(request.evidence, run.runId);
    if (run.approvalKind === "design") { await this.acceptDesign(run, decision); await save(); await core.create(run); }
    else if (run.approvalKind === "task") {
      await core.mutate(run.runId, snapshot => this.ports.engine.applyApproval({ decision, expectedVersion: snapshot.version,
        idempotencyKey: decision.idempotencyKey }));
      run.decision = decision; run.status = "implementing";
    } else if (run.approvalKind === "delivery") {
      if (!run.workflowCycle || run.workflowCycle.status !== "passed" || !run.integrationKey ||
          (await this.ports.policies.git.getIntegration(run.integrationKey)).status !== "verified") throw new Error("Delivery lacks verified integration");
      const integrated = await this.ports.policies.git.getIntegration(run.integrationKey);
      const current = await captureIntegratedChange({ artifactStore: this.ports.artifactStore, runId: run.runId, taskId: FINAL_TASK,
        worktreePath: integrated.worktreePath, branchName: integrated.branchName, baseRevision: run.baseRevision!, headCommitHash: integrated.expectedHead });
      if (digest(current.patchArtifact.checksum) !== digest(run.workflowChange!.patchArtifact.checksum)) throw new Error("Integration evidence drifted before delivery");
      run.decision = decision; run.status = "completed";
    } else throw new Error("Action execution is not enabled by this runtime");
    this.progress(state, outbox, run, run.status === "completed" ? "Verified changes approved for delivery" : "Design approved; implementation is ready");
  }
  private async verifyReferences(references: ArtifactReference[], runId: string): Promise<void> {
    const { createHash } = await import("node:crypto");
    for (const input of references) {
      const reference = ArtifactReferenceSchema.parse(input);
      if (reference.runId !== runId) throw new Error("Foreign artifact");
      const resolved = unwrap(await this.ports.artifactStore.resolve(reference.artifactId));
      if (!resolved || digest(resolved) !== digest(reference)) throw new Error("Untrusted artifact reference");
      const hash = createHash(reference.checksum.algorithm); let size = 0;
      for await (const chunk of this.ports.artifactStore.get(reference)) { const bytes = Buffer.from(unwrap(chunk)); size += bytes.length; hash.update(bytes); }
      if (hash.digest("hex") !== reference.checksum.value || reference.sizeBytes !== undefined && reference.sizeBytes !== size)
        throw new Error("Artifact integrity mismatch");
    }
  }
  private async bind(state: JournalState, core: CoreSession, out: Outbound, handle: AgentExecutionHandle): Promise<void> {
    if (out.message.type !== "task.assignment") return;
    const run = this.run(state, handle.runId);
    if (!run.coreCreated) throw new Error("Assignment lacks Core run");
    const snapshot = await core.snapshot(run.runId);
    const task = snapshot.tasks.find(item => item.taskId === handle.taskId);
    if (!task || task.attemptId !== handle.attemptId) {
      const recorded = run.tasks.find(item => item.taskId === handle.taskId)?.result;
      if (recorded?.requestId === handle.requestId && ["failed", "timed_out"].includes(recorded.status)) return;
      throw new Error("Stale task binding");
    }
    if (task.agentExecution) {
      if (digest(task.agentExecution) !== digest(handle)) throw new Error("Conflicting execution binding");
      return;
    }
    await core.mutate(run.runId, current => this.ports.engine.bindAgentExecution({
      runId: run.runId, taskId: task.taskId, expectedVersion: current.version, attempt: task.attempt,
      handle, occurredAt: this.now(), idempotencyKey: `bind:${handle.requestId}`
    }));
  }
  private async submit(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, message: RoleMessage): Promise<void> {
    const result = AgentResultSchema.parse(message.payload);
    const task = run.tasks.find(item => item.taskId === result.taskId);
    const out = state.outbound.find(item => item.message.message_id === message.causation_id);
    if (!task || !out?.handle || out.message.type !== "task.assignment" || out.status !== "accepted" ||
        message.sender.role !== "developer" || message.sender.agent_id !== out.handle.target.agentId ||
        message.sender.pane_id !== out.handle.target.paneId || result.runId !== run.runId ||
        result.executionId !== out.handle.executionId || result.requestId !== out.handle.requestId || result.attemptId !== out.handle.attemptId ||
        !await this.ports.authenticateResult(result, out.handle, message)) throw new Error("Uncorrelated or unauthenticated implementation result");
    const currentTask = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === result.taskId);
    const correlation = currentTask?.bindingVerification?.receipt.correlation ?? out.handle.correlation;
    if (!correlation.verified || result.verification.status !== "verified" || !result.verification.correlation.verified ||
        digest(result.verification.correlation) !== digest(correlation))
      throw new Error("Transport handle lacks verified remote correlation; authenticated receipt integration is required");
    if (task.result?.attemptId === result.attemptId) {
      if (digest(task.result) !== digest(result)) throw new Error("Conflicting implementation receipt");
      const snapshot = await core.snapshot(run.runId);
      if (snapshot.tasks.find(item => item.taskId === result.taskId)?.status !== "running") return;
    }
    if (result.artifactProposals.length) throw new Error("Materialized proposals must be ingested by the trusted host before submission");
    const snapshot = await core.snapshot(run.runId);
    if (snapshot.tasks.find(item => item.taskId === result.taskId)?.attemptId !== result.attemptId) throw new Error("Stale implementation attempt");
    await outbox.renew(out);
    task.result = result;
    await save();
    await core.mutate(run.runId, current => this.ports.engine.recordAgentResult({ runId: run.runId,
      taskId: task.taskId, expectedVersion: current.version, result, occurredAt: this.now(), idempotencyKey: `result:${result.requestId}` }));
    let evidenceComplete = false;
    try { this.ports.policies.assertEvidenceComplete(task.spec.strategy); evidenceComplete = true; } catch { /* Independent evidence is still required. */ }
    if (this.ports.automaticAlternativeEvidence && result.status === "succeeded" && !evidenceComplete && task.spec.strategy.tddDecision.mode !== "required") {
      const requestId = `alternative-${result.requestId}`;
      outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: requestId,
        correlation_id: run.delegation.correlationId, causation_id: message.message_id, run_id: run.runId,
        sender: { role: "coordinator" }, recipient: { role: "qa" }, type: "verification.requested",
        payload: json({ kind: "conditional_evidence", runId: run.runId, taskId: task.taskId,
          instruction: "Inspect the exact committed diff with inspect_alternative_verification, evaluate the accepted criteria independently, then record_alternative_verification. Do not invent evidence.",
          specification: task.spec.specification, strategy: task.spec.strategy }), artifact_references: [],
        occurred_at: this.now(), idempotency_key: requestId }), "qa", `evidence-${task.taskId}`, `evidence-${result.attemptId}`, ["testing"]);
    }
    if (result.status === "blocked") { run.error = result.blockage?.message ?? "Developer is blocked"; this.progress(state, outbox, run, run.error); }
    if (["failed", "timed_out"].includes(result.status)) this.progress(state, outbox, run, result.error?.message ?? "Implementation failed");
    await save();
  }
  private async dispatch(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox, run: RunRecord): Promise<void> {
    const before = await core.snapshot(run.runId);
    if (["succeeded", "failed", "cancelled", "cancelling"].includes(before.status)) return;
    await core.mutate(run.runId, snapshot => this.ports.engine.advance({ runId: run.runId, expectedVersion: snapshot.version,
      occurredAt: this.now(), idempotencyKey: `advance:${run.runId}:${snapshot.version}` }));
    const snapshot = await core.snapshot(run.runId);
    for (const taskState of snapshot.tasks.filter(task => task.status === "running" && !task.agentExecution)) {
      const task = run.tasks.find(item => item.taskId === taskState.taskId)!;
      const definition = run.definition!.tasks.find(item => item.id === task.taskId)!;
      const id = `assignment:${run.runId}:${taskState.attemptId}`;
      if (state.outbound.some(out => out.message.idempotency_key === id)) continue;
      const agentName = `dev-${digest([run.runId, taskState.attemptId]).slice(0, 20)}`;
      const prior = task.changeSet;
      const tree = await this.ports.policies.git.prepareTask({ runId: run.runId, taskId: task.taskId,
        attemptId: taskState.attemptId!, baseRevision: prior?.headCommitHash ?? run.baseRevision!,
        ownedPaths: strings(record(definition.metadata).ownedPaths),
        forbiddenPaths: definition.metadata?.forbiddenPaths ? strings(definition.metadata.forbiddenPaths) : [], developerId: agentName });
      if (!task.worktrees.some(item => item.key === tree.key)) task.worktrees.push(tree);
      await save();
      const allocation = await this.ports.panes.allocateDeveloper({
        taskId: `${run.runId}-${task.taskId}`, runId: run.runId, worktreePath: tree.worktreePath,
        branchName: tree.branchName, agentName
      });
      if (!allocation.ok) {
        run.error = `Developer allocation pending for ${task.taskId}: ${allocation.error.message}`;
        if (allocation.error.code !== "conflict" || !allocation.error.retryable) run.status = "escalated";
        this.progress(state, outbox, run, run.error); await save(); continue;
      }
      const pane = PaneBindingSchema.parse(allocation.value);
      if (pane.worktreePath !== tree.worktreePath || pane.agentId !== agentName) throw new Error("Developer allocation mismatch");
      const requiredCapabilities = definition.metadata?.requiredCapabilities ? strings(definition.metadata.requiredCapabilities) : ["implementation"];
      const messageId = `message-${digest(id)}`;
      const message = RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
        correlation_id: run.delegation.correlationId, causation_id: run.delegation.messageId, run_id: run.runId,
        sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: pane.agentId, pane_id: pane.paneId },
        type: "task.assignment", payload: { task: definition, specification: task.spec.specification,
          testStrategy: task.spec.strategy, worktree: tree, findings: task.cycle?.history.at(-1)?.findings ?? [],
          implementationAuthorizationRequired: task.spec.strategy.tddDecision.mode === "required",
          instruction: "Use Runtime authorize_implementation after independent Red evidence, then Green and Refactor. Submit only via Herdr. Never infer success from a terminal status." },
        artifact_references: [task.spec.specification.artifactRef!], occurred_at: this.now(), idempotency_key: id });
      outbox.enqueue(message, pane.bindingId, task.taskId, taskState.attemptId!, requiredCapabilities);
      task.outboundIds.push(messageId); delete task.result; task.writerReleased = false;
      await save();
    }
  }
  async authorizeImplementation(runId: string, taskId: string): Promise<JsonValue> {
    return this.transaction(async state => {
      const run = this.run(state, runId); this.live(run);
      const task = run.tasks.find(item => item.taskId === taskId);
      if (!task || task.spec.specification.status !== "approved") throw new Error("No accepted task specification");
      this.ports.policies.assertReadyToImplement(task.spec.strategy);
      return json({ authorized: true, decisionId: task.spec.strategy.tddDecision.decisionId });
    });
  }
  /** Trusted local tool guard. Keep current ownership and lease checks adjacent
   * to file/commit operations; model arguments never supply the authority. */
  async withDeveloperWorkspace<T>(bindingInput: PaneBinding, runId: string, taskId: string,
    use: (task: TaskRecord, definition: TaskDefinition) => Promise<T>): Promise<T> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, _save, core, outbox) => {
      if (this.quiesced || binding.role !== "developer") throw new Error("Developer writes are quiesced or unauthorized");
      const run = this.run(state, runId); this.live(run);
      const task = run.tasks.find(item => item.taskId === taskId), definition = run.definition?.tasks.find(item => item.id === taskId);
      const current = (await core.snapshot(runId)).tasks.find(item => item.taskId === taskId);
      const out = state.outbound.find(item => item.handle?.requestId === current?.agentExecution?.requestId);
      if (!task || !definition || task.spec.specification.status !== "approved" || current?.status !== "running" ||
          !out?.handle || out.status !== "accepted" || out.handle.target.agentId !== binding.agentId || out.handle.target.paneId !== binding.paneId ||
          out.handle.target.worktreePath !== binding.worktreePath || digest(out.handle.target.session) !== digest(binding.session) ||
          task.worktrees.at(-1)?.worktreePath !== binding.worktreePath)
        throw new Error("No current Developer assignment owns this task workspace");
      await outbox.renew(out);
      return use(task, definition);
    });
  }
  /** A Developer requests a policy measurement, never a direct specialist dispatch. */
  async requestPhaseVerification(binding: PaneBinding, runId: string, taskId: string, phase: string, sourceRevision: string): Promise<JsonValue> {
    binding = PaneBindingSchema.parse(binding);
    if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Verification needs a committed source revision");
    return this.transaction(async (state, save, core, outbox) => {
      if (this.quiesced || binding.role !== "developer") throw new Error("Verification intake is quiesced or unauthorized");
      const run = this.run(state, runId); this.live(run);
      const task = run.tasks.find(item => item.taskId === taskId), current = (await core.snapshot(runId)).tasks.find(item => item.taskId === taskId);
      const assignment = state.outbound.find(item => item.handle?.requestId === current?.agentExecution?.requestId);
      if (!task || current?.status !== "running" || assignment?.status !== "accepted" || assignment.handle?.target.agentId !== binding.agentId ||
          assignment.handle.target.paneId !== binding.paneId || assignment.handle.target.worktreePath !== binding.worktreePath ||
          digest(assignment.handle.target.session) !== digest(binding.session))
        throw new Error("Verification request does not own the current Developer assignment");
      if (!task.spec.strategy.targetCommands.length) throw new Error("This task uses independent manual evidence after submission, not automated phase requests");
      await outbox.renew(assignment);
      const rawReceipts = task.spec.strategy.metadata?.tddEvidence ?? [];
      if (!Array.isArray(rawReceipts)) throw new Error("Corrupt policy measurement history");
      const receipts = rawReceipts.map(item => VerificationResultSchema.parse(item));
      const recorded = receipts.find(item => record(item.metadata?.conditionalTdd).phase === phase);
      if (recorded) return json({ alreadyRecorded: true, verificationId: recorded.verificationId });
      const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][receipts.length] : "verification";
      if (phase !== expected) throw new Error(`Policy requires ${expected ?? "no additional"} measurement, not ${phase}`);
      const previous = state.outbound.find(item => item.message.type === "verification.requested" && item.message.run_id === runId &&
        record(item.message.payload).kind === "conditional_evidence" && record(item.message.payload).taskId === taskId &&
        record(item.message.payload).phase === phase && record(item.message.payload).implementationAttemptId === current.attemptId &&
        !item.error?.startsWith("policy_phase_failed:"));
      if (previous) {
        if (record(previous.message.payload).sourceRevision !== sourceRevision) throw new Error("Prior phase measurement is unresolved on another revision; reconcile it before retrying");
        return json({ queued: true, messageId: previous.message.message_id, deliveryStatus: previous.status });
      }
      if (state.outbound.some(item => item.message.run_id === runId && item.error?.startsWith("policy_phase_failed:") &&
          record(item.message.payload).taskId === taskId && record(item.message.payload).phase === phase &&
          record(item.message.payload).implementationAttemptId === current.attemptId && record(item.message.payload).sourceRevision === sourceRevision))
        throw new Error("This revision already failed the phase; commit a repair before requesting another measurement");
      const id = `phase-${digest([runId, taskId, current.attemptId, phase, sourceRevision])}`;
      outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
        causation_id: assignment.message.message_id, run_id: runId, sender: { role: "coordinator" }, recipient: { role: "qa" },
        type: "verification.requested", artifact_references: [], occurred_at: this.now(), idempotency_key: id,
        payload: json({ kind: "conditional_evidence", phase, runId, taskId, sourceRevision, implementationAttemptId: current.attemptId,
          specification: task.spec.specification, strategy: task.spec.strategy,
          instruction: "Run record_behavioral_verification for this exact phase and revision using the owner-configured independent runner. Never supply measured output yourself." })
      }), "qa", `phase-${taskId}-${phase}`, `phase-${current.attemptId}-${phase}`, ["testing"]);
      await save(); return json({ queued: true, messageId: id });
    });
  }
  private phaseNotice(state: JournalState, outbox: HerdrOutbox, run: RunRecord, task: TaskRecord,
    phase: string, status: string, summary: string, outcomeId: string): void {
    const parent = [...state.outbound].reverse().find(item => item.message.type === "task.assignment" &&
      item.message.run_id === run.runId && item.taskId === task.taskId && item.status === "accepted" && item.handle);
    if (!parent?.handle) throw new Error("Policy phase has no active Developer assignment for its outcome");
    const id = `phase-notice-${digest([run.runId, task.taskId, phase, outcomeId])}`;
    outbox.enqueueTaskNotice(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
      causation_id: parent.message.message_id, run_id: run.runId, sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: parent.handle.target.agentId, pane_id: parent.handle.target.paneId }, type: "task.status",
      payload: json({ kind: "policy_phase_outcome", runId: run.runId, taskId: task.taskId, phase, status, summary, outcomeId }),
      artifact_references: [], occurred_at: this.now(), idempotency_key: id }), parent);
  }
  /** Actual host measurements can fail without becoming successful P16 evidence.
   * Preserve the request outcome, bound repairs, and resume only its owning task. */
  async recordPhaseFailure(bindingInput: PaneBinding, requestId: string, summary: string, repairable: boolean, evidence?: ArtifactReference): Promise<JsonValue> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, save, _core, outbox) => {
      const request = state.outbound.find(item => item.message.message_id === requestId);
      if (!request?.handle || request.message.type !== "verification.requested" || !["accepted", "released"].includes(request.status) ||
          request.handle.target.paneId !== binding.paneId || request.handle.target.agentId !== binding.agentId ||
          digest(request.handle.target.session) !== digest(binding.session) || record(request.message.payload).kind !== "conditional_evidence")
        throw new Error("Phase failure does not belong to this independent verifier");
      const run = this.run(state, request.message.run_id!);
      if (request.phaseFailure) {
        if (request.phaseFailure.summary !== summary || request.phaseFailure.repairable !== repairable || digest(request.phaseFailureEvidence) !== digest(evidence))
          throw new Error("Conflicting immutable policy failure outcome");
        return json({ alreadyRecorded: true, status: run.status });
      }
      this.live(run);
      if (request.status !== "accepted") throw new Error("Verifier released without a saved phase failure; reconcile its original request");
      if (evidence) { await this.verifyReferences([evidence], run.runId); request.phaseFailureEvidence = ArtifactReferenceSchema.parse(evidence); }
      await outbox.renew(request);
      request.phaseFailure = { summary: textField(summary), repairable, applied: false };
      request.error = `policy_phase_failed:${summary}`;
      await save(); // preserve the measured outcome before releasing its lease
      await this.recoverPhaseFailures(state, save, outbox);
      return json({ status: run.status, maxIterations: run.maxIterations });
    });
  }
  private async recoverPhaseFailures(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox): Promise<void> {
    for (const request of state.outbound.filter(item => item.phaseFailure && !item.phaseFailure.applied)) {
      const { summary, repairable } = request.phaseFailure!;
      const run = this.run(state, request.message.run_id!), payload = record(request.message.payload);
      const task = run.tasks.find(item => item.taskId === payload.taskId);
      if (!task) throw new Error("Policy failure task is missing");
      await outbox.release(request);
      const failures = state.outbound.filter(item => item.message.run_id === run.runId && item.error?.startsWith("policy_phase_failed:") &&
        record(item.message.payload).taskId === task.taskId && record(item.message.payload).phase === payload.phase &&
        record(item.message.payload).implementationAttemptId === payload.implementationAttemptId).length;
      if (run.cancelled || ["completed", "failed", "cancelled", "escalated"].includes(run.status)) {
        // Retain the receipt while preserving a newer terminal decision.
      } else if (!repairable || failures >= run.maxIterations) {
        run.status = "escalated"; run.error = !repairable ? `Policy measurement blocked: ${summary}` : `Policy phase repair limit exhausted: ${summary}`;
        this.progress(state, outbox, run, run.error);
      } else this.phaseNotice(state, outbox, run, task, textField(payload.phase), "failed", summary, request.message.message_id);
      request.phaseFailure!.applied = true;
      await save();
    }
  }
  private verificationPlan(run: RunRecord, task?: TaskRecord): VerificationPlan {
    if (task?.verificationPlan) return task.verificationPlan;
    const dossier = task?.spec ?? run.workflowSpec!;
    const plan = this.ports.policies.createVerificationPlan({ runId: run.runId, taskId: task?.taskId ?? FINAL_TASK,
      scope: task ? "task" : "workflow", specification: dossier.specification, strategy: dossier.strategy,
      checks: (task ? [...this.ports.taskChecks] : [...this.ports.workflowChecks]).map(check => {
        if (check.metadata?.bindAcceptedCriteria !== true) return check;
        const config = record(check.configuration);
        const criteria = dossier.specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived" &&
          (config.kind === "review" || criterion.verificationMethod === config.method && dossier.strategy.criterionMappings.some(mapping =>
            mapping.criterionId === criterion.id && mapping.testNames.length && mapping.testNames.every(name => Array.isArray(config.testNames) && config.testNames.includes(name)))));
        return { ...check, configuration: json({ ...config, criterionIds: criteria.map(criterion => criterion.id),
          testNames: config.kind === "review" ? dossier.strategy.criterionMappings.filter(mapping => criteria.some(criterion => criterion.id === mapping.criterionId)).flatMap(mapping => mapping.testNames) : config.testNames }) };
      }),
      implementerIds: run.tasks.flatMap(item => item.outboundIds).map(id => this.activeState!.outbound.find(out => out.message.message_id === id)?.handle?.target.agentId).filter((id): id is string => !!id),
      maxIterations: run.maxIterations });
    if (task) task.verificationPlan = plan;
    return plan;
  }
  private activeState: JournalState | undefined;
  /** A bounded scheduler step; performs independent verification outside the journal lock. */
  async tick(): Promise<JsonValue> {
    await this.initialize();
    if (this.quiesced) return this.inspect();
    await this.transaction(async (state, save, _core, outbox) => { if (this.expireUserDecisions(state, outbox)) await save(); });
    const pending = await this.transaction(async state => structuredClone(state.pendingVerifications));
    for (const item of pending) await this.finishVerification(this.parseJob(item.job), this.parseOutcome(item.outcome));
    const jobs = await this.transaction(async (state, save, core, outbox) => {
      const jobs: VerificationJob[] = [];
      this.activeState = state;
      try {
        for (const run of state.runs) {
          if (this.quiesced) break;
          if (run.cancelled || ["completed", "failed", "cancelled", "escalated", "awaiting_approval", "intake", "clarifying", "specifying", "planning"].includes(run.status)) continue;
          if (!run.coreCreated) await core.create(run);
          let awaitingWriterStop = false;
          for (const task of run.tasks.filter(item => item.result && ["failed", "timed_out"].includes(item.result.status))) {
            const prior = state.outbound.find(out => out.handle?.requestId === task.result!.requestId);
            if (prior?.status === "accepted") {
              const health = unwrap(await this.ports.panes.inspectRoleHealth(prior.selector));
              if (!health.readyForPrompt || !health.occupantMatches) { awaitingWriterStop = true; continue; }
              unwrap(await this.ports.panes.releaseDeveloper({ taskId: `${run.runId}-${task.taskId}`, closePane: false, removeWorktree: false }));
              await outbox.release(prior);
            }
          }
          if (!awaitingWriterStop) await this.dispatch(state, save, core, outbox, run);
          for (const task of run.tasks) {
            if (!task.result || task.result.status !== "succeeded" || task.verificationPending) continue;
            const current = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === task.taskId)!;
            if (current.status !== "waiting") continue;
            const out = state.outbound.find(item => item.handle?.requestId === task.result!.requestId)!;
            const health = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
            if (!health.readyForPrompt || !health.occupantMatches) continue; // writer still active
            try { this.ports.policies.assertEvidenceComplete(task.spec.strategy); }
            catch (error) {
              run.error = `Independent policy evidence required for ${task.taskId}: ${String(error)}`;
              this.progress(state, outbox, run, run.error); continue;
            }
            delete run.error;
            if (!task.writerReleased) {
              unwrap(await this.ports.panes.releaseDeveloper({ taskId: `${run.runId}-${task.taskId}`, closePane: false, removeWorktree: false }));
              task.writerReleased = true; await save();
            }
            const change = GitChangeSetSchema.parse(await this.ports.policies.git.collectTask(task.worktrees.at(-1)!.key));
            if (change.runId !== run.runId || change.taskId !== task.taskId || change.attemptId !== current.attemptId) throw new Error("Git task submission mismatch");
            task.changeSet = change;
            const plan = this.verificationPlan(run, task);
            task.cycle ??= VerificationCycleSchema.parse(this.ports.policies.verification.start(plan, `cycle-${digest([run.runId, task.taskId])}`));
            task.verificationPending = true; run.status = "verifying";
            jobs.push({ runId: run.runId, taskId: task.taskId, plan, cycle: task.cycle, change,
              options: task.cycle.history.length ? { repair: { taskId: task.taskId, role: "developer", changeSetId: change.changeSetId,
                summary: "Developer repaired the independent verification findings" } } : {} });
            await save();
          }
          const snapshot = await core.snapshot(run.runId);
          if (snapshot.status === "blocked" && snapshot.tasks.some(task => ["failed", "blocked"].includes(task.status))) {
            run.status = "escalated"; run.error = "Task blocked or implementation retry policy exhausted";
            this.progress(state, outbox, run, run.error);
          }
          if (snapshot.status === "failed") { run.status = "failed"; this.progress(state, outbox, run, "Implementation retry policy exhausted"); }
          if (snapshot.tasks.every(task => task.status === "succeeded") && run.tasks.every(task => task.cycle?.status === "passed")) {
            await this.integrate(state, save, outbox, run);
            if (run.status === "verifying" && run.workflowChange && !run.workflowVerificationPending) {
              const plan = this.verificationPlan(run);
              run.workflowCycle ??= VerificationCycleSchema.parse(this.ports.policies.verification.start(plan, `cycle-${digest([run.runId, FINAL_TASK])}`));
              run.workflowVerificationPending = true;
              jobs.push({ runId: run.runId, taskId: FINAL_TASK, plan, cycle: run.workflowCycle, change: run.workflowChange,
                options: { integration: { headCommitHash: run.workflowChange.headCommitHash, integratedTaskIds: run.tasks.map(task => task.taskId) } } });
            }
          }
          await core.checkpoint(run.runId);
        }
        if (!this.quiesced) await outbox.flush((out, handle) => this.bind(state, core, out, handle));
        await save(); return jobs;
      } finally { this.activeState = undefined; }
    });
    for (const job of jobs) {
      // No Runtime lock is held: QA/Reviewer may reply through Herdr while verification awaits them.
      try {
        const outcome = await this.ports.policies.verification.verify(job.plan, job.cycle, job.change, job.options);
        await this.finishVerification(job, outcome);
      } catch (error) {
        await this.transaction(async (state, save, _core, outbox) => {
          const run = this.run(state, job.runId);
          if (!run.cancelled && !["failed", "completed", "cancelled", "escalated"].includes(run.status)) {
            run.status = "escalated"; run.error = `Verification delivery/storage requires reconciliation: ${String(error)}`;
            this.progress(state, outbox, run, run.error); }
          await save();
        });
      }
    }
    return this.inspect();
  }
  private parseJob(input: unknown): VerificationJob {
    const value = record(input); const plan = record(value.plan);
    const { planId, specFingerprint, ...configuration } = plan;
    const parsedPlan = this.ports.policies.createVerificationPlan(configuration);
    if (planId !== parsedPlan.planId || specFingerprint !== parsedPlan.specFingerprint) throw new Error("Corrupt verification job plan");
    return { runId: textField(value.runId), taskId: textField(value.taskId), plan: parsedPlan,
      cycle: VerificationCycleSchema.parse(value.cycle), change: GitChangeSetSchema.parse(value.change), options: value.options };
  }
  private parseOutcome(input: unknown) {
    const value = record(input);
    return { result: VerificationResultSchema.parse(value.result), cycle: VerificationCycleSchema.parse(value.cycle), messages: [] };
  }
  private async finishVerification(job: VerificationJob, outcome: { result: unknown; cycle: unknown; messages: RoleMessage[] }): Promise<void> {
    const result = VerificationResultSchema.parse(outcome.result);
    const cycle = VerificationCycleSchema.parse(outcome.cycle);
    if (result.runId !== job.runId || result.taskId !== job.taskId || cycle.runId !== job.runId || cycle.taskId !== job.taskId ||
        cycle.cycleId !== job.cycle.cycleId || result.changeSet?.changeSetId !== job.change.changeSetId) throw new Error("Verification outcome mismatch");
    await this.transaction(async (state, save, core, outbox) => {
      const run = this.run(state, job.runId);
      const pendingId = result.verificationId;
      const clearPending = () => { state.pendingVerifications = state.pendingVerifications.filter(item => record(record(item.outcome).result).verificationId !== pendingId); };
      if (run.cancelled || ["failed", "completed", "cancelled"].includes(run.status) ||
          run.status === "escalated" && !run.error?.startsWith("Verification delivery/storage requires reconciliation:")) {
        clearPending(); await save(); return; // late evidence cannot revive a terminal decision
      }
      // A frozen P17 plan predates identities allocated for later repairs.
      // Enforce independence against every actual implementation assignment as well.
      const implementerIds = new Set(state.outbound.filter(out => out.message.run_id === run.runId &&
        out.message.type === "task.assignment").map(out => out.handle?.target.agentId).filter(Boolean));
      if (result.qualityGateResults.some(gate => {
        const observation = gate.metadata?.verification;
        return observation !== null && typeof observation === "object" && !Array.isArray(observation) &&
          typeof observation.executorId === "string" && implementerIds.has(observation.executorId);
      })) throw new Error("Verification evidence executor is a workflow implementer");
      const existingPending = state.pendingVerifications.find(item => record(record(item.outcome).result).verificationId === pendingId);
      if (!existingPending) { state.pendingVerifications.push({ job: json(job), outcome: json(outcome) }); await save(); }
      // Other parallel checks may finish while a human is deciding this task.
      // Retain their durable outcomes without replacing the active approval or phase.
      if (run.status === "awaiting_approval" && run.approvalKind === "task" &&
          (run.approval?.target.type !== "task" || run.approval.target.taskId !== job.taskId)) {
        await save(); return;
      }
      const task = run.tasks.find(item => item.taskId === job.taskId);
      const currentCycle = task?.cycle ?? run.workflowCycle;
      if (digest(currentCycle) !== digest(job.cycle) && digest(currentCycle) !== digest(cycle)) throw new Error("Verification cycle changed while executing");
      await this.verifyReferences(result.evidenceArtifacts, run.runId);
      if (task) {
        const evaluationId = `evaluation-${result.verificationId}`;
        if (!await core.hasEvent(run.runId, "quality_gate.evaluation_requested", evaluationId)) await core.mutate(run.runId, snapshot => this.ports.engine.requestQualityGateEvaluation({ runId: run.runId, taskId: task.taskId,
          evaluationId, gateId: VERIFICATION_GATE, attemptId: task.result!.attemptId, expectedVersion: snapshot.version,
          occurredAt: this.now(), idempotencyKey: `gate-request:${result.verificationId}` }));
        const gate = QualityGateResultSchema.parse({ gateId: VERIFICATION_GATE, runId: run.runId, taskId: task.taskId,
          evaluationId, status: result.status === "passed" ? "passed" : result.status === "failed" && cycle.status === "rework_required" ? "failed" : "blocked",
          findings: result.findings, producedArtifacts: [], evaluatedAt: result.completedAt,
          metadata: { independentVerification: true, verificationId: result.verificationId, evidence: json(result.evidenceArtifacts) } });
        if (!await core.hasEvent(run.runId, "quality_gate.evaluated", evaluationId)) await core.mutate(run.runId, snapshot => this.ports.engine.recordQualityGateResult({ expectedVersion: snapshot.version,
          result: gate, idempotencyKey: `gate-result:${result.verificationId}` }));
        task.cycle = cycle; task.verificationPending = false;
        const out = state.outbound.find(item => item.handle?.requestId === task.result!.requestId);
        if (out) await outbox.release(out);
        if (cycle.status === "rework_required") {
          run.status = "implementing"; task.writerReleased = false;
          this.progress(state, outbox, run, `Verification requested scoped repairs for ${task.taskId}`);
        } else if (cycle.status === "passed") {
          run.status = "implementing";
          if (run.definition!.tasks.find(definition => definition.id === task.taskId)!.requiresApproval) {
            const currentTask = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === task.taskId)!;
            run.approvalKind = "task"; run.status = "awaiting_approval";
            run.approval = run.approval?.approvalId === `task-approval-${result.verificationId}` ? run.approval : ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `task-approval-${result.verificationId}`,
              runId: run.runId, sessionId: run.delegation.sessionId, status: "pending", target: { type: "task", taskId: task.taskId },
              revision: 1, generation: currentTask.generation, requestedBy: "coordinator", requestedAt: this.now(),
              reason: "Project policy requires task acceptance", evidence: result.evidenceArtifacts,
              idempotencyKey: `task-approval:${result.verificationId}` });
            if (!await core.hasEvent(run.runId, "approval.requested", run.approval.approvalId)) await core.mutate(run.runId, snapshot => this.ports.engine.requestApproval({ request: run.approval!,
              expectedVersion: snapshot.version, idempotencyKey: run.approval!.idempotencyKey }));
            this.emit(state, outbox, run, "approval.request", run.approval, run.approval.idempotencyKey, "conversation", result.evidenceArtifacts);
          }
        }
        else { run.status = "escalated"; run.error = cycle.escalation?.reason ?? "Verification blocked"; }
      } else {
        run.workflowCycle = cycle; run.workflowVerificationPending = false;
        const currentIntegration = await this.ports.policies.git.getIntegration(run.integrationKey!);
        const integration = currentIntegration.status === "verified" ? currentIntegration : await this.ports.policies.git.recordVerification(run.integrationKey!, result);
        if (cycle.status === "passed" && integration.status === "verified") {
          run.status = "awaiting_approval"; run.approvalKind = "delivery";
          run.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `delivery-${digest([run.runId, result.verificationId])}`,
            runId: run.runId, sessionId: run.delegation.sessionId, status: "pending", target: { type: "run" }, revision: 1, generation: 0,
            requestedBy: "coordinator", requestedAt: this.now(), reason: "Approve delivery of independently verified integrated changes",
            evidence: result.evidenceArtifacts, idempotencyKey: `delivery:${run.runId}:${result.verificationId}` });
          this.emit(state, outbox, run, "approval.request", run.approval, run.approval.idempotencyKey, "conversation", result.evidenceArtifacts);
        } else {
          // Integrated revisions are immutable. Workflow repair requires a new approved task graph.
          run.status = "escalated"; run.error = cycle.escalation?.reason ?? "Integrated workflow verification failed; plan scoped repairs";
        }
      }
      this.emit(state, outbox, run, "verification.result", result, result.verificationId, "conversation", result.evidenceArtifacts);
      if (run.status === "escalated") this.progress(state, outbox, run, run.error!);
      clearPending(); await save(); await core.checkpoint(run.runId);
    });
  }
  private async integrate(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord): Promise<void> {
    let integration: Integration;
    if (run.integrationKey) integration = await this.ports.policies.git.getIntegration(run.integrationKey);
    else {
      integration = await this.ports.policies.git.beginIntegration({ runId: run.runId, integrationId: `integration-${digest(run.runId)}`,
        baseRevision: run.baseRevision!, tasks: run.tasks.map(task => ({ taskKey: task.worktrees.at(-1)!.key,
          dependsOn: run.definition!.dependencies.filter(dep => dep.taskId === task.taskId).map(dep => run.tasks.find(t => t.taskId === dep.dependsOnTaskId)!.worktrees.at(-1)!.key) })) });
      run.integrationKey = textField(integration.key); await save();
    }
    for (const message of integration.requests) {
      const parsed = RoleMessageSchema.parse(message);
      // P18 requests travel through Herdr to Coordinator, with the original durable identity.
      outbox.enqueue(parsed);
    }
    if (integration.status === "conflict") {
      run.status = "escalated"; run.error = "Git integration conflict requires an assigned resolver; worktree preserved";
      this.progress(state, outbox, run, run.error); return;
    }
    if (integration.status !== "awaiting_verification" || run.workflowChange) return;
    run.workflowChange = await captureIntegratedChange({ artifactStore: this.ports.artifactStore, runId: run.runId,
      taskId: FINAL_TASK, worktreePath: integration.worktreePath, branchName: integration.branchName,
      baseRevision: run.baseRevision!, headCommitHash: integration.expectedHead });
    run.status = "verifying"; await save();
  }
  async reconcileDelivery(messageId: string): Promise<JsonValue> {
    return this.transaction(async (state, save, core, outbox) => {
      await outbox.reconcile(messageId, (out, handle) => this.bind(state, core, out, handle));
      await save(); return json({ reconciled: true });
    });
  }
  async acceptConflictResolution(runId: string, taskKey: string, resolutionCommitHash: string): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId);
      if (run.cancelled || !run.integrationKey || run.status !== "escalated" || !run.error?.startsWith("Git integration conflict")) throw new Error("No pending conflict");
      const integration = await this.ports.policies.git.acceptConflictResolution(run.integrationKey, { taskKey, resolutionCommitHash });
      run.status = "implementing"; delete run.error;
      this.progress(state, outbox, run, "Committed conflict resolution accepted; workflow verification required");
      await save(); return json(integration);
    });
  }
  async cancel(runId: string, reason: string): Promise<JsonValue> {
    return this.transaction(async (state, save, core, outbox) => {
      await this.cancelRun(state, save, core, outbox, this.run(state, runId), reason);
      return json(this.run(state, runId));
    });
  }
  private async cancelRun(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, reason: string): Promise<void> {
    if (!run.cancelled) { run.cancelled = true; run.status = "cancelled"; run.error = textField(reason); await save(); }
    if (run.coreCreated) {
      const snapshot = await core.snapshot(run.runId);
      if (!["succeeded", "failed", "cancelled", "cancelling"].includes(snapshot.status)) {
        const request = CancellationRequestSchema.parse({ schemaVersion: 1, cancellationId: `cancel-${digest(run.runId)}`,
          runId: run.runId, requestedBy: "conversation", requestedAt: this.now(), expectedVersion: snapshot.version,
          reason, idempotencyKey: `cancel:${run.runId}` });
        await core.mutate(run.runId, () => this.ports.engine.requestCancellation(request));
      }
    }
    for (const waiter of this.gateWaiters.values()) if (waiter.runId === run.runId) waiter.reject(new Error("Run cancellation requested"));
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId &&
      ["task.assignment", "verification.requested", "delegation.request"].includes(item.message.type) &&
      !["coordinator", "conversation"].includes(item.message.recipient.role))) {
      if (out.status === "queued") { out.status = "cancelled"; continue; }
      if (out.status === "sending") out.status = "unknown_delivery";
      if (out.status === "accepted" && out.handle && !out.cancelRequested) {
        try { await outbox.renew(out); } catch (error) { out.error = `Cancellation lease unresolved: ${String(error)}`; await save(); continue; }
        out.cancelRequested = true; await save();
        // An accepted interrupt is not confirmation of stop. Keep leases/worktrees and Core cancelling state.
        const version = run.coreCreated ? (await core.snapshot(run.runId)).version : 0;
        const request = CancellationRequestSchema.parse({ schemaVersion: 1, cancellationId: `cancel-${digest(out.message.message_id)}`,
          runId: run.runId, taskId: out.taskId, requestedBy: "runtime", requestedAt: this.now(), expectedVersion: version,
          reason, idempotencyKey: `cancel:${out.message.message_id}` });
        const response = await this.ports.transport.cancel(out.handle, request);
        out.error = response.ok ? "Interrupt requested; stop unconfirmed" : response.error.message;
      }
    }
    if (run.integrationKey) await this.ports.policies.git.cancelIntegration(run.integrationKey);
    for (const task of run.tasks) for (const tree of task.worktrees) await this.ports.policies.git.cancelTask(tree.key);
    this.progress(state, outbox, run, "Run cancelled; execution stop and retained worktrees require reconciliation");
    await save();
  }
}
interface VerificationJob {
  runId: string; taskId: string; plan: VerificationPlan; cycle: import("@bflow/contracts").VerificationCycle;
  change: import("@bflow/contracts").GitChangeSet; options: unknown;
}
