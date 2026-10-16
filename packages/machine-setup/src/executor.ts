import {
  MachineSetupPlanSchema,
  SetupApplyRequestSchema,
  SetupReceiptSchema,
  type MachineSetupPlan,
  type OperationResult,
  type SetupApplyRequest,
  type SetupReceipt,
  type SetupStep,
  type ToolInstaller
} from "@bflow/contracts";
import { digest } from "./canonical.js";
import { validationError } from "./errors.js";
import { verifyApproval } from "./approval.js";
import { BuiltinSetupDoctor, MachineDoctorReportSchema, type DoctorInput, type SetupDoctor } from "./doctor.js";
import type { ToolInstallerRegistry } from "./installer-registry.js";
import { DOCTOR_STEP_ID, type SetupPreview } from "./plan.js";
import type { SetupJournal, SetupStateStore } from "./state-store.js";
import type { SetupComponent, SetupContext } from "./types.js";

export const DEFAULT_STEP_TIMEOUT_MS = 600_000;
export const WINDOWS_NOT_VERIFIED = "windows support not verified";
export const DRIFT_DIAGNOSTIC = "state changed since plan; re-plan";
export const RECONCILED_DIAGNOSTIC = "reconciled after interruption";

export interface ExecutePlanDeps {
  store: SetupStateStore;
  components: readonly SetupComponent[];
  registry: ToolInstallerRegistry;
  /** Approval receipt written by the approver for this plan; null when none was given. */
  approvalReceiptId: string | null;
  ctx: SetupContext;
  stepTimeoutMs?: number;
  /** Preview of this plan: supplies elevation flags, summaries, targets and machine-wide flags. */
  preview?: SetupPreview;
  /** Executes the `verify:doctor` step; defaults to `BuiltinSetupDoctor`. */
  doctor?: SetupDoctor;
  /** Doctor input, resolved when the doctor step runs (so tools can be re-probed after installs). */
  doctorInput?: () => Promise<DoctorInput> | DoctorInput;
}

type Status = SetupReceipt["status"];
interface StepOutcome {
  status: Status;
  observed: string | null;
  ownedPaths: string[];
  diagnostics: string[];
  /** The outcome settles this step's journal entry (mark it `finished`). */
  resolves?: boolean;
}
type JournalEntry = SetupJournal["steps"][string];
type Bounded<T> = { kind: "ok"; value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; error: unknown };

const SUCCESS: ReadonlySet<Status> = new Set(["applied", "already_satisfied"]);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs `fn` with a deadline and the parent signal; never waits past either. */
function bounded<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<Bounded<T>> {
  if (parent?.aborted) return Promise.resolve({ kind: "aborted" });
  const ac = new AbortController();
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: Bounded<T>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = (): void => {
      ac.abort();
      settle({ kind: "aborted" });
    };
    const timer = setTimeout(() => {
      ac.abort();
      settle({ kind: "timeout" });
    }, ms);
    parent?.addEventListener("abort", onAbort, { once: true });
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn(ac.signal));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (value) => settle({ kind: "ok", value }),
      (error: unknown) => settle({ kind: "error", error })
    );
  });
}

function interruptionText(r: Exclude<Bounded<unknown>, { kind: "ok" }>, what: string, ms: number, suffix = "; state unknown"): string {
  if (r.kind === "timeout") return `${what} timed out after ${ms}ms${suffix}`;
  if (r.kind === "aborted") return `${what} aborted${suffix}`;
  return `${what} threw: ${msg(r.error)}${suffix}`;
}

/** Plan validation: schema, recomputed digest, derived planId. */
export function validatePlan(raw: unknown): OperationResult<MachineSetupPlan> {
  const parsed = MachineSetupPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: validationError(`invalid setup plan: ${parsed.error.message}`) };
  const { planId, planDigest, ...body } = parsed.data;
  if (digest(body) !== planDigest) return { ok: false, error: validationError("setup plan digest mismatch") };
  if (planId !== `plan-${planDigest.slice(0, 16)}`) return { ok: false, error: validationError("setup plan id does not match its digest") };
  return { ok: true, value: parsed.data };
}

