import {
  MachineSetupPlanSchema,
  SetupStepSchema,
  type OperationResult,
  type SetupStep,
  type ToolInstaller
} from "@bflow/contracts";
import { digest } from "./canonical.js";
import { validationError } from "./errors.js";
import { buildInstallRequest, type ToolInstallDescriptor, type ToolInstallerRegistry } from "./installer-registry.js";
import { TOOL_CATALOG, type ToolObservation } from "./tools.js";
import type { CommandRunner, PlatformProfile, SetupComponent, SetupContext } from "./types.js";
import type { MachineConfig } from "./machine-config.js";

export const COMPONENT_ORDER = ["path", "role-skills", "mcp-config", "services", "environment-manifest"] as const;
export const DOCTOR_STEP_ID = "verify:doctor";

export interface SetupPreviewStep {
  stepId: string;
  action: SetupStep["action"];
  componentId: string;
  summary: string;
  targets: string[];
  machineWide: boolean;
  requiresApproval: boolean;
  requiresElevation: boolean;
  commandPreview?: string[];
  /** Set for mutating steps on platforms where setup is modelled but not verified. */
  blockedReason?: "unsupported_platform";
}

export interface SetupPreview {
  steps: SetupPreviewStep[];
  satisfied: string[];
  manual: { toolId: string; guidance: string }[];
  needsRepair: string[];
  machineWideChanges: string[];
}

export interface BuildSetupPlanInput {
  platform: PlatformProfile;
  runner: CommandRunner;
  observations: readonly ToolObservation[];
  config: MachineConfig;
  components: readonly SetupComponent[];
  registry: ToolInstallerRegistry;
  mode: SetupContext["mode"];
  previousRevision: number;
  now: () => Date;
  signal?: AbortSignal;
}

export interface BuiltSetupPlan {
  plan: ReturnType<typeof MachineSetupPlanSchema.parse>;
  preview: SetupPreview;
  diagnostics: string[];
  componentFailures: { componentId: string; message: string }[];
}

function fail<T>(message: string): OperationResult<T> {
  return { ok: false, error: validationError(message) };
}

function guidanceFor(toolId: string, os: PlatformProfile["os"]): string {
  const entry = TOOL_CATALOG.find((e) => e.toolId === toolId);
  if (!entry) return `Install ${toolId} manually; no pinned installer is available.`;
  return entry.manualGuidance[os === "darwin" || os === "win32" ? os : "linux"];
}

function validateInstallerStep(
  raw: unknown,
  installerId: string,
  toolId: string,
  platform: PlatformProfile,
  earlier: ReadonlySet<string>
): OperationResult<SetupStep> {
  const parsed = SetupStepSchema.safeParse(raw);
  if (!parsed.success) return fail(`installer ${installerId} returned an invalid step for ${toolId}: ${parsed.error.message}`);
  const s = parsed.data;
  const scope = { kind: "machine", machineId: platform.machineId };
  if (s.action !== "install_tool") return fail(`installer ${installerId} returned a non-install step for ${toolId}`);
  if (s.componentId !== toolId) return fail(`installer ${installerId} returned componentId ${s.componentId}, expected ${toolId}`);
  if (JSON.stringify(s.scope) !== JSON.stringify(scope) || s.level !== "machine") {
    return fail(`installer ${installerId} returned a step with a scope other than this machine for ${toolId}`);
  }
  if (!s.requiresApproval) return fail(`installer ${installerId} returned an install step without required approval for ${toolId}`);
  if (earlier.has(s.stepId)) return fail(`installer ${installerId} returned duplicate stepId ${s.stepId}`);
  if (s.dependsOn.some((d) => !earlier.has(d))) return fail(`installer ${installerId} returned a step depending on an unknown step`);
  return { ok: true, value: s };
}

function mkIdempotencyKey(machineId: string, stepId: string, desired: string): string {
  return `setup:${machineId}:${stepId}:${desired}`;
}

