import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MachineSetupPlanSchema, type SetupStep, type ToolInstaller, type ToolInstallRequest } from "@bflow/contracts";
import {
  AssumeYesApprover, InteractiveApprover, NonInteractiveApprover, SetupStateStore, ToolInstallerRegistry,
  buildSetupPlan, defaultMachineConfig, digest, renderPreview, verifyApproval,
  type PlatformProfile, type SetupComponent, type ToolInstallDescriptor, type ToolObservation
} from "../src/index.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const MID = "m-abc";
const SHA = "b".repeat(64);
const uid = typeof process.getuid === "function" ? process.getuid() : null;
let root: string;
let paths: PlatformProfile["paths"];

const platformOf = (osName: PlatformProfile["os"] = "linux") =>
  ({ os: osName, machineId: MID, paths }) as unknown as PlatformProfile;

const obs = (toolId: string, status: ToolObservation["status"], required = true): ToolObservation => ({
  toolId, status, resolvedPath: null, realPath: null, version: null, binaryDigest: null,
  pathMissingDir: null, required, diagnostics: []
});

function comp(id: string, over: { desired?: string; observed?: string | null; valid?: boolean; repair?: boolean; machineWide?: boolean } = {}): SetupComponent {
  const desired = digest(over.desired ?? `d-${id}`);
  return {
    componentId: id, action: id === "mcp-config" ? "register_mcp" : "configure", rollback: "restore_owned_config",
    observe: async () => ({ stateDigest: over.observed === undefined ? null : over.observed === "same" ? desired : over.observed, valid: over.valid ?? true, diagnostics: [] }),
    desired: async () => ({ digest: desired, summary: `configure ${id}`, targets: [`/t/${id}`], machineWide: over.machineWide ?? false, repairNeeded: over.repair ?? false }),
    apply: async () => { throw new Error("builder never applies"); }
  };
}

function installer(id: string, mutate?: (s: SetupStep) => unknown, fail = false): ToolInstaller {
  return {
    installerId: id,
    plan: (async (req: ToolInstallRequest) => {
      if (fail) return { ok: false, error: { code: "validation", retryable: false, message: "cannot plan" } };
      const step: SetupStep = {
        schemaVersion: 3, stepId: `install_tool:${req.toolId}`, action: "install_tool", componentId: req.toolId,
        level: "machine", scope: req.scope, dependsOn: [], desiredStateDigest: digest(req.version),
        expectedStateDigest: null, requiresApproval: true, rollback: "remove_owned_install",
        toolInstall: req, idempotencyKey: req.idempotencyKey
      };
      return { ok: true, value: (mutate ? mutate(step) : step) as SetupStep };
    }) as ToolInstaller["plan"],
    apply: (async () => ({ ok: false })) as unknown as ToolInstaller["apply"],
    reconcile: (async () => ({ ok: false })) as unknown as ToolInstaller["reconcile"]
  };
}
const desc = (over: Partial<ToolInstallDescriptor> = {}): ToolInstallDescriptor => ({
  schemaVersion: 3, toolId: "pnpm", installerId: "npm-i", method: "npm", version: "12.5.1",
  source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz", integrity: SHA, platforms: ["linux", "darwin"],
  requiresElevation: false, ...over
});