interface Observed {
  digest: string | null;
  satisfied: boolean;
  diagnostics: string[];
}

class PlanRun {
  private readonly results = new Map<string, SetupReceipt>();
  private readonly timeoutMs: number;
  private readonly byId: Map<string, SetupComponent>;

  constructor(
    private readonly plan: MachineSetupPlan,
    private readonly deps: ExecutePlanDeps,
    private readonly journal: SetupJournal,
    /** Interrupted entries carried over from earlier runs, keyed by idempotencyKey. */
    private readonly pending: Map<string, JournalEntry>
  ) {
    this.timeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.byId = new Map(deps.components.map((c) => [c.componentId, c]));
  }

  private get ctx(): SetupContext {
    return this.deps.ctx;
  }

  async execute(): Promise<OperationResult<SetupReceipt[]>> {
    const out: SetupReceipt[] = [];
    for (const step of this.plan.steps) {
      let outcome: StepOutcome;
      try {
        outcome = await this.step(step);
      } catch (e) {
        outcome = { status: "unknown", observed: null, ownedPaths: [], diagnostics: [`executor error: ${msg(e)}`] };
      }
      const receipt = await this.finish(step, outcome);
      if (!receipt.ok) return receipt;
      out.push(receipt.value);
    }
    return { ok: true, value: out };
  }

  private previewOf(step: SetupStep) {
    return this.deps.preview?.steps.find((s) => s.stepId === step.stepId);
  }

  private async finish(step: SetupStep, o: StepOutcome): Promise<OperationResult<SetupReceipt>> {
    const diagnostics = [...o.diagnostics];
    const entry = this.journal.steps[step.stepId];
    if (entry && o.resolves && entry.status === "started") {
      this.journal.steps[step.stepId] = { ...entry, status: "finished" };
      const w = await this.deps.store.writeJournal(this.journal);
      if (!w.ok) diagnostics.push(`journal could not be updated: ${w.error.message}`);
    }
    const at = this.ctx.now().toISOString();
    const status: Status = SUCCESS.has(o.status) && o.observed !== step.desiredStateDigest ? "failed" : o.status;
    const parsed = SetupReceiptSchema.safeParse({
      schemaVersion: 3,
      receiptId: `receipt-${digest({ planId: this.plan.planId, stepId: step.stepId, at }).slice(0, 24)}`,
      planId: this.plan.planId,
      planDigest: this.plan.planDigest,
      stepId: step.stepId,
      scope: step.scope,
      status,
      desiredStateDigest: step.desiredStateDigest,
      observedStateDigest: o.observed,
      ownedPaths: [...new Set(o.ownedPaths.filter((p) => p.trim() !== ""))],
      ...(step.requiresApproval && this.deps.approvalReceiptId && status !== "blocked"
        ? { approvalReceiptId: this.deps.approvalReceiptId }
        : {}),
      observedAt: at,
      diagnostics: diagnostics.filter((d) => d.trim() !== ""),
      idempotencyKey: step.idempotencyKey
    });
    if (!parsed.success) return { ok: false, error: validationError(`executor built an invalid receipt: ${parsed.error.message}`) };
    const receipt = parsed.data;
    const a = await this.deps.store.appendReceipt(receipt);
    if (!a.ok) return { ok: false, error: a.error };
    this.results.set(step.stepId, receipt);
    if (receipt.status === "applied" && step.action !== "verify") {
      const pv = this.previewOf(step);
      const targets = pv ? pv.targets : receipt.ownedPaths;
      const machineWide = pv ? pv.machineWide : step.action === "install_tool";
      for (const target of targets) {
        const c = await this.deps.store.appendChange({
          at, planId: this.plan.planId, stepId: step.stepId, kind: step.action, target, machineWide
        });
        if (!c.ok) return { ok: false, error: c.error };
      }
    }
    return { ok: true, value: receipt };
  }