export async function buildSetupPlan(input: BuildSetupPlanInput): Promise<OperationResult<BuiltSetupPlan>> {
  const { platform } = input;
  const known = new Set<string>(COMPONENT_ORDER);
  const byId = new Map<string, SetupComponent>();
  for (const c of input.components) {
    if (!known.has(c.componentId)) return fail(`unknown setup component: ${c.componentId}`);
    if (byId.has(c.componentId)) return fail(`duplicate setup component: ${c.componentId}`);
    byId.set(c.componentId, c);
  }
  const ctx: SetupContext = {
    platform, runner: input.runner, mode: input.mode, now: input.now,
    ...(input.signal ? { signal: input.signal } : {})
  };
  const scope = { kind: "machine" as const, machineId: platform.machineId };
  const unsupported = platform.os === "win32" || platform.os === "other";
  const nodeOs = platform.os === "darwin" || platform.os === "win32" || platform.os === "linux" ? platform.os : null;

  const steps: SetupStep[] = [];
  const previewSteps: SetupPreviewStep[] = [];
  const stepIds = new Set<string>();
  const manual: { toolId: string; guidance: string }[] = [];
  const satisfied: string[] = [];
  const needsRepair: string[] = [];
  const diagnostics: string[] = [];
  const componentFailures: BuiltSetupPlan["componentFailures"] = [];

  const push = (step: SetupStep, p: Omit<SetupPreviewStep, "stepId" | "action" | "componentId" | "requiresApproval">): void => {
    steps.push(step);
    stepIds.add(step.stepId);
    previewSteps.push({
      stepId: step.stepId, action: step.action, componentId: step.componentId,
      requiresApproval: step.requiresApproval, ...p,
      ...(unsupported && step.action !== "verify" ? { blockedReason: "unsupported_platform" as const } : {})
    });
  };

  // 1. tool installs
  for (const o of input.observations) {
    if ((o.status !== "missing" && o.status !== "version_mismatch") || !o.required) continue;
    const resolved = nodeOs ? input.registry.resolve(o.toolId, nodeOs, input.config.toolPins) : null;
    if (!resolved) {
      manual.push({ toolId: o.toolId, guidance: guidanceFor(o.toolId, platform.os) });
      continue;
    }
    const { descriptor, installer } = resolved as { descriptor: ToolInstallDescriptor; installer: ToolInstaller };
    const req = buildInstallRequest(descriptor, platform);
    if (!req.ok) return { ok: false, error: req.error };
    let planned;
    try {
      planned = await installer.plan(req.value, input.signal ? { signal: input.signal } : undefined);
    } catch (e) {
      manual.push({ toolId: o.toolId, guidance: `installer ${installer.installerId} failed to plan: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    if (!planned.ok) {
      manual.push({ toolId: o.toolId, guidance: `${planned.error.message}. ${guidanceFor(o.toolId, platform.os)}` });
      continue;
    }
    const checked = validateInstallerStep(planned.value, installer.installerId, o.toolId, platform, stepIds);
    if (!checked.ok) return checked;
    push(checked.value, {
      summary: `install ${descriptor.toolId} ${descriptor.version} via ${descriptor.method} from ${descriptor.source}`,
      targets: [req.value.destination],
      machineWide: true,
      requiresElevation: descriptor.requiresElevation
    });
  }

  // 2. component steps in known order
  const componentSteps = new Map<string, SetupStep>();
  for (const id of COMPONENT_ORDER) {
    const c = byId.get(id);
    if (!c) continue;
    // MCP may be omitted because it is satisfied, absent, or could not be planned.
    // Only the latter prevents services from safely using the configuration.
    if (id === "services" && (needsRepair.includes("mcp-config") || componentFailures.some((f) => f.componentId === "mcp-config"))) {
      const message = "component services not planned: mcp-config requires repair or could not be evaluated";
      diagnostics.push(message);
      componentFailures.push({ componentId: id, message });
      continue;
    }
    let observed, desired;
    try {
      observed = await c.observe(ctx);
      desired = await c.desired(ctx);
    } catch (e) {
      const message = `component ${id} failed to evaluate: ${e instanceof Error ? e.message : String(e)}`;
      diagnostics.push(message);
      componentFailures.push({ componentId: id, message });
      continue;
    }
    if (observed.valid && observed.stateDigest === desired.digest) {
      satisfied.push(id);
      continue;
    }
    if (desired.repairNeeded && input.mode !== "repair") {
      needsRepair.push(id);
      continue;
    }
    const stepId = `${c.action}:${id}`;
    const mcpStep = id === "services" ? componentSteps.get("mcp-config") : undefined;
    const dependsOn = id === "environment-manifest" ? [...stepIds] : mcpStep ? [mcpStep.stepId] : [];
    const step = SetupStepSchema.safeParse({
      schemaVersion: 3, stepId, action: c.action, componentId: id, level: "machine", scope, dependsOn,
      desiredStateDigest: desired.digest, expectedStateDigest: observed.stateDigest,
      requiresApproval: c.action !== "verify", rollback: c.rollback,
      idempotencyKey: mkIdempotencyKey(platform.machineId, stepId, desired.digest)
    });
    if (!step.success) return fail(`invalid step for component ${id}: ${step.error.message}`);
    componentSteps.set(id, step.data);
    push(step.data, {
      summary: desired.summary, targets: [...desired.targets], machineWide: desired.machineWide, requiresElevation: false
    });
  }

  // 3. doctor verify
  const doctor = SetupStepSchema.safeParse({
    schemaVersion: 3, stepId: DOCTOR_STEP_ID, action: "verify", componentId: "doctor", level: "machine", scope,
    dependsOn: [],
    desiredStateDigest: digest({ healthy: true }), expectedStateDigest: null, requiresApproval: false,
    rollback: "none", idempotencyKey: mkIdempotencyKey(platform.machineId, DOCTOR_STEP_ID, digest({ healthy: true }))
  });
  if (!doctor.success) return fail(`invalid doctor step: ${doctor.error.message}`);
  push(doctor.data, { summary: "verify machine health with doctor", targets: [], machineWide: false, requiresElevation: false });

  // 4. plan document
  const revision = input.previousRevision + 1;
  if (!Number.isInteger(revision) || revision < 1) return fail("previousRevision must be a non-negative integer");
  const body = {
    schemaVersion: 3 as const,
    machineId: platform.machineId,
    revision,
    createdAt: input.now().toISOString(),
    steps,
    idempotencyKey: `setup-plan:${platform.machineId}:${revision}:${digest(steps)}`
  };
  // planId is derived from planDigest, so the digest covers the plan without planId and planDigest.
  const planDigest = digest(body);
  const parsed = MachineSetupPlanSchema.safeParse({ ...body, planId: `plan-${planDigest.slice(0, 16)}`, planDigest });
  if (!parsed.success) return fail(`invalid setup plan: ${parsed.error.message}`);

  const preview: SetupPreview = {
    steps: previewSteps,
    satisfied,
    manual,
    needsRepair,
    machineWideChanges: previewSteps.filter((p) => p.machineWide).flatMap((p) => p.targets.map((t) => `${p.stepId}: ${t}`))
  };
  return { ok: true, value: { plan: parsed.data, preview, diagnostics, componentFailures } };
}

export function renderPreview(preview: SetupPreview): string {
  const lines: string[] = [];
  lines.push(`Planned steps (${preview.steps.length}):`);
  for (const s of preview.steps) {
    const flags = [
      s.requiresApproval ? "approval" : "no-approval",
      ...(s.machineWide ? ["machine-wide"] : []),
      ...(s.requiresElevation ? ["requires-elevation (manual)"] : []),
      ...(s.blockedReason ? [s.blockedReason] : [])
    ];
    lines.push(`- ${s.stepId} [${flags.join(", ")}] ${s.summary}`);
    for (const t of s.targets) lines.push(`    target: ${t}`);
    if (s.commandPreview) lines.push(`    command: ${s.commandPreview.join(" ")}`);
  }
  if (preview.satisfied.length) lines.push(`Already satisfied: ${preview.satisfied.join(", ")}`);
  if (preview.needsRepair.length) lines.push(`Needs repair (run in repair mode): ${preview.needsRepair.join(", ")}`);
  if (preview.manual.length) {
    lines.push("Manual action required:");
    for (const m of preview.manual) lines.push(`- ${m.toolId}: ${m.guidance}`);
  }
  if (preview.machineWideChanges.length) {
    lines.push("Machine-wide changes:");
    for (const c of preview.machineWideChanges) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}
