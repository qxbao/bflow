import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SetupReceiptSchema,
  type MachineSetupPlan,
  type SetupApplyRequest,
  type SetupReceipt,
  type SetupStep,
  type ToolInstaller,
  type ToolInstallRequest
} from "@bflow/contracts";
import {
  AssumeYesApprover,
  DOCTOR_STEP_ID,
  SetupStateStore,
  ToolInstallerRegistry,
  buildSetupPlan,
  defaultMachineConfig,
  digest,
  executePlan,
  type MachineDoctorReport,
  type PlatformProfile,
  type SetupComponent,
  type SetupContext,
  type SetupDoctor,
  type SetupPreview,
  type ToolInstallDescriptor,
  type ToolObservation
} from "../src/index.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const MID = "m-exec";
const SHA = "c".repeat(64);
const uid = typeof process.getuid === "function" ? process.getuid() : null;
let root: string;
let paths: PlatformProfile["paths"];
let store: SetupStateStore;

const platformOf = (osName: PlatformProfile["os"] = "linux"): PlatformProfile =>
  ({
    os: osName, machineId: MID, paths, supportStatus: osName === "linux" || osName === "darwin" ? "supported" : "designed_unverified"
  }) as unknown as PlatformProfile;
const runner = { run: async () => { throw new Error("no commands in executor tests"); } };
const ctxOf = (mode: SetupContext["mode"] = "apply", osName: PlatformProfile["os"] = "linux", signal?: AbortSignal): SetupContext => ({
  platform: platformOf(osName), runner, mode, now: () => NOW, ...(signal ? { signal } : {})
});

/** Controllable fake component. `state.observed` is what observe reports; apply sets it to `state.after`. */
interface FakeState {
  observed: string | null;
  after: string | null | "desired";
  applyCalls: number;
  hang?: boolean;
  throwOnApply?: boolean;
}
function fake(id: string, state: FakeState, desiredLabel = `d-${id}`): SetupComponent {
  const desired = digest(desiredLabel);
  return {
    componentId: id,
    action: id === "mcp-config" ? "register_mcp" : "configure",
    rollback: "restore_owned_config",
    observe: async () => ({ stateDigest: state.observed, valid: true, diagnostics: [] }),
    desired: async () => ({ digest: desired, summary: `configure ${id}`, targets: [`/t/${id}`], machineWide: id === "services", repairNeeded: false }),
    apply: async () => {
      state.applyCalls++;
      if (state.throwOnApply) throw new Error("boom");
      if (state.hang) return new Promise(() => undefined);
      state.observed = state.after === "desired" ? desired : state.after;
      return { ownedPaths: [`/t/${id}`], diagnostics: [] };
    }
  };
}

const healthy = (h = true): SetupDoctor => ({
  run: async (): Promise<MachineDoctorReport> => ({
    schemaVersion: 3, machineId: MID, healthy: h, checkedAt: NOW.toISOString(),
    checks: h ? [] : [{ checkId: "tool-herdr", status: "failed", summary: "herdr missing" }]
  })
});

const desc = (over: Partial<ToolInstallDescriptor> = {}): ToolInstallDescriptor => ({
  schemaVersion: 3, toolId: "pnpm", installerId: "fake-npm", method: "npm", version: "12.5.1",
  source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz", integrity: SHA, platforms: ["linux", "darwin"],
  requiresElevation: false, ...over
});
const obs = (toolId: string, status: ToolObservation["status"]): ToolObservation => ({
  toolId, status, resolvedPath: null, realPath: null, version: null, binaryDigest: null,
  pathMissingDir: null, required: true, diagnostics: []
});