  private blocked(...diagnostics: string[]): StepOutcome {
    return { status: "blocked", observed: null, ownedPaths: [], diagnostics };
  }

  private async step(step: SetupStep): Promise<StepOutcome> {
    for (const dep of step.dependsOn) {
      const r = this.results.get(dep);
      if (!r || !SUCCESS.has(r.status)) return this.blocked(`dependency ${dep} is ${r ? r.status : "missing"}`);
    }
    const platform = this.ctx.platform;
    if (platform.supportStatus !== "supported" && step.action !== "verify") {
      return this.blocked(platform.os === "win32" ? WINDOWS_NOT_VERIFIED : `platform ${platform.os} is not supported`);
    }
    if (step.stepId === DOCTOR_STEP_ID) return this.doctor(step);

    let approvalReceiptId: string | undefined;
    if (step.requiresApproval) {
      const pv = this.previewOf(step);
      const elevation = `requires OS elevation; run manually: ${pv?.summary ?? step.stepId}`;
      if (!this.deps.approvalReceiptId) return this.blocked(pv?.requiresElevation ? elevation : "approval required; no approval receipt");
      const v = await verifyApproval(this.deps.store, this.plan, step, this.deps.approvalReceiptId);
      if (!v.ok) {
        const notCovered = v.error.message.includes("not covered");
        return this.blocked(pv?.requiresElevation && notCovered ? elevation : `approval not verified: ${v.error.message}`);
      }
      approvalReceiptId = this.deps.approvalReceiptId;
    }

    const target = this.target(step, approvalReceiptId);
    if (!target.ok) return { status: "failed", observed: null, ownedPaths: [], diagnostics: [target.error] };
    const t = target.value;

    const before = await t.observe();
    if (before.kind === "aborted") return this.blocked("aborted before the step started");
    if (before.kind !== "ok") {
      return { status: "failed", observed: null, ownedPaths: [], diagnostics: [interruptionText(before, "pre-apply observation", this.timeoutMs)] };
    }
    const obs = before.value;

    // Resume an interrupted attempt of this very step (same idempotency key) before anything else.
    let retryUnknown = false;
    const pend = this.pending.get(step.idempotencyKey);
    if (pend) {
      this.journal.steps[step.stepId] = pend;
      if (obs.satisfied) {
        return { status: "applied", observed: obs.digest, ownedPaths: [], diagnostics: [RECONCILED_DIAGNOSTIC], resolves: true };
      }
      const safe = pend.expectedStateDigest !== undefined && obs.digest === pend.expectedStateDigest;
      if (!safe) {
        if (this.ctx.mode !== "repair") {
          return {
            status: "unknown",
            observed: obs.digest,
            ownedPaths: [],
            diagnostics: ["state after an interrupted attempt is unknown; not retried; run setup --repair", ...obs.diagnostics]
          };
        }
        retryUnknown = true;
      }
    }

    if (obs.satisfied) return { status: "already_satisfied", observed: obs.digest, ownedPaths: [], diagnostics: [], resolves: true };
    if (!retryUnknown && obs.digest !== step.expectedStateDigest) {
      return { status: "blocked", observed: obs.digest, ownedPaths: [], diagnostics: [DRIFT_DIAGNOSTIC] };
    }
    if (this.ctx.signal?.aborted) return this.blocked("aborted before the step started");

    this.journal.steps[step.stepId] = {
      status: "started",
      startedAt: this.ctx.now().toISOString(),
      idempotencyKey: step.idempotencyKey,
      expectedStateDigest: obs.digest
    };
    const jw = await this.deps.store.writeJournal(this.journal);
    if (!jw.ok) {
      delete this.journal.steps[step.stepId];
      return { status: "failed", observed: obs.digest, ownedPaths: [], diagnostics: [`journal could not be persisted; step not started: ${jw.error.message}`] };
    }

    const applied = await t.apply();
    if (applied.kind !== "ok") {
      return { status: "unknown", observed: null, ownedPaths: [], diagnostics: [interruptionText(applied, "apply", this.timeoutMs)] };
    }
    if (applied.value.unknown) {
      return { status: "unknown", observed: null, ownedPaths: applied.value.ownedPaths, diagnostics: applied.value.diagnostics };
    }
    const after = await t.observe();
    if (after.kind !== "ok") {
      return {
        status: "unknown",
        observed: null,
        ownedPaths: applied.value.ownedPaths,
        diagnostics: [...applied.value.diagnostics, interruptionText(after, "read-back", this.timeoutMs)]
      };
    }
    const rb = after.value;
    if (rb.satisfied) {
      return { status: "applied", observed: rb.digest, ownedPaths: applied.value.ownedPaths, diagnostics: applied.value.diagnostics, resolves: true };
    }
    return {
      status: "failed",
      observed: rb.digest,
      ownedPaths: applied.value.ownedPaths,
      diagnostics: [...applied.value.diagnostics, ...rb.diagnostics, "read-back state does not match the desired state"],
      resolves: true
    };
  }