function input(over: Record<string, unknown> = {}) {
  const registry = new ToolInstallerRegistry();
  registry.register(installer("npm-i"));
  return {
    platform: platformOf(), runner: { run: async () => { throw new Error("none"); } },
    observations: [obs("node", "present"), obs("pnpm", "missing")],
    config: { ...defaultMachineConfig(), toolPins: [desc()] },
    components: [comp("services"), comp("path"), comp("mcp-config"), comp("role-skills"), comp("environment-manifest")],
    registry, mode: "dry_run" as const, previousRevision: 0, now: () => NOW, ...over
  };
}
function built(over: Record<string, unknown> = {}) {
  return buildSetupPlan(input(over) as Parameters<typeof buildSetupPlan>[0]);
}
async function okBuilt(over: Record<string, unknown> = {}) {
  const r = await built(over);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bflow-plan-"));
  paths = { config: path.join(root, "c"), data: path.join(root, "d"), state: path.join(root, "s"), managedBin: path.join(root, "bin") };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("buildSetupPlan", () => {
  it("clean machine: ordered, schema-valid plan", async () => {
    const { plan, preview } = await okBuilt();
    expect(MachineSetupPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.steps.map((s) => s.stepId)).toEqual([
      "install_tool:pnpm", "configure:path", "configure:role-skills",
      "register_mcp:mcp-config", "configure:services", "configure:environment-manifest", "verify:doctor"
    ]);
    const byId = Object.fromEntries(plan.steps.map((s) => [s.stepId, s]));
    expect(byId["configure:path"]!.dependsOn).toEqual(["install_tool:pnpm"]);
    expect(byId["configure:environment-manifest"]!.dependsOn).toEqual(plan.steps.slice(0, 5).map((s) => s.stepId));
    expect(byId["verify:doctor"]).toMatchObject({
      componentId: "doctor", action: "verify", requiresApproval: false, rollback: "none",
      dependsOn: ["configure:environment-manifest"], expectedStateDigest: null, desiredStateDigest: digest({ healthy: true })
    });
    expect(byId["configure:path"]).toMatchObject({
      requiresApproval: true, level: "machine", expectedStateDigest: null,
      idempotencyKey: `setup:${MID}:configure:path:${digest("d-path")}`
    });
    const { planDigest, planId: _planId, ...rest } = plan;
    expect(planDigest).toBe(digest(rest));
    expect(plan.planId).toBe(`plan-${planDigest.slice(0, 16)}`);
    expect(plan.revision).toBe(1);
    expect(preview.steps.find((s) => s.stepId === "install_tool:pnpm")!.summary)
      .toBe(`install pnpm 12.5.1 via npm from ${desc().source}`);
    expect(preview.steps.find((s) => s.stepId === "install_tool:pnpm")!.commandPreview).toBeUndefined();
  });

  it("satisfied machine yields only verify:doctor", async () => {
    const comps = ["path", "role-skills", "mcp-config", "services", "environment-manifest"].map((id) => comp(id, { observed: "same" }));
    const { plan, preview } = await okBuilt({ observations: [obs("node", "present")], components: comps, previousRevision: 4 });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["verify:doctor"]);
    expect(plan.steps[0]!.dependsOn).toEqual([]);
    expect(plan.revision).toBe(5);
    expect(preview.satisfied.sort()).toEqual(["environment-manifest", "mcp-config", "path", "role-skills", "services"]);
  });

  it("digest is stable and changes with desired state; expected digest from observe", async () => {
    const a = await okBuilt();
    const b = await okBuilt();
    expect(a.plan.planDigest).toBe(b.plan.planDigest);
    const c = await okBuilt({ components: [comp("path", { desired: "other", observed: digest("old") })] });
    expect(c.plan.planDigest).not.toBe(a.plan.planDigest);
    expect(c.plan.steps.find((s) => s.componentId === "path")!.expectedStateDigest).toBe(digest("old"));
  });

  it("orders by known componentId regardless of input; unknown id is a validation error", async () => {
    const { plan } = await okBuilt({ observations: [], components: [comp("services"), comp("path")] });
    expect(plan.steps.map((s) => s.componentId)).toEqual(["path", "services", "doctor"]);
    const r = await built({ components: [comp("bogus")] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("validation");
    const dup = await built({ components: [comp("path"), comp("path")] });
    expect(dup.ok).toBe(false);
  });

  it("unpinned required tool becomes manual with catalog guidance; optional missing is ignored", async () => {
    const { plan, preview } = await okBuilt({
      config: defaultMachineConfig(), observations: [obs("pnpm", "missing"), obs("codex", "missing", false)], components: []
    });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["verify:doctor"]);
    expect(preview.manual.map((m) => m.toolId)).toEqual(["pnpm"]);
    expect(preview.manual[0]!.guidance).toContain("pnpm");
  });

  it("elevation descriptor sets requiresElevation; --yes does not approve it", async () => {
    const { plan, preview } = await okBuilt({ config: { ...defaultMachineConfig(), toolPins: [desc({ requiresElevation: true })] }, components: [comp("path")] });
    expect(preview.steps.find((s) => s.stepId === "install_tool:pnpm")!.requiresElevation).toBe(true);
    expect(preview.steps.find((s) => s.stepId === "configure:path")!.requiresElevation).toBe(false);
    const store = new SetupStateStore(paths, { uid, now: () => NOW });
    const res = await new AssumeYesApprover(store, () => NOW).approve(plan, preview);
    expect(res.approved).toBe(true);
    if (res.approved) {
      expect(res.receipt.approvedBy).toBe("assume_yes");
      expect(res.receipt.stepIds).toEqual(["configure:path"]);
    }
  });

  it("installer step violations and installer failure", async () => {
    const bad: [string, (s: SetupStep) => unknown][] = [
      ["componentId", (s) => ({ ...s, componentId: "other" })],
      ["scope", (s) => ({ ...s, scope: { kind: "machine", machineId: "m-zzz" } })],
      ["action", (s) => ({ ...s, action: "configure", toolInstall: undefined })],
      ["approval", (s) => ({ ...s, requiresApproval: false })],
      ["deps", (s) => ({ ...s, dependsOn: ["nope"] })],
      ["garbage", () => ({ nonsense: true })]
    ];
    for (const [, mutate] of bad) {
      const registry = new ToolInstallerRegistry();
      registry.register(installer("npm-i", mutate));
      const r = await built({ registry });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("validation");
        expect(r.error.message).toContain("npm-i");
      }
    }
    const registry = new ToolInstallerRegistry();
    registry.register(installer("npm-i", undefined, true));
    const { plan, preview } = await okBuilt({ registry, components: [] });
    expect(plan.steps.map((s) => s.stepId)).toEqual(["verify:doctor"]);
    expect(preview.manual[0]).toMatchObject({ toolId: "pnpm" });
    expect(preview.manual[0]!.guidance).toContain("cannot plan");
  });

  it("repairNeeded components are only planned in repair mode", async () => {
    const c = [comp("path", { repair: true, observed: digest("broken"), valid: false })];
    const dry = await okBuilt({ components: c, observations: [] });
    expect(dry.plan.steps.map((s) => s.componentId)).toEqual(["doctor"]);
    expect(dry.preview.needsRepair).toEqual(["path"]);
    const rep = await okBuilt({ components: c, observations: [], mode: "repair" });
    expect(rep.plan.steps.map((s) => s.componentId)).toEqual(["path", "doctor"]);
    expect(rep.preview.needsRepair).toEqual([]);
  });

  it("windows: mutating steps flagged unsupported_platform", async () => {
    const { preview } = await okBuilt({ platform: platformOf("win32"), observations: [], components: [comp("path")] });
    expect(preview.steps.find((s) => s.stepId === "configure:path")!.blockedReason).toBe("unsupported_platform");
    expect(preview.steps.find((s) => s.stepId === "verify:doctor")!.blockedReason).toBeUndefined();
  });

  it("renders preview deterministically", async () => {
    const { preview } = await okBuilt({ components: [comp("path", { machineWide: true })] });
    const text = renderPreview(preview);
    expect(text).toBe(renderPreview(preview));
    expect(text).toContain("install_tool:pnpm");
    expect(text).toContain("install pnpm 12.5.1 via npm");
    expect(text).toContain("machine-wide");
    expect(text).toContain("/t/path");
  });
});