/** Fake installer: installed flag flips on apply; receipts are schema-valid. */
function fakeInstaller(opts: { failApply?: boolean } = {}) {
  const st = { installed: false, applyCalls: 0, reconcileCalls: 0 };
  const receipt = (req: SetupApplyRequest, installed: boolean): SetupReceipt =>
    SetupReceiptSchema.parse({
      schemaVersion: 3, receiptId: `inst-${st.applyCalls}-${st.reconcileCalls}`, planId: req.planId, planDigest: req.planDigest,
      stepId: req.step.stepId, scope: req.step.scope, status: installed ? "applied" : "failed",
      desiredStateDigest: req.step.desiredStateDigest, observedStateDigest: installed ? req.step.desiredStateDigest : null,
      ownedPaths: installed ? ["/fake/bin/pnpm"] : [], observedAt: NOW.toISOString(), diagnostics: installed ? [] : ["not installed"],
      idempotencyKey: req.step.idempotencyKey
    });
  const installer: ToolInstaller = {
    installerId: "fake-npm",
    plan: async (req: ToolInstallRequest) => ({
      ok: true,
      value: {
        schemaVersion: 3, stepId: `install_tool:${req.toolId}`, action: "install_tool", componentId: req.toolId,
        level: "machine", scope: req.scope, dependsOn: [], desiredStateDigest: digest({ tool: req.toolId, v: req.version }),
        expectedStateDigest: null, requiresApproval: true, rollback: "remove_owned_install", toolInstall: req,
        idempotencyKey: req.idempotencyKey
      } satisfies SetupStep
    }),
    apply: async (req) => {
      st.applyCalls++;
      if (opts.failApply) return { ok: false, error: { code: "validation", retryable: false, message: "download failed" } };
      st.installed = true;
      return { ok: true, value: receipt(req, true) };
    },
    reconcile: async (req) => {
      st.reconcileCalls++;
      return { ok: true, value: receipt(req, st.installed) };
    }
  };
  return { installer, st };
}