  /** Step-specific observe/apply, both bounded by the step timeout and the run signal. */
  private target(
    step: SetupStep,
    approvalReceiptId: string | undefined
  ): { ok: true; value: { observe(): Promise<Bounded<Observed>>; apply(): Promise<Bounded<{ ownedPaths: string[]; diagnostics: string[]; unknown?: boolean }>> } } | { ok: false; error: string } {
    const ms = this.timeoutMs;
    const parent = this.ctx.signal;
    if (step.action === "install_tool") {
      const ti = step.toolInstall;
      const installer: ToolInstaller | null = ti ? this.deps.registry.get(ti.installerId) : null;
      if (!ti || !installer) return { ok: false, error: `no installer registered for ${ti?.installerId ?? step.stepId}` };
      const req = SetupApplyRequestSchema.safeParse({
        schemaVersion: 3, planId: this.plan.planId, planDigest: this.plan.planDigest, step,
        ...(approvalReceiptId ? { approvalReceiptId } : {})
      });
      if (!req.success) return { ok: false, error: `invalid apply request: ${req.error.message}` };
      const request: SetupApplyRequest = req.data;
      const reconcile = (): Promise<Bounded<Observed>> =>
        bounded(async (signal) => {
          const r = await installer.reconcile(request, { signal, timeoutMs: ms });
          if (!r.ok) return { digest: null, satisfied: false, diagnostics: [`reconcile: ${r.error.message}`] };
          const p = SetupReceiptSchema.safeParse(r.value);
          if (!p.success) return { digest: null, satisfied: false, diagnostics: ["installer returned an invalid reconcile receipt"] };
          const d = p.data.observedStateDigest;
          return {
            digest: d,
            satisfied: SUCCESS.has(p.data.status) && d === step.desiredStateDigest && p.data.stepId === step.stepId,
            diagnostics: p.data.diagnostics
          };
        }, ms, parent);
      return {
        ok: true,
        value: {
          observe: reconcile,
          apply: () =>
            bounded(async (signal) => {
              const r = await installer.apply(request, { signal, timeoutMs: ms });
              if (!r.ok) {
                return { ownedPaths: [], diagnostics: [`install failed: ${r.error.message}`], unknown: r.error.code === "timeout" };
              }
              const p = SetupReceiptSchema.safeParse(r.value);
              if (!p.success) return { ownedPaths: [], diagnostics: ["installer returned an invalid receipt"] };
              return { ownedPaths: p.data.ownedPaths, diagnostics: p.data.diagnostics };
            }, ms, parent)
        }
      };
    }
    const comp = this.byId.get(step.componentId);
    if (!comp) return { ok: false, error: `no setup component registered for ${step.componentId}` };
    const ctxWith = (signal: AbortSignal): SetupContext => ({ ...this.ctx, signal });
    return {
      ok: true,
      value: {
        observe: () =>
          bounded(async (signal) => {
            const o = await comp.observe(ctxWith(signal));
            return { digest: o.stateDigest, satisfied: o.valid && o.stateDigest === step.desiredStateDigest, diagnostics: o.diagnostics };
          }, ms, parent),
        apply: () => bounded(async (signal) => comp.apply(ctxWith(signal)), ms, parent)
      }
    };
  }