describe("approvals", () => {
  it("persists receipts and verifies against plan/step", async () => {
    const { plan, preview } = await okBuilt();
    const store = new SetupStateStore(paths, { uid, now: () => NOW });
    const res = await new InteractiveApprover(async (t) => t.includes("install_tool:pnpm"), store, () => NOW).approve(plan, preview);
    expect(res.approved).toBe(true);
    if (!res.approved) return;
    expect(res.receipt.approvedBy).toBe("operator");
    const step = plan.steps.find((s) => s.stepId === "configure:path")!;
    const v = await verifyApproval(store, plan, step, res.receipt.receiptId);
    expect(v.ok).toBe(true);
    const doctor = plan.steps.find((s) => s.stepId === "verify:doctor")!;
    const vd = await verifyApproval(store, plan, doctor, res.receipt.receiptId);
    expect(vd.ok).toBe(false);
    const missing = await verifyApproval(store, plan, step, "nope");
    expect(missing.ok).toBe(false);
  });

  it("receipt for another plan digest is rejected", async () => {
    const a = await okBuilt();
    const b = await okBuilt({ components: [comp("path", { desired: "changed" })] });
    const store = new SetupStateStore(paths, { uid, now: () => NOW });
    const res = await new AssumeYesApprover(store, () => NOW).approve(a.plan, a.preview);
    if (!res.approved) throw new Error("expected approval");
    const step = b.plan.steps.find((s) => s.stepId === "configure:path")!;
    const v = await verifyApproval(store, b.plan, step, res.receipt.receiptId);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe("validation");
  });

  it("declines: interactive no, non-interactive, read-only store", async () => {
    const { plan, preview } = await okBuilt();
    const store = new SetupStateStore(paths, { uid, now: () => NOW });
    const no = await new InteractiveApprover(async () => false, store, () => NOW).approve(plan, preview);
    expect(no.approved).toBe(false);
    const ni = await new NonInteractiveApprover().approve(plan, preview);
    expect(ni).toEqual({ approved: false, reason: "approval required; rerun with --yes or interactively" });
    const ro = new SetupStateStore(paths, { uid, now: () => NOW, readOnly: true });
    const r = await new AssumeYesApprover(ro, () => NOW).approve(plan, preview);
    expect(r.approved).toBe(false);
  });
});
