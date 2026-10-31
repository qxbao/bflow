import { randomUUID } from "node:crypto";
import {
  AgentExecutionHandleSchema,
  AgentMessageSchema,
  AgentReconciliationRequestSchema,
  AgentReconciliationResultSchema,
  AgentRequestSchema,
  AgentSubmissionReceiptSchema,
  AgentTargetLocatorSchema,
  AgentTransportCapabilitiesSchema,
  AgentTransportInitializationSchema,
  AgentTransportObservationSchema,
  CancellationRequestSchema,
  CancellationResultSchema
} from "@bflow/contracts";
import type {
  AgentExecutionHandle, AgentMessage, AgentReadOptions, AgentReconciliationRequest, AgentReconciliationResult,
  AgentRequest, AgentSubmissionReceipt, AgentTargetLocator, AgentTransport, AgentTransportCapabilities,
  AgentTransportInitialization, AgentTransportObservation, AgentWaitOptions, CancellationRequest,
  CancellationResult, ContractError, OperationOptions, OperationResult
} from "@bflow/contracts";
import { HerdrProtocolError, parseAgentResult, parseCliError, parseHerdrResponse } from "./protocol.js";
import type { HerdrAgentInfo } from "./protocol.js";
import { createProcessRunner, validArguments } from "./runner.js";
import type { CommandOutcome, HerdrCommandRunner } from "./runner.js";
import { operationBudget } from "./operation-budget.js";
import { SingleFlight } from "./single-flight.js";

const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const fail = <T>(error: ContractError): OperationResult<T> => ({ ok: false, error });
const validation = (message: string): ContractError => ({ code: "validation", retryable: false, message });
const conflict = (message: string): ContractError => ({ code: "conflict", retryable: true, message });
const unavailable = (message: string): ContractError => ({ code: "transport_unavailable", retryable: true, message });
const now = (clock: () => Date) => clock().toISOString();

export interface HerdrAdapterOptions {
  readonly runner?: HerdrCommandRunner;
  readonly binary?: string;
  readonly clock?: () => Date;
  readonly defaultTimeoutMs?: number;
}

export interface HerdrStartRequest {
  readonly name: string;
  readonly kind: string;
  readonly paneId: string;
  readonly timeoutMs?: number;
  readonly args?: readonly string[];
}

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown): OperationResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail(validation(parsed.error.message));
}

function mapFailure(outcome: CommandOutcome): ContractError | null {
  if (outcome.failure === "invalid_arguments") return validation(outcome.cause ?? "CLI arguments must be strings without NUL characters");
  if (outcome.failure === "runner") return { code: "corruption", retryable: false, message: "Herdr runner failed unexpectedly" };
  if (outcome.failure === "aborted") return { code: "cancelled", retryable: false, message: "Herdr operation aborted" };
  if (outcome.failure === "timeout") return { code: "timeout", retryable: true, retrySafety: outcome.started === false ? "not_started" : "observation_only", message: "Herdr operation timed out" };
  if (outcome.failure === "output_limit") return { code: "corruption", retryable: false, message: "Herdr output exceeded configured limit" };
  if (outcome.failure === "spawn") return unavailable(outcome.cause ?? "Herdr CLI unavailable");
  const remote = parseCliError(outcome);
  if (!remote) return null;
  if (remote.kind === "malformed") return { code: "corruption", retryable: false, message: remote.message };
  if (remote.code === "agent_blocked" || remote.code === "agent_not_ready") return conflict("Herdr agent is blocked or not ready");
  if (remote.code === "timeout") return { code: "timeout", retryable: true, retrySafety: "observation_only", message: remote.message };
  if (remote.code === "invalid_target" || remote.code === "agent_not_found" || remote.code === "pane_not_found" || remote.code === "agent_not_running") return { code: "not_found", retryable: false, message: remote.message };
  if (remote.code === "unsupported_version") return { code: "unsupported_version", retryable: false, supportedVersions: [22], receivedVersion: 0, message: remote.message };
  return unavailable(`Herdr ${remote.code ?? "error"}: ${remote.message}`);
}