async function planFor(components: SetupComponent[], over: { observations?: ToolObservation[]; registry?: ToolInstallerRegistry; pins?: ToolInstallDescriptor[]; mode?: SetupContext["mode"]; osName?: PlatformProfile["os"] } = {}) {
  const r = await buildSetupPlan({
    platform: platformOf(over.osName), runner, observations: over.observations ?? [],
    config: { ...defaultMachineConfig(), toolPins: over.pins ?? [] }, components,
    registry: over.registry ?? new ToolInstallerRegistry(), mode: over.mode ?? "apply", previousRevision: 0, now: () => NOW
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

async function approve(plan: MachineSetupPlan, preview: SetupPreview): Promise<string> {
  const d = await new AssumeYesApprover(store, () => NOW).approve(plan, preview);
  if (!d.approved) throw new Error(d.reason);
  return d.receipt.receiptId;
}

function exec(plan: MachineSetupPlan, components: SetupComponent[], over: Partial<Parameters<typeof executePlan>[1]> = {}) {
  return executePlan(plan, {
    store, components, registry: new ToolInstallerRegistry(), approvalReceiptId: null, ctx: ctxOf(), doctor: healthy(), ...over
  });
}
const statuses = (rs: SetupReceipt[]) => Object.fromEntries(rs.map((r) => [r.stepId, r.status]));
async function okExec(...args: Parameters<typeof exec>): Promise<SetupReceipt[]> {
  const r = await exec(...args);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bflow-exec-"));
  paths = { config: path.join(root, "c"), data: path.join(root, "d"), state: path.join(root, "s"), managedBin: path.join(root, "d", "bin") };
  store = new SetupStateStore(paths, { uid, now: () => NOW });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("executePlan", () => {
  it("happy path: installs with fake installer, applies components, runs doctor, persists receipts/journal/changes", async () => {
    const { installer, st } = fakeInstaller();
    const registry = new ToolInstallerRegistry();
    registry.register(installer);
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const s = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p), fake("services", s)];
    const { plan, preview } = await planFor(comps, { observations: [obs("pnpm", "missing")], registry, pins: [desc()] });
    const approvalReceiptId = await approve(plan, preview);
    const receipts = await okExec(plan, comps, { registry, approvalReceiptId, preview });
    expect(statuses(receipts)).toEqual({
      "install_tool:pnpm": "applied", "configure:path": "applied", "configure:services": "applied", [DOCTOR_STEP_ID]: "applied"
    });
    expect(st.applyCalls).toBe(1);
    expect(st.reconcileCalls).toBe(2); // pre-observe + read-back
    for (const r of receipts) {
      expect(SetupReceiptSchema.parse(r)).toEqual(r);
      expect(r.receiptId).toBe(`receipt-${digest({ planId: plan.planId, stepId: r.stepId, at: NOW.toISOString() }).slice(0, 24)}`);
    }
    expect(receipts.find((r) => r.stepId === "configure:path")!.approvalReceiptId).toBe(approvalReceiptId);
    const persisted = await store.readReceipts();
    expect(persisted.ok && persisted.value.map((r) => r.stepId)).toEqual(receipts.map((r) => r.stepId));
    const j = await store.readJournal();
    expect(j.ok && j.value).toMatchObject({ planId: plan.planId, planDigest: plan.planDigest, revision: 1 });
    if (j.ok && j.value) expect(Object.values(j.value.steps).every((e) => e.status === "finished")).toBe(true);
    const changes = await store.readChanges();
    expect(changes.ok && changes.value.find((c) => c.stepId === "install_tool:pnpm")).toMatchObject({ target: path.join(paths.data, "tools", "pnpm"), machineWide: true });
    if (changes.ok) {
      expect(changes.value.find((c) => c.stepId === "configure:services")).toMatchObject({ target: "/t/services", machineWide: true });
      expect(changes.value.find((c) => c.stepId === "configure:path")).toMatchObject({ target: "/t/path", machineWide: false });
    }
    // lock released
    const again = await store.acquireLock();
    expect(again.ok).toBe(true);
    if (again.ok) await again.value.release();
  });

  it("already satisfied state is not applied; rerun yields already_satisfied", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    p.observed = digest("d-path"); // satisfied after planning
    const receipts = await okExec(plan, comps, { approvalReceiptId: await approve(plan, preview), preview });
    expect(statuses(receipts)["configure:path"]).toBe("already_satisfied");
    expect(p.applyCalls).toBe(0);
  });

  it("a failed install blocks its manifest while independent configuration and doctor continue", async () => {
    const { installer } = fakeInstaller({ failApply: true });
    const registry = new ToolInstallerRegistry();
    registry.register(installer);
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p), fake("environment-manifest", { observed: null, after: "desired", applyCalls: 0 })];
    const { plan, preview } = await planFor(comps, { observations: [obs("pnpm", "missing")], registry, pins: [desc()] });
    const receipts = await okExec(plan, comps, { registry, approvalReceiptId: await approve(plan, preview), preview });
    expect(statuses(receipts)).toEqual({
      "install_tool:pnpm": "failed", "configure:path": "applied", "configure:environment-manifest": "blocked", [DOCTOR_STEP_ID]: "applied"
    });
    const failed = receipts.find((r) => r.stepId === "install_tool:pnpm")!;
    expect(failed.diagnostics.join(" ")).toContain("download failed");
    expect(receipts.find((r) => r.stepId === "configure:environment-manifest")!.diagnostics[0]).toContain("install_tool:pnpm");
    expect(p.applyCalls).toBe(1);
  });

  it("missing or foreign approval → blocked without side effects", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const none = await okExec(plan, comps, { preview });
    expect(statuses(none)["configure:path"]).toBe("blocked");
    expect(none[0]!.diagnostics.join(" ")).toContain("approval");
    const other = await planFor([fake("path", p, "other")]);
    const foreign = await approve(other.plan, other.preview);
    const bad = await okExec(plan, comps, { approvalReceiptId: foreign, preview });
    expect(statuses(bad)["configure:path"]).toBe("blocked");
    expect(p.applyCalls).toBe(0);
  });

  it("elevation install not covered by approval is blocked with manual instruction even with --yes", async () => {
    const { installer, st } = fakeInstaller();
    const registry = new ToolInstallerRegistry();
    registry.register(installer);
    const { plan, preview } = await planFor([], { observations: [obs("pnpm", "missing")], registry, pins: [desc({ requiresElevation: true })] });
    const receipts = await okExec(plan, [], { registry, approvalReceiptId: await approve(plan, preview), preview });
    const r = receipts.find((x) => x.stepId === "install_tool:pnpm")!;
    expect(r.status).toBe("blocked");
    expect(r.diagnostics[0]).toBe(`requires OS elevation; run manually: ${preview.steps[0]!.summary}`);
    expect(st.applyCalls).toBe(0);
  });

  it("drift since plan → blocked 're-plan'", async () => {
    const p = { observed: digest("before"), after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    p.observed = digest("someone-else");
    const receipts = await okExec(plan, comps, { approvalReceiptId: await approve(plan, preview), preview });
    expect(statuses(receipts)["configure:path"]).toBe("blocked");
    expect(receipts[0]!.diagnostics).toContain("state changed since plan; re-plan");
    expect(p.applyCalls).toBe(0);
  });

  it("read-back mismatch → failed", async () => {
    const p = { observed: null, after: digest("half"), applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const receipts = await okExec(plan, comps, { approvalReceiptId: await approve(plan, preview), preview });
    expect(receipts[0]).toMatchObject({ status: "failed", observedStateDigest: digest("half") });
  });

  it("throw after started → unknown", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0, throwOnApply: true } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const receipts = await okExec(plan, comps, { approvalReceiptId: await approve(plan, preview), preview });
    expect(receipts[0]!.status).toBe("unknown");
    expect(receipts[0]!.diagnostics.join(" ")).toContain("boom");
  });

  it("timeout → unknown; rerun reconciles to applied when desired state is observed", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0, hang: true } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const approvalReceiptId = await approve(plan, preview);
    const first = await okExec(plan, comps, { approvalReceiptId, preview, stepTimeoutMs: 30 });
    expect(statuses(first)).toEqual({ "configure:path": "unknown", [DOCTOR_STEP_ID]: "applied" });
    expect(first[0]!.diagnostics.join(" ")).toContain("timed out");
    const j = await store.readJournal();
    expect(j.ok && j.value!.steps["configure:path"]!.status).toBe("started");
    // the hung apply eventually completed out of band
    p.observed = digest("d-path");
    p.hang = false;
    const second = await okExec(plan, comps, { approvalReceiptId, preview });
    expect(statuses(second)["configure:path"]).toBe("applied");
    expect(second[0]!.diagnostics).toContain("reconciled after interruption");
    expect(p.applyCalls).toBe(1);
  });

  it("abort signal after start → unknown", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0, hang: true } as FakeState;
    const ac = new AbortController();
    const component = fake("path", p);
    const comps: SetupComponent[] = [{
      ...component,
      apply: async (ctx) => {
        const pending = component.apply(ctx);
        // Abort only once the mutation has actually started, independent of
        // filesystem/approval latency when the full suite runs concurrently.
        ac.abort();
        return pending;
      }
    }];
    const { plan, preview } = await planFor(comps);
    const approvalReceiptId = await approve(plan, preview);
    const receipts = await okExec(plan, comps, { approvalReceiptId, preview, ctx: ctxOf("apply", "linux", ac.signal) });
    expect(receipts[0]!.status).toBe("unknown");
    expect(receipts[0]!.diagnostics.join(" ")).toContain("aborted");
    // already aborted: nothing starts
    const again = await okExec(plan, comps, { approvalReceiptId, preview, ctx: ctxOf("apply", "linux", ac.signal) });
    expect(again[0]).toMatchObject({ status: "blocked", diagnostics: ["aborted before the step started"] });
    expect(p.applyCalls).toBe(1);
    const j = await store.readJournal();
    expect(j.ok && j.value!.steps["configure:path"]!.status).toBe("started"); // interruption marker kept
  });

  it("interrupted step (journal started, no receipt): expected state → safe retry; other state → unknown unless repair", async () => {
    const p = { observed: digest("orig"), after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const step = plan.steps.find((s) => s.stepId === "configure:path")!;
    const approvalReceiptId = await approve(plan, preview);
    const interrupted = (expected: string | null, startedAt = "2026-01-01T00:00:00.000Z") =>
      store.writeJournal({
        schemaVersion: 3, planId: "plan-old", planDigest: "e".repeat(64), revision: 7,
        steps: { "configure:path": { status: "started", startedAt, idempotencyKey: step.idempotencyKey, expectedStateDigest: expected } }
      });

    // safe retry: state still the pre-step state
    await interrupted(digest("orig"));
    const retry = await okExec(plan, comps, { approvalReceiptId, preview });
    expect(statuses(retry)["configure:path"]).toBe("applied");
    expect(p.applyCalls).toBe(1);

    // unknown state: not retried in apply
    p.observed = digest("orig");
    await interrupted(digest("something-else"), "2026-01-03T00:00:00.000Z");
    const plan2 = await planFor(comps);
    const appr2 = await approve(plan2.plan, plan2.preview);
    const unk = await okExec(plan2.plan, comps, { approvalReceiptId: appr2, preview: plan2.preview });
    expect(statuses(unk)["configure:path"]).toBe("unknown");
    expect(p.applyCalls).toBe(1);

    // repair retries it
    const plan3 = await planFor(comps, { mode: "repair" });
    const appr3 = await approve(plan3.plan, plan3.preview);
    const fixed = await okExec(plan3.plan, comps, { approvalReceiptId: appr3, preview: plan3.preview, ctx: ctxOf("repair") });
    expect(statuses(fixed)["configure:path"]).toBe("applied");
    expect(p.applyCalls).toBe(2);
    const j = await store.readJournal();
    expect(j.ok && j.value!.steps["configure:path"]!.status).toBe("finished");
  });

  it("interrupted install reconciles via installer.reconcile", async () => {
    const { installer, st } = fakeInstaller();
    const registry = new ToolInstallerRegistry();
    registry.register(installer);
    const { plan, preview } = await planFor([], { observations: [obs("pnpm", "missing")], registry, pins: [desc()] });
    const step = plan.steps[0]!;
    await store.writeJournal({
      schemaVersion: 3, planId: "plan-old", planDigest: "e".repeat(64), revision: 1,
      steps: { [step.stepId]: { status: "started", startedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: step.idempotencyKey, expectedStateDigest: null } }
    });
    st.installed = true;
    const receipts = await okExec(plan, [], { registry, approvalReceiptId: await approve(plan, preview), preview });
    expect(receipts[0]).toMatchObject({ status: "applied", diagnostics: ["reconciled after interruption"] });
    expect(st.applyCalls).toBe(0);
  });

  it("lock held by another operation → conflict, nothing executed", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps);
    const approvalReceiptId = await approve(plan, preview);
    const other = await new SetupStateStore(paths, { uid, now: () => NOW }).acquireLock();
    if (!other.ok) throw new Error("lock");
    const r = await exec(plan, comps, { approvalReceiptId, preview });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("conflict");
    expect(p.applyCalls).toBe(0);
    await other.value.release();
  });

  it("tampered plan digest → validation; check/dry_run mode refused", async () => {
    const comps = [fake("path", { observed: null, after: "desired", applyCalls: 0 })];
    const { plan } = await planFor(comps);
    const tampered = await exec({ ...plan, revision: 9 }, comps);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.error.code).toBe("validation");
    const dry = await exec(plan, comps, { ctx: ctxOf("dry_run") });
    expect(dry.ok).toBe(false);
  });

  it("windows: mutating steps blocked 'windows support not verified', doctor still runs", async () => {
    const p = { observed: null, after: "desired", applyCalls: 0 } as FakeState;
    const comps = [fake("path", p)];
    const { plan, preview } = await planFor(comps, { osName: "win32" });
    const receipts = await okExec(plan, comps, {
      approvalReceiptId: await approve(plan, preview), preview, ctx: ctxOf("apply", "win32")
    });
    expect(receipts[0]).toMatchObject({ status: "blocked", diagnostics: ["windows support not verified"] });
    expect(p.applyCalls).toBe(0);
  });

  it("doctor step: unhealthy report → failed with failing check summaries", async () => {
    const { plan } = await planFor([]);
    const receipts = await okExec(plan, [], { doctor: healthy(false) });
    expect(receipts[0]).toMatchObject({ stepId: DOCTOR_STEP_ID, status: "failed", observedStateDigest: digest({ healthy: false }) });
    expect(receipts[0]!.diagnostics).toEqual(["tool-herdr: herdr missing"]);
  });
});
