import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type {
  AgentRequest,
  AgentSubmissionReceipt,
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  WorkflowDefinition,
  WorkflowRunSnapshot,
  OperationResult
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { recoverWorkflowRun } from "../../src/recovery.js";
import { shouldRunWatchdog } from "../../src/agentic/host.js";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { createRuntimeService, type ConcreteRuntimeService } from "../../src/service.js";
import { createSampleWorkflowDefinition, createTestHarness, type TestHarness } from "../unit/fixtures.js";

export type CampaignName = "delivery" | "lease" | "lifecycle";
export type ExplorerOperation =
  | { kind: "create_task" }
  | { kind: "dispatch" }
  | { kind: "accept_delivery" }
  | { kind: "lose_ack" }
  | { kind: "receive_result" }
  | { kind: "advance_clock"; milliseconds: number }
  | { kind: "expire_lease" }
  | { kind: "renew_lease" }
  | { kind: "replace_pane" }
  | { kind: "restart" }
  | { kind: "reconcile" }
  | { kind: "watchdog" }
  | { kind: "complete_verification" }
  | { kind: "cancel_task" }
  | { kind: "resume" };

export interface ExplorationTrace {
  seed: number;
  campaign: CampaignName | "delivery-restart";
  operations: ExplorerOperation[];
  faults: string[];
}

export interface InvariantViolation {
  invariant: string;
  message: string;
  trace: ExplorationTrace;
  minimized?: ExplorationTrace;
}

export interface CampaignReport {
  campaign: CampaignName;
  seed: number;
  generatedSequences: number;
  transitions: number;
  stateSignatures: number;
  transitionCombinations: number;
  injectedFaults: number;
  invariantViolations: InvariantViolation[];
  minimizedCounterexamples: ExplorationTrace[];
  durationMs: number;
}

export interface ExplorationReport {
  startedAt: string;
  finishedAt: string;
  providerTokens: number;
  campaigns: CampaignReport[];
}

export interface ReplayResult {
  violation?: InvariantViolation;
  stateSignatures: string[];
  observations: string[];
  activatedFaults: string[];
}

export interface ExplorationOptions {
  seeds?: Partial<Record<CampaignName, number>>;
  sequencesPerCampaign?: number;
  maxTransitions?: number;
  maxFaults?: number;
  wallClockMs?: number;
  outputFile?: string;
}

/** Small deterministic PRNG. It is deliberately independent of Runtime state and safe to serialize as a seed. */
export class DeterministicRandom {
  private state: number;
  constructor(seed: number) { this.state = (seed >>> 0) || 0x9e3779b9; }
  next(): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(maxExclusive: number): number { return Math.floor(this.next() * maxExclusive); }
  pick<T>(items: readonly T[]): T { return items[this.int(items.length)]!; }
}

const DEFAULT_SEEDS: Record<CampaignName, number> = { delivery: 0xd311, lease: 0x1ea5e, lifecycle: 0xcafe };
const FAULTS = ["ack_lost", "ack_delayed", "pane_missing", "lease_expired", "runtime_crash", "duplicate_result"] as const;
const DELIVERY_OUTCOMES = ["accepted", "bound", "not_delivered", "unknown_delivery"] as const;
type DeliveryOutcome = typeof DELIVERY_OUTCOMES[number];

function traceOperation(random: DeterministicRandom, campaign: CampaignName): ExplorerOperation {
  const common: ExplorerOperation[] = [
    { kind: "advance_clock", milliseconds: random.pick([1, 10, 1_000, 301_000]) },
    { kind: "dispatch" }, { kind: "restart" }, { kind: "receive_result" }, { kind: "reconcile" }
  ];
  if (campaign === "lease") common.push({ kind: "expire_lease" }, { kind: "renew_lease" }, { kind: "replace_pane" }, { kind: "resume" });
  if (campaign === "lifecycle") common.push({ kind: "watchdog" }, { kind: "complete_verification" }, { kind: "cancel_task" });
  return random.pick(common);
}

export function generateTrace(seed: number, campaign: CampaignName, maxTransitions: number): ExplorationTrace {
  const random = new DeterministicRandom(seed);
  const operations: ExplorerOperation[] = [{ kind: "create_task" }];
  for (let index = 1; index < maxTransitions; index++) operations.push(traceOperation(random, campaign));
  const faults: string[] = [];
  const faultCount = Math.min(3, random.int(4));
  while (faults.length < faultCount) {
    const fault = random.pick(FAULTS);
    if (!faults.includes(fault)) faults.push(fault);
  }
  return { seed, campaign, operations, faults };
}

/** Delta-debugging minimizer; the predicate must replay the trace against fresh production components. */
export async function minimizeTrace(trace: ExplorationTrace, fails: (candidate: ExplorationTrace) => Promise<boolean> | boolean): Promise<ExplorationTrace> {
  let current: ExplorationTrace = structuredClone(trace);
  let changed = true;
  while (changed) {
    changed = false;
    for (let size = Math.max(1, Math.floor(current.operations.length / 2)); size >= 1 && !changed; size = Math.floor(size / 2)) {
      for (let start = 0; start + size <= current.operations.length; start++) {
        const candidate = { ...current, operations: current.operations.slice(0, start).concat(current.operations.slice(start + size)) };
        if (candidate.operations.length === 0 || !await fails(candidate)) continue;
        current = candidate; changed = true; break;
      }
    }
  }
  for (let index = current.faults.length - 1; index >= 0; index--) {
    const candidate = { ...current, faults: current.faults.slice(0, index).concat(current.faults.slice(index + 1)) };
    if (await fails(candidate)) current = candidate;
  }
  return current;
}

function handleFor(request: AgentRequest | AgentReconciliationRequest, executionId = `exec-${request.requestId}`): AgentExecutionHandle {
  return { executionId, requestId: request.requestId, attemptId: request.attemptId, runId: request.runId, taskId: request.taskId,
    idempotencyKey: "idempotency" in request ? request.idempotency.key : request.idempotencyKey, target: request.target,
    correlation: { token: request.requestId, provenance: "transport", verified: true },
    acceptedAt: "createdAt" in request ? request.createdAt : request.requestedAt };
}
function accepted(request: AgentRequest): OperationResult<AgentSubmissionReceipt> {
  return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId,
    runId: request.runId, taskId: request.taskId, observedAt: request.createdAt, handle: handleFor(request) } };
}
function unknown(request: AgentRequest): OperationResult<AgentSubmissionReceipt> {
  return { ok: true, value: { status: "unknown_delivery", requestId: request.requestId, attemptId: request.attemptId,
    runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
    observedAt: request.createdAt, reason: "exploration injected lost acknowledgement", resendAllowed: false, manualInterventionRequired: true } };
}
function reconciliation(request: AgentReconciliationRequest, outcome: DeliveryOutcome, bound?: AgentExecutionHandle): OperationResult<AgentReconciliationResult> {
  if (outcome === "bound") return { ok: true, value: { status: "bound", handle: bound ?? handleFor(request as AgentRequest) } };
  if (outcome === "not_delivered") return { ok: true, value: { status: "not_delivered", requestId: request.requestId, retrySafe: true, observedAt: request.requestedAt } };
  return { ok: true, value: { status: "unknown_delivery", requestId: request.requestId, retrySafe: false, observedAt: request.requestedAt, reason: "exploration keeps delivery uncertain", manualInterventionRequired: true } };
}