function targetFromAgent(info: HerdrAgentInfo, agentId: string, prior?: AgentTargetLocator): AgentTargetLocator {
  return AgentTargetLocatorSchema.parse({
    transport: "herdr", agentId, workspaceId: info.workspaceId, tabId: info.tabId,
    paneId: info.paneId, terminalId: info.terminalId, ...(info.session && { session: info.session }),
    ...(prior?.worktreeId && { worktreeId: prior.worktreeId }),
    ...(prior?.worktreePath && { worktreePath: prior.worktreePath }),
    ...(prior?.providerData !== undefined && { providerData: prior.providerData })
  });
}

function matchesTarget(target: AgentTargetLocator, info: HerdrAgentInfo): boolean {
  return target.paneId === info.paneId &&
    (target.workspaceId === undefined || target.workspaceId === info.workspaceId) &&
    (target.tabId === undefined || target.tabId === info.tabId) &&
    (target.terminalId === undefined || target.terminalId === info.terminalId) &&
    (info.name !== null ? info.name === target.agentId : info.agent === target.agentId) &&
    (target.session === undefined || (info.session !== undefined &&
      target.session.source === info.session.source && target.session.kind === info.session.kind && target.session.value === info.session.value));
}

function continuity(target: AgentTargetLocator, info: HerdrAgentInfo): "match" | "mismatch" | "insufficient" {
  const { session: _session, ...locator } = target;
  if (!matchesTarget(locator, info)) return "mismatch";
  if (target.session === undefined || info.session === undefined) return "insufficient";
  return matchesTarget(target, info) ? "match" : "mismatch";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])
  );
  return value;
}

const uncertain = (message: string): ContractError => ({
  code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message
});

export class HerdrCliTransport implements AgentTransport {
  readonly #runner: HerdrCommandRunner;
  readonly #clock: () => Date;
  readonly #defaultTimeoutMs: number;
  readonly #receipts = new Map<string, { fingerprint: string; target: AgentTargetLocator; receipt: AgentSubmissionReceipt }>();
  readonly #submissions = new SingleFlight<AgentSubmissionReceipt>();
  readonly #cancellations = new SingleFlight<CancellationResult>();

