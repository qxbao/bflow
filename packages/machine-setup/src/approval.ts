import type { MachineSetupPlan, OperationResult, SetupStep } from "@bflow/contracts";
import { digest } from "./canonical.js";
import { validationError } from "./errors.js";
import { renderPreview, type SetupPreview } from "./plan.js";
import type { ApprovalReceipt, SetupStateStore } from "./state-store.js";

export type ApprovalDecision = { approved: true; receipt: ApprovalReceipt } | { approved: false; reason: string };

export interface SetupApprover {
  approve(plan: MachineSetupPlan, preview: SetupPreview): Promise<ApprovalDecision>;
}

/** Steps an approver may cover: approval-requiring and not an elevation install (those stay manual). */
function approvableStepIds(plan: MachineSetupPlan, preview: SetupPreview): string[] {
  const elevated = new Set(preview.steps.filter((s) => s.requiresElevation).map((s) => s.stepId));
  return plan.steps.filter((s) => s.requiresApproval && !elevated.has(s.stepId)).map((s) => s.stepId);
}

async function record(
  store: SetupStateStore,
  plan: MachineSetupPlan,
  preview: SetupPreview,
  approvedBy: ApprovalReceipt["approvedBy"],
  now: () => Date
): Promise<ApprovalDecision> {
  const stepIds = approvableStepIds(plan, preview);
  const approvedAt = now().toISOString();
  const receipt: ApprovalReceipt = {
    schemaVersion: 3,
    receiptId: `approval-${digest({ planDigest: plan.planDigest, stepIds, approvedBy, approvedAt }).slice(0, 24)}`,
    planId: plan.planId,
    planDigest: plan.planDigest,
    machineId: plan.machineId,
    stepIds,
    approvedBy,
    approvedAt
  };
  const written = await store.writeApproval(receipt);
  if (!written.ok) return { approved: false, reason: `approval could not be recorded: ${written.error.message}` };
  return { approved: true, receipt };
}

export class AssumeYesApprover implements SetupApprover {
  constructor(private readonly store: SetupStateStore, private readonly now: () => Date) {}
  approve(plan: MachineSetupPlan, preview: SetupPreview): Promise<ApprovalDecision> {
    return record(this.store, plan, preview, "assume_yes", this.now);
  }
}

export class InteractiveApprover implements SetupApprover {
  constructor(
    private readonly confirm: (text: string) => Promise<boolean>,
    private readonly store: SetupStateStore,
    private readonly now: () => Date
  ) {}
  async approve(plan: MachineSetupPlan, preview: SetupPreview): Promise<ApprovalDecision> {
    const text = `${renderPreview(preview)}\n\nApply plan ${plan.planId}?`;
    if (!(await this.confirm(text))) return { approved: false, reason: "declined by operator" };
    return record(this.store, plan, preview, "operator", this.now);
  }
}

export class NonInteractiveApprover implements SetupApprover {
  async approve(): Promise<ApprovalDecision> {
    return { approved: false, reason: "approval required; rerun with --yes or interactively" };
  }
}

export async function verifyApproval(
  store: SetupStateStore,
  plan: MachineSetupPlan,
  step: SetupStep,
  receiptId: string
): Promise<OperationResult<ApprovalReceipt>> {
  const read = await store.readApproval(receiptId);
  if (!read.ok) return read;
  const r = read.value;
  if (!r) return { ok: false, error: validationError(`approval receipt not found: ${receiptId}`) };
  if (r.planId !== plan.planId) return { ok: false, error: validationError("approval receipt is for a different plan") };
  if (r.planDigest !== plan.planDigest) return { ok: false, error: validationError("approval receipt plan digest mismatch") };
  if (r.machineId !== plan.machineId) return { ok: false, error: validationError("approval receipt is for a different machine") };
  if (!plan.steps.some((s) => s.stepId === step.stepId)) return { ok: false, error: validationError("step is not part of the plan") };
  if (!r.stepIds.includes(step.stepId)) return { ok: false, error: validationError(`step ${step.stepId} is not covered by the approval`) };
  return { ok: true, value: r };
}