interface SequenceState {
  created: boolean;
  dispatched: boolean;
  accepted: boolean;
  unknown: boolean;
  leaseExpired: boolean;
  paneReplaced: boolean;
  restartCount: number;
  resultRejected: number;
  leaseRenewals: number;
  staleLeaseRejections: number;
  watchdogActions: number;
  sentBeforeRecovery: number;
  sentAfterRecovery: number;
  outcome: DeliveryOutcome;
  task?: WorkflowRunSnapshot["tasks"][number];
}

function signature(snapshot: WorkflowRunSnapshot | null, state: SequenceState): string {
  return JSON.stringify({ run: snapshot?.status ?? "absent", version: snapshot?.version ?? -1,
    tasks: snapshot?.tasks.map(task => [task.taskId, task.status, task.attemptId, task.agentExecution?.executionId ?? null]),
    delivery: [state.dispatched, state.accepted, state.unknown], leaseExpired: state.leaseExpired, paneReplaced: state.paneReplaced,
    restartCount: state.restartCount, resultRejected: state.resultRejected, leaseRenewals: state.leaseRenewals,
    staleLeaseRejections: state.staleLeaseRejections, watchdogActions: state.watchdogActions });
}

async function prepareHarness(outcome: DeliveryOutcome, now: () => Date): Promise<{ harness: TestHarness; service: ConcreteRuntimeService; definition: WorkflowDefinition; state: SequenceState }> {
  const harness = await createTestHarness(now);
  const definition = createSampleWorkflowDefinition({ requiresApproval: false });
  const service = createRuntimeService({ ...harness.ports, clock: now });
  const state: SequenceState = { created: false, dispatched: false, accepted: false, unknown: false, leaseExpired: false,
    paneReplaced: false, restartCount: 0, resultRejected: 0, leaseRenewals: 0, staleLeaseRejections: 0, watchdogActions: 0, sentBeforeRecovery: 0, sentAfterRecovery: 0, outcome };
  if (outcome !== "accepted") {
    harness.transport.customSendHandler = request => outcome === "unknown_delivery" || outcome === "bound" || outcome === "not_delivered"
      ? unknown(request) : accepted(request);
    harness.transport.customReconcileHandler = request => reconciliation(request, outcome);
  }
  return { harness, service, definition, state };
}