  constructor(options: HerdrAdapterOptions = {}) {
    this.#runner = options.runner ?? createProcessRunner(options.binary);
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  #timeout(options?: OperationOptions): number {
    const deadline = options?.deadline === undefined ? Infinity : Date.parse(options.deadline) - this.#clock().getTime();
    return Math.min(options?.timeoutMs ?? this.#defaultTimeoutMs, deadline);
  }

  async #run(args: readonly string[], options?: OperationOptions): Promise<CommandOutcome> {
    if (!validArguments(args)) return { exitCode: null, stdout: "", stderr: "", failure: "invalid_arguments", started: false };
    if (options?.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", failure: "aborted", started: false };
    const timeoutMs = this.#timeout(options);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: false };
    try { return await this.#runner.run({ args, ...(options?.signal && { signal: options.signal }), timeoutMs }); }
    catch { return { exitCode: null, stdout: "", stderr: "", failure: "runner" }; }
  }

  async #inspect(target: AgentTargetLocator, options?: OperationOptions, executionSpecific = false): Promise<OperationResult<HerdrAgentInfo>> {
    if (target.transport !== "herdr" || !target.paneId) return fail(validation("Herdr requires a paneId locator"));
    const outcome = await this.#run(["agent", "get", target.paneId], options);
    const error = mapFailure(outcome);
    if (error) return fail(error);
    try {
      const info = parseAgentResult(outcome, "agent_info");
      const checked = continuity(target, info);
      if (checked === "mismatch") return fail(conflict("Herdr pane occupant or session changed"));
      if ((executionSpecific || target.session !== undefined) && checked === "insufficient") return fail(uncertain("Session continuity is unresolved; inspect the agent session before execution-specific control"));
      return ok(info);
    } catch (error) {
      return fail({ code: "corruption", retryable: false, message: error instanceof Error ? error.message : "Invalid Herdr response" });
    }
  }

  async initialize(initialization: AgentTransportInitialization, options?: OperationOptions): Promise<OperationResult<AgentTransportCapabilities>> {
    const input = parseInput(AgentTransportInitializationSchema, initialization);
    if (!input.ok) return input;
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    options = budget.value;
    const version = await this.#run(["--version"], options);
    const versionError = mapFailure(version);
    if (versionError) return fail(versionError);
    // CLI release labels are diagnostic, not a compatibility contract. Probe the wire schema instead.
    const cliVersion = version.stdout.trim().split(/\r?\n/, 1)[0];
    if (!cliVersion || !/^herdr\b/i.test(cliVersion)) return fail({ code: "corruption", retryable: false, message: "Malformed Herdr version" });
    const schema = await this.#run(["api", "schema"], options);
    const schemaError = mapFailure(schema);
    if (schemaError) return fail(schemaError);
    const protocol = /protocol:\s*(\d+)/.exec(schema.stdout);
    const schemaVersion = /schema_version:\s*(\d+)/.exec(schema.stdout);
    if (!protocol || !schemaVersion) return fail({ code: "corruption", retryable: false, message: "Malformed Herdr schema summary" });
    if (Number(protocol[1]) !== 22 || Number(schemaVersion[1]) !== 1) {
      return fail({ code: "unsupported_version", retryable: false, supportedVersions: [22], receivedVersion: Number(protocol[1]), message: "Unsupported Herdr protocol/schema version" });
    }
    return ok(AgentTransportCapabilitiesSchema.parse({
      transportName: "herdr", protocolVersion: protocol[1], supportsStreaming: false,
      supportsCancellation: true, supportsResume: false, supportsSubmissionCorrelation: false,
      metadata: { cliVersion, schemaVersion: schemaVersion[1] }
    }));
  }

  async startAgent(request: HerdrStartRequest, options?: OperationOptions): Promise<OperationResult<AgentTargetLocator>> {
    if (request === null || typeof request !== "object" || typeof request.name !== "string" ||
      typeof request.kind !== "string" || typeof request.paneId !== "string" ||
      !request.name || !request.kind || !request.paneId || request.name.startsWith("-")) return fail(validation("name, kind, and existing paneId are required"));
    if (request.args !== undefined && !validArguments(request.args)) return fail(validation("Startup arguments must be strings without NUL characters"));
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 3_000 || request.timeoutMs > 300_000)) return fail(validation("Herdr startup timeout must be between 3001 and 300000 ms"));
    const args = ["agent", "start", request.name, "--kind", request.kind, "--pane", request.paneId];
    if (request.timeoutMs !== undefined) args.push("--timeout", String(request.timeoutMs));
    if (request.args?.length) args.push("--", ...request.args);
    const startupOptions = { ...options, timeoutMs: options?.timeoutMs ?? (request.timeoutMs ?? 30_000) + 1_000 };
    const budget = operationBudget(startupOptions, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    const outcome = await this.#run(args, budget.value);
    const error = mapFailure(outcome);
    if (error) return fail(outcome.started === false
      ? error : uncertain("Startup may have launched an agent; inspect this pane/session before retrying"));
    try {
      const info = parseAgentResult(outcome, "agent_started");
      if (info.paneId !== request.paneId || (info.name !== null ? info.name !== request.name : info.agent !== request.name)) {
        return fail(uncertain("Herdr startup acknowledged a different occupant; inspect the pane before retrying"));
      }
      if (info.agentStatus === "blocked") return fail(conflict("Herdr agent is blocked after startup"));
      return ok(targetFromAgent(info, request.name));
    } catch { return fail(uncertain("Startup acknowledgement is invalid; inspect this pane/session before retrying")); }
  }