  private async doctor(step: SetupStep): Promise<StepOutcome> {
    const doctor = this.deps.doctor ?? new BuiltinSetupDoctor();
    const r = await bounded(async () => {
      const input: DoctorInput = this.deps.doctorInput
        ? await this.deps.doctorInput()
        : { machineId: this.plan.machineId, observations: [], configStatus: "valid", components: this.deps.components };
      return doctor.run(this.ctx, input);
    }, this.timeoutMs, this.ctx.signal);
    if (r.kind !== "ok") {
      return { status: "failed", observed: null, ownedPaths: [], diagnostics: [interruptionText(r, "doctor", this.timeoutMs, "")] };
    }
    const report = MachineDoctorReportSchema.safeParse(r.value);
    if (!report.success) return { status: "failed", observed: null, ownedPaths: [], diagnostics: ["doctor returned an invalid report"] };
    const observed = digest({ healthy: report.data.healthy });
    const failing = report.data.checks.filter((c) => c.status === "failed").map((c) => `${c.checkId}: ${c.summary}`);
    return {
      status: observed === step.desiredStateDigest ? "applied" : "failed",
      observed,
      ownedPaths: [],
      diagnostics: failing
    };
  }
}

/**
 * Executes a validated plan step by step under the setup lock. Operational failures are
 * reported in receipts; the result is an error only for invalid input, lock conflicts and
 * persistence failures.
 */
export async function executePlan(planInput: unknown, deps: ExecutePlanDeps): Promise<OperationResult<SetupReceipt[]>> {
  const ctx = deps.ctx;
  if (ctx.mode !== "apply" && ctx.mode !== "repair") {
    return { ok: false, error: validationError(`setup plans are not executed in ${ctx.mode} mode`) };
  }
  const v = validatePlan(planInput);
  if (!v.ok) return v;
  const plan = v.value;
  if (plan.machineId !== ctx.platform.machineId) {
    return { ok: false, error: validationError("setup plan is for a different machine") };
  }
  const lock = await deps.store.acquireLock();
  if (!lock.ok) return lock;
  try {
    const prior = await deps.store.readJournal();
    if (!prior.ok && ctx.mode !== "repair") {
      return { ok: false, error: validationError(`setup journal unreadable (${prior.error.message}); run setup --repair`) };
    }
    const pending = new Map<string, JournalEntry>();
    const keys = new Set(plan.steps.map((s) => s.idempotencyKey));
    if (prior.ok && prior.value) {
      for (const entry of Object.values(prior.value.steps)) {
        if (entry.status !== "started" || !keys.has(entry.idempotencyKey)) continue;
        const latest = await deps.store.latestReceipt(entry.idempotencyKey);
        const resolved =
          latest.ok && latest.value !== null && latest.value.status !== "unknown" &&
          Date.parse(latest.value.observedAt) >= Date.parse(entry.startedAt);
        if (!resolved) pending.set(entry.idempotencyKey, entry);
      }
    }
    const journal: SetupJournal = {
      schemaVersion: 3,
      planId: plan.planId,
      planDigest: plan.planDigest,
      revision: plan.revision,
      steps: {}
    };
    for (const step of plan.steps) {
      const e = pending.get(step.idempotencyKey);
      if (e) journal.steps[step.stepId] = e;
    }
    const w = await deps.store.writeJournal(journal);
    if (!w.ok) return w;
    return await new PlanRun(plan, deps, journal, pending).execute();
  } finally {
    await lock.value.release();
  }
}