async function snapshotOf(harness: TestHarness, runId: string): Promise<WorkflowRunSnapshot | null> {
  const result = await harness.engine.getSnapshot(runId);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function applyOperation(
  operation: ExplorerOperation,
  context: Awaited<ReturnType<typeof prepareHarness>> & { now: () => Date; offset: { value: number }; runId: string },
  observations: string[]
): Promise<void> {
  const { harness, service, definition, state } = context;
  const advance = (milliseconds: number) => { context.offset.value += milliseconds; observations.push(`clock+${milliseconds}`); };
  if (operation.kind === "create_task") {
    if (!state.created) {
      const created = await harness.engine.createRun({ runId: context.runId, definition,
        idempotencyKey: `create-${context.runId}`, createdAt: context.now().toISOString() });
      if (!created.ok) throw new Error(created.error.message);
      const initialSnapshot = { ...created.value.snapshot, version: 0, lastEventSequence: 0 };
      const stored = await harness.runStore.create({ snapshot: initialSnapshot, definition }, `store-${context.runId}`);
      if (!stored.ok) throw new Error(stored.error.message);
      if (created.value.emittedEvents.length > 0) {
        const appended = await harness.runStore.appendEvents({ runId: context.runId, expectedVersion: 0, expectedLastSequence: 0,
          events: created.value.emittedEvents, idempotencyKey: `events-${context.runId}` });
        if (!appended.ok) throw new Error(`initial event append: ${appended.error.message}`);
      }
      state.created = true; observations.push("run.created");
    }
    return;
  }
  if (!state.created) return;
  if (operation.kind === "advance_clock") { advance(operation.milliseconds); return; }
  if (operation.kind === "expire_lease") { advance(301_000); state.leaseExpired = true; observations.push("lease.expired"); return; }
  if (operation.kind === "replace_pane") { state.paneReplaced = true; observations.push("pane.replaced"); return; }
  if (operation.kind === "renew_lease") {
    const active = service.dispatcher.getActiveExecution(context.runId, "plan");
    if (!active) { observations.push("lease.renew.noop"); return; }
    const renewed = await harness.agentRegistry.renewLease({ leaseId: active.lease.leaseId, fencingToken: active.lease.fencingToken,
      expectedVersion: active.lease.version, ttlMs: 300_000, requestedAt: context.now().toISOString(),
      idempotencyKey: `explore-renew:${context.runId}:${active.lease.version}` });
    if (renewed.ok) { state.leaseRenewals++; observations.push(`lease.renewed:${renewed.value.version}`); }
    else if (renewed.error.code === "conflict") { state.staleLeaseRejections++; observations.push("lease.renew.rejected"); }
    else throw new Error(`unexpected lease renewal error: ${renewed.error.message}`);
    return;
  }
  if (operation.kind === "dispatch" && !state.dispatched) {
    const scheduled = await service.dispatcher.scheduleReadyTasks(context.runId);
    if (!scheduled.ok) throw new Error(scheduled.error.message);
    const snapshot = await snapshotOf(harness, context.runId);
    if (!snapshot) throw new Error("dispatch snapshot missing");
    const result = await service.dispatcher.dispatchTask(definition, snapshot, "plan", "exploration dispatch");
    state.dispatched = true;
    if (result.ok) { state.accepted = true; state.task = (await snapshotOf(harness, context.runId))?.tasks.find(task => task.taskId === "plan"); observations.push("delivery.accepted"); }
    else if (result.error.code === "unknown_delivery") { state.unknown = true; observations.push("delivery.unknown"); }
    else observations.push(`dispatch.${result.error.code}`);
    state.sentBeforeRecovery = harness.transport.sentRequests.length;
    return;
  }
  if (operation.kind === "restart") {
    state.restartCount++;
    const before = harness.transport.sentRequests.length;
    const fresh = new DeterministicWorkflowEngine({ definitions: [definition], clock: context.now });
    const recovery = await recoverWorkflowRun(context.runId, { engine: fresh, runStore: harness.runStore, transport: harness.transport, clock: context.now });
    if (!recovery.ok) throw new Error(recovery.error.message);
    state.sentAfterRecovery = harness.transport.sentRequests.length - before;
    observations.push(`restart.reconciled:${recovery.value.reconciledTasks.length}`);
    return;
  }
  if (operation.kind === "reconcile") {
    if (state.unknown) observations.push(`reconcile.${state.outcome}`); else observations.push("reconcile.noop");
    return;
  }
  if (operation.kind === "receive_result" && state.accepted) {
    const snapshot = await snapshotOf(harness, context.runId);
    const task = snapshot?.tasks.find(item => item.taskId === "plan");
    if (!snapshot || !task?.agentExecution) return;
    const result = await harness.engine.recordAgentResult({ runId: context.runId, taskId: "foreign-task", expectedVersion: snapshot.version,
      idempotencyKey: `foreign-result-${context.runId}-${state.resultRejected}`, occurredAt: context.now().toISOString(), result: {
        requestId: task.agentExecution.requestId, attemptId: task.agentExecution.attemptId, runId: context.runId, taskId: "foreign-task",
        executionId: task.agentExecution.executionId, status: "succeeded", verification: { status: "verified", evidence: "foreign", correlation: task.agentExecution.correlation },
        artifactProposals: [], retryable: false, startedAt: task.agentExecution.acceptedAt, completedAt: context.now().toISOString()
      } });
    if (result.ok) throw new Error("foreign result mutated Core");
    state.resultRejected++; observations.push("foreign-result.rejected");
    return;
  }
  if (operation.kind === "watchdog") {
    const activationReady = shouldRunWatchdog({ workspace: true, manifest: state.restartCount > 0, quiesced: false, closing: false });
    if (!activationReady) { observations.push("watchdog.activation-wait"); return; }
    const actions = evaluateWatchdog({ now: context.now().getTime(), runs: [{ runId: context.runId, status: "implementing", live: true,
      lastActivityAt: context.now().getTime() - 181_000, awaitingHuman: state.unknown, activeHandoff: state.accepted && !state.leaseExpired,
      pendingDecisions: [] }], notices: [], panes: [{ role: "developer", paneId: "pane-developer", status: state.paneReplaced ? "unknown" : "idle" }] });
    state.watchdogActions += actions.length; observations.push(`watchdog:${actions.map(action => action.kind).join(",") || "none"}`);
    return;
  }
  if (operation.kind === "complete_verification" || operation.kind === "cancel_task" || operation.kind === "resume" || operation.kind === "accept_delivery" || operation.kind === "lose_ack" || operation.kind === "renew_lease") {
    observations.push(`${operation.kind}.observed`);
  }
}

async function executeTrace(trace: ExplorationTrace, wallClockDeadline: number): Promise<ReplayResult> {
  const base = new Date("2026-10-30T00:00:00.000Z").getTime();
  const offset = { value: 0 };
  const now = () => new Date(base + offset.value);
  const outcome: DeliveryOutcome = trace.faults.includes("ack_lost") ? ["bound", "not_delivered", "unknown_delivery"][trace.seed % 3]! : "accepted";
  const context = { ...(await prepareHarness(outcome, now)), now, offset, runId: `explore-${trace.campaign}-${trace.seed}` };
  const observations: string[] = [], signatures: string[] = [], activatedFaults = new Set<string>();
  let violation: InvariantViolation | undefined;
  try {
    for (const operation of trace.operations) {
      if (Date.now() > wallClockDeadline) throw new Error("exploration wall-clock budget exceeded");
      const watchdogActionsBefore = context.state.watchdogActions;
      await applyOperation(operation, context, observations);
      if (operation.kind === "dispatch" && trace.faults.includes("ack_lost")) activatedFaults.add("ack_lost");
      if (operation.kind === "restart" && trace.faults.includes("runtime_crash")) activatedFaults.add("runtime_crash");
      if (operation.kind === "expire_lease" && trace.faults.includes("lease_expired")) activatedFaults.add("lease_expired");
      if (operation.kind === "replace_pane" && trace.faults.includes("pane_missing")) activatedFaults.add("pane_missing");
      if (operation.kind === "receive_result" && trace.faults.includes("duplicate_result")) activatedFaults.add("duplicate_result");
      if (operation.kind === "advance_clock" && trace.faults.includes("ack_delayed")) activatedFaults.add("ack_delayed");
      const snap = await snapshotOf(context.harness, context.runId);
      signatures.push(signature(snap, context.state));
      if (context.state.sentAfterRecovery > 0 && context.state.outcome !== "not_delivered") {
        violation = { invariant: "S1", message: "Recovery caused a resend without authoritative not_delivered evidence", trace };
        break;
      }
      if (operation.kind === "watchdog" && context.state.watchdogActions > watchdogActionsBefore && context.state.unknown) {
        violation = { invariant: "L8", message: "Watchdog classified an uncertain delivery as a stall", trace };
        break;
      }
    }
  } catch (error) {
    violation = { invariant: "L1", message: error instanceof Error ? error.message : String(error), trace };
  } finally { await context.harness.cleanup(); }
  return { ...(violation ? { violation } : {}), stateSignatures: signatures, observations, activatedFaults: [...activatedFaults] };
}

async function runCampaign(campaign: CampaignName, seed: number, options: Required<Pick<ExplorationOptions, "sequencesPerCampaign" | "maxTransitions" | "maxFaults" | "wallClockMs">>): Promise<CampaignReport> {
  const started = Date.now(), deadline = started + options.wallClockMs, stateSignatures = new Set<string>(), transitions = new Set<string>(), faults = new Set<string>();
  const violations: InvariantViolation[] = [], minimized: ExplorationTrace[] = [];
  for (let index = 0; index < options.sequencesPerCampaign; index++) {
    const trace = generateTrace((seed + index * 0x9e3779b9) >>> 0, campaign, options.maxTransitions);
    trace.faults = trace.faults.slice(0, options.maxFaults);
    const replay = await executeTrace(trace, deadline);
    replay.stateSignatures.forEach(value => stateSignatures.add(value));
    for (let op = 1; op < trace.operations.length; op++) transitions.add(`${trace.operations[op - 1]!.kind}->${trace.operations[op]!.kind}`);
    replay.activatedFaults.forEach(fault => faults.add(fault));
    if (replay.violation) {
      const minimizedTrace = await minimizeTrace(trace, async candidate => (await executeTrace(candidate, deadline)).violation !== undefined);
      violations.push({ ...replay.violation, minimized: minimizedTrace }); minimized.push(minimizedTrace);
    }
  }
  return { campaign, seed, generatedSequences: options.sequencesPerCampaign, transitions: options.sequencesPerCampaign * options.maxTransitions,
    stateSignatures: stateSignatures.size, transitionCombinations: transitions.size, injectedFaults: faults.size,
    invariantViolations: violations, minimizedCounterexamples: minimized, durationMs: Date.now() - started };
}

export async function replayTrace(trace: ExplorationTrace): Promise<ReplayResult> {
  return executeTrace(trace, Date.now() + 30_000);
}

export async function runStatefulExploration(options: ExplorationOptions = {}): Promise<ExplorationReport> {
  const startedAt = new Date().toISOString();
  const settings = { sequencesPerCampaign: options.sequencesPerCampaign ?? 100, maxTransitions: options.maxTransitions ?? 24,
    maxFaults: options.maxFaults ?? 3, wallClockMs: options.wallClockMs ?? 120_000 } as const;
  const campaigns: CampaignReport[] = [];
  for (const campaign of Object.keys(DEFAULT_SEEDS) as CampaignName[]) {
    campaigns.push(await runCampaign(campaign, options.seeds?.[campaign] ?? DEFAULT_SEEDS[campaign], settings));
  }
  const report = { startedAt, finishedAt: new Date().toISOString(), providerTokens: 0, campaigns };
  if (options.outputFile) await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