  async send(request: AgentRequest, options?: OperationOptions): Promise<OperationResult<AgentSubmissionReceipt>> {
    const input = parseInput(AgentRequestSchema, request);
    if (!input.ok) return input;
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    request = input.value;
    const fingerprint = JSON.stringify(canonical(request));
    return this.#submissions.execute(request.idempotency.key, fingerprint,
      () => this.#send(request, fingerprint, budget.value),
      () => this.#unknownSubmission(request, fingerprint, "Submission failed unexpectedly; reconcile before retrying"),
      { options: budget.value, clock: this.#clock, interrupted: () => fail(uncertain("Duplicate submission wait ended; reconcile the original operation before retrying")) });
  }

  #unknownSubmission(request: AgentRequest, fingerprint: string, reason: string): OperationResult<AgentSubmissionReceipt> {
    const receipt = AgentSubmissionReceiptSchema.parse({ status: "unknown_delivery", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target, observedAt: now(this.#clock), reason, resendAllowed: false, manualInterventionRequired: true });
    this.#receipts.set(request.idempotency.key, { fingerprint, target: structuredClone(request.target), receipt: structuredClone(receipt) });
    return ok(receipt);
  }

  async #send(request: AgentRequest, fingerprint: string, options: OperationOptions): Promise<OperationResult<AgentSubmissionReceipt>> {
    const cached = this.#receipts.get(request.idempotency.key);
    if (cached) return cached.fingerprint === fingerprint ? ok(structuredClone(cached.receipt)) : fail(conflict("Idempotency key reused with different prompt"));
    if (!validArguments([request.instruction, request.target.paneId ?? ""])) return fail(validation("CLI arguments must not contain NUL characters"));
    const inspected = await this.#inspect(request.target, options);
    if (!inspected.ok) return inspected;
    const submissionTarget = targetFromAgent(inspected.value, request.target.agentId, request.target);
    if (request.workingDirectory !== undefined && request.workingDirectory !== inspected.value.cwd && request.workingDirectory !== inspected.value.foregroundCwd) return fail(conflict("Herdr agent working directory does not match request"));
    if (inspected.value.agentStatus === "blocked") {
      const receipt = AgentSubmissionReceiptSchema.parse({ status: "rejected", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: now(this.#clock), reason: "Agent is blocked" });
      this.#receipts.set(request.idempotency.key, { fingerprint, target: structuredClone(request.target), receipt: structuredClone(receipt) });
      return ok(receipt);
    }
    const outcome = await this.#run(["agent", "prompt", request.target.paneId!, request.instruction], options);
    const error = mapFailure(outcome);
    if (error) {
      if (outcome.started === false) return fail(error);
      const remote = parseCliError(outcome);
      if (remote?.code === "agent_blocked") {
        const receipt = AgentSubmissionReceiptSchema.parse({ status: "rejected", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: now(this.#clock), reason: "Agent is blocked" });
        this.#receipts.set(request.idempotency.key, { fingerprint, target: structuredClone(request.target), receipt: structuredClone(receipt) });
        return ok(receipt);
      }
      return this.#unknownSubmission(request, fingerprint, error.message);
    }
    try {
      const info = parseAgentResult(outcome, "agent_prompted");
      const checked = continuity(submissionTarget, info);
      if (checked === "mismatch" || (submissionTarget.session !== undefined && checked === "insufficient")) {
        throw new HerdrProtocolError("Pane occupant changed or session evidence disappeared during prompt submission", "malformed");
      }
      const handle = AgentExecutionHandleSchema.parse({ executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: targetFromAgent(info, request.target.agentId, request.target), correlation: { token: request.requestId, provenance: "orchestrator", verified: false }, acceptedAt: now(this.#clock) });
      const receipt = AgentSubmissionReceiptSchema.parse({ status: "accepted", requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: now(this.#clock), handle });
      this.#receipts.set(request.idempotency.key, { fingerprint, target: structuredClone(request.target), receipt: structuredClone(receipt) });
      return ok(receipt);
    } catch (error) {
      return this.#unknownSubmission(request, fingerprint, error instanceof Error ? error.message : "Invalid prompt acknowledgement");
    }
  }

  async reconcile(request: AgentReconciliationRequest, options?: OperationOptions): Promise<OperationResult<AgentReconciliationResult>> {
    const input = parseInput(AgentReconciliationRequestSchema, request);
    if (!input.ok) return input;
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    options = budget.value;
    request = input.value;
    const cachedEntry = this.#receipts.get(request.idempotencyKey);
    const cached = cachedEntry?.receipt;
    if (cached && (cached.requestId !== request.requestId || cached.attemptId !== request.attemptId || cached.runId !== request.runId || cached.taskId !== request.taskId)) return fail(conflict("Reconciliation identity differs from recorded submission"));
    if (cachedEntry && JSON.stringify(canonical(cachedEntry.target)) !== JSON.stringify(canonical(request.target))) return fail(conflict("Reconciliation target differs from recorded submission"));
    if (cached && cached.status === "accepted" && (
      cached.handle.target.agentId !== request.target.agentId || cached.handle.target.paneId !== request.target.paneId ||
      (request.target.session !== undefined && JSON.stringify(canonical(cached.handle.target.session)) !== JSON.stringify(canonical(request.target.session)))
    )) return fail(conflict("Reconciliation target differs from bound execution"));
    if (cached?.status === "accepted" && cached.requestId === request.requestId && cached.attemptId === request.attemptId && cached.runId === request.runId && cached.taskId === request.taskId) {
      return ok(AgentReconciliationResultSchema.parse({ status: "bound", handle: structuredClone(cached.handle) }));
    }
    if (cached?.status === "rejected") return ok(AgentReconciliationResultSchema.parse({ status: "not_delivered", requestId: request.requestId, retrySafe: true, observedAt: now(this.#clock) }));
    const inspected = await this.#inspect(request.target, options);
    if (!inspected.ok && (inspected.error.code === "validation" || inspected.error.code === "cancelled")) return inspected;
    const reason = inspected.ok ? "Herdr exposes no prompt-specific receipt" : inspected.error.message;
    return ok(AgentReconciliationResultSchema.parse({ status: "unknown_delivery", requestId: request.requestId, retrySafe: false, observedAt: now(this.#clock), reason, manualInterventionRequired: true }));
  }

  async wait(handle: AgentExecutionHandle, options?: AgentWaitOptions): Promise<OperationResult<AgentTransportObservation>> {
    const input = parseInput(AgentExecutionHandleSchema, handle);
    if (!input.ok) return input;
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    options = budget.value;
    handle = input.value;
    if (options.until !== undefined && !Array.isArray(options.until)) return fail(validation("Wait states must be an array"));
    const waitArgs: string[] = [];
    for (const state of options?.until ?? []) {
      if (!["idle", "working", "blocked", "done", "unknown"].includes(state)) return fail(validation(`Herdr cannot wait for state ${state}`));
      waitArgs.push("--until", state);
    }
    const inspected = await this.#inspect(handle.target, options, true);
    if (!inspected.ok) return inspected;
    const remainingWaitMs = this.#timeout(options);
    if (!Number.isFinite(remainingWaitMs) || remainingWaitMs <= 0) {
      return fail({ code: "timeout", retryable: true, retrySafety: "observation_only", message: "Herdr operation timed out" });
    }
    const args = ["agent", "wait", handle.target.paneId!, "--timeout", String(Math.max(1, Math.ceil(remainingWaitMs))), ...waitArgs];
    const outcome = await this.#run(args, options);
    const error = mapFailure(outcome);
    if (error) return fail(error);
    try {
      const info = parseAgentResult(outcome);
      if (continuity(handle.target, info) === "mismatch") return fail(conflict("Herdr pane occupant changed while waiting"));
      if (continuity(handle.target, info) !== "match") return fail(uncertain("Session continuity is unresolved after wait"));
      return ok(AgentTransportObservationSchema.parse({ handle, state: info.agentStatus, observedAt: now(this.#clock), ...(info.stateChangeSequence !== undefined && { stateChangeSequence: info.stateChangeSequence }), targetRevision: info.revision, correlationVerified: false }));
    } catch (error) { return fail({ code: "corruption", retryable: false, message: error instanceof Error ? error.message : "Invalid wait response" }); }
  }

  async *read(handle: AgentExecutionHandle, options?: AgentReadOptions): AsyncIterable<OperationResult<AgentMessage>> {
    const input = parseInput(AgentExecutionHandleSchema, handle);
    if (!input.ok) { yield input; return; }
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) { yield budget; return; }
    options = budget.value;
    handle = input.value;
    if ((options?.afterSequence ?? 0) > 0 || options?.resumeCursor !== undefined) { yield fail(validation("Herdr CLI read has no resumable cursor")); return; }
    const inspected = await this.#inspect(handle.target, options, true);
    if (!inspected.ok) { yield inspected; return; }
    const outcome = await this.#run(["agent", "read", handle.target.paneId!, "--source", "visible", "--lines", "80", "--format", "text"], options);
    const error = mapFailure(outcome);
    if (error) { yield fail(error); return; }
    const after = await this.#inspect(handle.target, options, true);
    if (!after.ok) { yield after; return; }
    yield ok(AgentMessageSchema.parse({ executionId: handle.executionId, sequence: 1, kind: "status", occurredAt: now(this.#clock), data: {
      source: "terminal_snapshot", text: outcome.stdout, target: handle.target,
      correlationVerified: false, executionOutputVerified: false, turnIdentity: "unresolved"
    } }));
  }

  async cancel(handle: AgentExecutionHandle, request: CancellationRequest, options?: OperationOptions): Promise<OperationResult<CancellationResult>> {
    const parsedHandle = parseInput(AgentExecutionHandleSchema, handle);
    if (!parsedHandle.ok) return parsedHandle;
    const parsedRequest = parseInput(CancellationRequestSchema, request);
    if (!parsedRequest.ok) return parsedRequest;
    handle = parsedHandle.value;
    request = parsedRequest.value;
    if (request.runId !== handle.runId || (request.taskId !== undefined && request.taskId !== handle.taskId) || (request.executionId !== undefined && request.executionId !== handle.executionId)) return fail(conflict("Cancellation does not own this execution"));
    const budget = operationBudget(options, this.#clock, this.#defaultTimeoutMs);
    if (!budget.ok) return budget;
    const fingerprint = JSON.stringify(canonical({ request, handle }));
    return this.#cancellations.execute(request.idempotencyKey, fingerprint,
      () => this.#cancel(handle, request, budget.value),
      () => fail(uncertain("Cancellation failed unexpectedly; inspect the session before retrying")),
      { options: budget.value, clock: this.#clock, interrupted: () => fail(uncertain("Duplicate cancellation wait ended; inspect the original operation before retrying")) });
  }

  async #cancel(handle: AgentExecutionHandle, request: CancellationRequest, options: OperationOptions): Promise<OperationResult<CancellationResult>> {
    const inspected = await this.#inspect(handle.target, options, true);
    if (!inspected.ok) return inspected;
    if (inspected.value.agentStatus === "done") {
      const result = ok(CancellationResultSchema.parse({ schemaVersion: 1, cancellationId: request.cancellationId, status: "refused", reason: "Herdr done cannot identify whether this execution is active or terminal", observedAt: now(this.#clock) }));
      return result;
    }
    const outcome = await this.#run(["agent", "send-keys", handle.target.paneId!, "ctrl+c"], options);
    const error = mapFailure(outcome);
    let result: OperationResult<CancellationResult>;
    if (error) result = outcome.started === false ? fail(error) : fail({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: `Cancellation command outcome is uncertain: ${error.message}` });
    else {
      try {
        if (parseHerdrResponse(outcome).type !== "ok") throw new HerdrProtocolError("Unexpected cancellation acknowledgement", "malformed");
        const after = await this.#inspect(handle.target, options, true);
        result = after.ok
          ? ok(CancellationResultSchema.parse({ schemaVersion: 1, cancellationId: request.cancellationId, status: "accepted", executionId: handle.executionId, observedAt: now(this.#clock), details: { stopConfirmed: false } }))
          : fail({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "Target changed or became unavailable after cancellation command" });
      } catch {
        result = fail({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "Malformed cancellation acknowledgement; stop not confirmed" });
      }
    }
    return result;
  }
}

export function createHerdrAdapter(options: HerdrAdapterOptions = {}): AgentTransport & Pick<HerdrCliTransport, "startAgent"> {
  return new HerdrCliTransport(options);
}
