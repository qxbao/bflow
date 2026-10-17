import { createHash } from "node:crypto";
import { open, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CommandExecutionResult,
  ContractError,
  OperationResult,
  PermissionProfile
} from "@bflow/contracts";
import { PermissionProfileSchema } from "@bflow/contracts";
import { isHumanApprover } from "@bflow/runtime";
import type {
  HighLevelCommandName,
  HighLevelStepRecord
} from "./types.js";

export interface StoredCommandReceipt {
  readonly schemaVersion: 3;
  readonly command: HighLevelCommandName;
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly status: "in_progress" | "succeeded" | "failed_safe" | "unknown";
  readonly steps: HighLevelStepRecord[];
  readonly details?: Record<string, unknown> | undefined;
  readonly executionResult?: CommandExecutionResult | undefined;
  readonly error?: ContractError | undefined;
  readonly updatedAt: string;
}

/**
 * Computes a deterministic SHA-256 fingerprint for a parsed command,
 * stripping non-semantic flags (e.g. resume, json, help, correlationId)
 * to prevent false idempotency conflicts when retrying with different formatting/control flags.
 */
export function computeRequestFingerprint(parsed: unknown): string {
  if (parsed === null || typeof parsed !== "object") {
    return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  }

  const {
    resume,
    json,
    help,
    correlationId,
    ...rest
  } = parsed as Record<string, unknown>;

  const sortedKeys = Object.keys(rest).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    normalized[k] = rest[k];
  }

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

const ACTIVE_PROCESS_LOCKS = new Set<string>();

/**
 * Concurrency locking with file-based locking and in-process tracking
 * to prevent concurrent executions for the same scope.
 */
export async function withCommandLock<T>(
  workspaceRoot: string,
  scopeKey: string,
  fn: () => Promise<OperationResult<T>>
): Promise<OperationResult<T>> {
  const scopeHash = createHash("sha256").update(scopeKey).digest("hex");
  const locksDir = resolve(workspaceRoot, ".bflow/state/commands/locks");
  const lockPath = resolve(locksDir, `${scopeHash}.lock`);

  if (ACTIVE_PROCESS_LOCKS.has(lockPath)) {
    return {
      ok: false,
      error: {
        code: "conflict",
        retryable: true,
        message: `Concurrent command invocation in progress for scope '${scopeKey}'.`
      }
    };
  }

  await mkdir(locksDir, { recursive: true });

  let fileHandle;
  try {
    fileHandle = await open(lockPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      return {
        ok: false,
        error: {
          code: "conflict",
          retryable: true,
          message: `Concurrent command invocation in progress for scope '${scopeKey}'.`
        }
      };
    }
    throw error;
  }

  ACTIVE_PROCESS_LOCKS.add(lockPath);
  try {
    await fileHandle.writeFile(
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        scopeKey
      })
    );
    return await fn();
  } finally {
    ACTIVE_PROCESS_LOCKS.delete(lockPath);
    try {
      await fileHandle.close();
    } catch {
      // ignore handle close errors
    }
    try {
      await unlink(lockPath);
    } catch {
      // ignore unlock errors if already removed
    }
  }
}

export type IdempotencyAction =
  | { readonly action: "proceed" }
  | { readonly action: "reuse"; readonly receipt: StoredCommandReceipt }
  | { readonly action: "resume"; readonly receipt: StoredCommandReceipt }
  | { readonly action: "error"; readonly error: ContractError };

/**
 * Manages durable command execution state and idempotency receipts.
 */
export class CommandOperationLedger {
  readonly workspaceRoot: string;
  private readonly receiptsDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.receiptsDir = resolve(workspaceRoot, ".bflow/state/commands/receipts");
  }

  private receiptPath(command: HighLevelCommandName, idempotencyKey: string): string {
    const key = `${command}:${idempotencyKey}`;
    const hash = createHash("sha256").update(key).digest("hex");
    return resolve(this.receiptsDir, `${hash}.json`);
  }

  async getReceipt(
    command: HighLevelCommandName,
    idempotencyKey: string
  ): Promise<StoredCommandReceipt | null> {
    const path = this.receiptPath(command, idempotencyKey);
    try {
      const data = await readFile(path, "utf8");
      return JSON.parse(data) as StoredCommandReceipt;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async findLatestReceipt(
    command: HighLevelCommandName,
    runId?: string,
    taskId?: string
  ): Promise<StoredCommandReceipt | null> {
    try {
      const entries = await readdir(this.receiptsDir);
      const matching: StoredCommandReceipt[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const content = await readFile(resolve(this.receiptsDir, entry), "utf8");
          const receipt = JSON.parse(content) as StoredCommandReceipt;
          if (receipt.command === command) {
            if (runId && receipt.runId !== runId) continue;
            if (taskId && receipt.taskId !== taskId) continue;
            matching.push(receipt);
          }
        } catch {
          // ignore corrupted or unreadable receipts
        }
      }
      if (matching.length === 0) return null;
      matching.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      return matching[0] ?? null;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveReceipt(receipt: StoredCommandReceipt): Promise<void> {
    await mkdir(this.receiptsDir, { recursive: true });
    const targetPath = this.receiptPath(receipt.command, receipt.idempotencyKey);
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const serialized = JSON.stringify(receipt, null, 2);
    await writeFile(tempPath, serialized, "utf8");
    await rename(tempPath, targetPath);
  }

  async checkIdempotencyOrResume(params: {
    command: HighLevelCommandName;
    idempotencyKey?: string | undefined;
    requestFingerprint: string;
    resume?: boolean | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  }): Promise<IdempotencyAction> {
    const { command, idempotencyKey, requestFingerprint, resume, runId, taskId } = params;

    if (idempotencyKey) {
      const receipt = await this.getReceipt(command, idempotencyKey);
      if (receipt) {
        if (receipt.requestFingerprint !== requestFingerprint) {
          return {
            action: "error",
            error: {
              code: "conflict",
              retryable: true,
              message: `Idempotency key '${idempotencyKey}' was already used with different command parameters.`
            }
          };
        }

        if (receipt.status === "succeeded" && !resume) {
          return { action: "reuse", receipt };
        }

        // Unknown / Uncertain mutation state protection
        const hasUncertainState =
          receipt.status === "unknown" ||
          receipt.status === "in_progress" ||
          receipt.steps.some(
            step => step.status === "unknown" || (step.mutating && step.status !== "succeeded")
          );

        if (hasUncertainState && !resume) {
          const uncertainStep = receipt.steps.find(
            s => s.status === "unknown" || (s.mutating && s.status !== "succeeded")
          );
          const stepId = uncertainStep?.stepId ?? "unknown";
          return {
            action: "error",
            error: {
              code: "conflict",
              retryable: true,
              message: `Prior execution for idempotency key '${idempotencyKey}' left mutating step '${stepId}' in an uncertain/interrupted state. Reconcile state using '--resume' before retrying dangerous operations.`
            }
          };
        }

        if (resume) {
          return { action: "resume", receipt };
        }
      } else if (resume) {
        return {
          action: "error",
          error: {
            code: "not_found",
            retryable: false,
            message: "No prior command execution state found to resume."
          }
        };
      }
    } else if (resume) {
      const receipt = await this.findLatestReceipt(command, runId, taskId);
      if (!receipt) {
        return {
          action: "error",
          error: {
            code: "not_found",
            retryable: false,
            message: "No prior command execution state found to resume."
          }
        };
      }
      return { action: "resume", receipt };
    }

    return { action: "proceed" };
  }
}

export interface TrackedStepDef {
  readonly stepId: string;
  readonly name: string;
  readonly mutating: boolean;
  execute(priorOutputs: Record<string, unknown>): Promise<unknown>;
  reconcile?(priorOutputs: Record<string, unknown>): Promise<{ completed: boolean; output?: unknown }>;
}

export interface RunTrackedStepsOptions {
  readonly ledger: CommandOperationLedger;
  readonly command: HighLevelCommandName;
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly resume?: boolean | undefined;
  readonly priorReceipt?: StoredCommandReceipt | undefined;
  readonly steps: readonly TrackedStepDef[];
  readonly clock?: (() => Date) | undefined;
}

export interface RunTrackedStepsResult {
  readonly ok: true;
  readonly outputs: Record<string, unknown>;
  readonly steps: HighLevelStepRecord[];
  readonly resumedFromStep?: string | undefined;
}

/**
 * Runs an ordered pipeline of tracked steps with idempotency, unknown-state protection,
 * and resume capability.
 */
export async function runTrackedSteps(
  options: RunTrackedStepsOptions
): Promise<OperationResult<RunTrackedStepsResult>> {
  const {
    ledger,
    command,
    commandId,
    correlationId,
    idempotencyKey,
    requestFingerprint,
    runId,
    taskId,
    resume,
    priorReceipt,
    steps,
    clock
  } = options;

  const nowIso = () => (clock ? clock().toISOString() : new Date().toISOString());

  const recordedSteps: HighLevelStepRecord[] = steps.map(s => ({
    stepId: s.stepId,
    name: s.name,
    status: "unknown" as const,
    mutating: s.mutating,
    startedAt: nowIso()
  }));

  const outputs: Record<string, unknown> = {};
  let resumedFromStep: string | undefined = undefined;
  let hasPriorMutatingStep = false;

  // If resuming, seed outputs and records from priorReceipt
  if (resume && priorReceipt) {
    for (let i = 0; i < steps.length; i++) {
      const def = steps[i]!;
      const priorStep = priorReceipt.steps.find(s => s.stepId === def.stepId);
      if (priorStep && priorStep.status === "succeeded") {
        recordedSteps[i] = {
          ...priorStep,
          output: priorStep.output
        };
        outputs[def.stepId] = priorStep.output;
        if (def.mutating) hasPriorMutatingStep = true;
      } else {
        if (!resumedFromStep) {
          resumedFromStep = def.stepId;
        }
      }
    }
  }

  const saveCurrentReceipt = async (
    status: StoredCommandReceipt["status"],
    error?: ContractError
  ) => {
    const receipt: StoredCommandReceipt = {
      schemaVersion: 3,
      command,
      commandId,
      correlationId,
      idempotencyKey,
      requestFingerprint,
      runId,
      taskId,
      status,
      steps: recordedSteps,
      details: { outputs },
      error,
      updatedAt: nowIso()
    };
    await ledger.saveReceipt(receipt);
  };

  for (let i = 0; i < steps.length; i++) {
    const stepDef = steps[i]!;
    const recordedStep = recordedSteps[i]!;

    // Skip already-succeeded steps on resume
    if (resume && recordedStep.status === "succeeded") {
      continue;
    }

    if (!resumedFromStep) {
      resumedFromStep = stepDef.stepId;
    }

    // Attempt reconciliation if available on resume
    if (resume && stepDef.reconcile) {
      try {
        const reconciled = await stepDef.reconcile(outputs);
        if (reconciled.completed) {
          recordedSteps[i] = {
            stepId: stepDef.stepId,
            name: stepDef.name,
            mutating: stepDef.mutating,
            status: "succeeded",
            startedAt: nowIso(),
            completedAt: nowIso(),
            output: reconciled.output
          };
          outputs[stepDef.stepId] = reconciled.output;
          if (stepDef.mutating) hasPriorMutatingStep = true;
          await saveCurrentReceipt("in_progress");
          continue;
        }
      } catch {
        // Fall through to execution if reconciliation could not verify completion
      }
    }

    // Before mutating step execution, persist uncertain/unknown state
    if (stepDef.mutating) {
      recordedSteps[i] = {
        ...recordedStep,
        status: "unknown",
        startedAt: nowIso()
      };
      await saveCurrentReceipt("unknown");
    } else {
      recordedSteps[i] = {
        ...recordedStep,
        status: "unknown",
        startedAt: nowIso()
      };
      await saveCurrentReceipt("in_progress");
    }

    try {
      const output = await stepDef.execute(outputs);
      outputs[stepDef.stepId] = output;
      recordedSteps[i] = {
        stepId: stepDef.stepId,
        name: stepDef.name,
        mutating: stepDef.mutating,
        status: "succeeded",
        startedAt: recordedSteps[i]!.startedAt ?? nowIso(),
        completedAt: nowIso(),
        output
      };
      if (stepDef.mutating) hasPriorMutatingStep = true;
      await saveCurrentReceipt("in_progress");
    } catch (error: any) {
      const VALID_CONTRACT_ERROR_CODES = new Set<string>([
        "validation",
        "conflict",
        "timeout",
        "cancelled",
        "transport_unavailable",
        "unknown_delivery",
        "corruption",
        "unsupported_version",
        "not_found"
      ]);

      const isUncertain =
        error?.uncertain === true ||
        error?.code === "timeout" ||
        error?.code === "transport_unavailable" ||
        error?.code === "unknown" ||
        stepDef.mutating;

      const validCode =
        error?.code && VALID_CONTRACT_ERROR_CODES.has(error.code)
          ? error.code
          : error?.code === "ENOENT"
          ? "not_found"
          : isUncertain
          ? "transport_unavailable"
          : "conflict";

      const message = error?.message ?? String(error);
      const details = error?.details;

      let contractError: ContractError;
      switch (validCode) {
        case "validation":
          contractError = { code: "validation", retryable: false, message, ...(details ? { details } : {}) };
          break;
        case "not_found":
          contractError = { code: "not_found", retryable: false, message, ...(details ? { details } : {}) };
          break;
        case "cancelled":
          contractError = { code: "cancelled", retryable: false, message, ...(details ? { details } : {}) };
          break;
        case "corruption":
          contractError = { code: "corruption", retryable: false, message, ...(details ? { details } : {}) };
          break;
        case "unknown_delivery":
          contractError = { code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message, ...(details ? { details } : {}) };
          break;
        case "unsupported_version":
          contractError = {
            code: "unsupported_version",
            retryable: false,
            supportedVersions: error?.supportedVersions ?? [3],
            receivedVersion: error?.receivedVersion ?? 0,
            message,
            ...(details ? { details } : {})
          };
          break;
        case "timeout":
          contractError = {
            code: "timeout",
            retryable: true,
            retrySafety: error?.retrySafety ?? "not_started",
            message,
            ...(details ? { details } : {})
          };
          break;
        case "transport_unavailable":
          contractError = { code: "transport_unavailable", retryable: true, message, ...(details ? { details } : {}) };
          break;
        case "conflict":
        default:
          contractError = {
            code: "conflict",
            retryable: true,
            ...(error?.version ? { version: error.version } : {}),
            message,
            ...(details ? { details } : {})
          };
          break;
      }

      recordedSteps[i] = {
        stepId: stepDef.stepId,
        name: stepDef.name,
        mutating: stepDef.mutating,
        status: isUncertain ? "unknown" : "failed",
        startedAt: recordedSteps[i]!.startedAt ?? nowIso(),
        completedAt: nowIso(),
        error: contractError
      };

      for (let j = i + 1; j < steps.length; j++) {
        recordedSteps[j] = {
          stepId: steps[j]!.stepId,
          name: steps[j]!.name,
          mutating: steps[j]!.mutating,
          status: "skipped",
          startedAt: recordedSteps[j]!.startedAt
        };
      }

      const finalStatus = isUncertain || hasPriorMutatingStep ? "unknown" : "failed_safe";
      await saveCurrentReceipt(finalStatus, contractError);

      const detailsObj =
        contractError.details &&
        typeof contractError.details === "object" &&
        !Array.isArray(contractError.details)
          ? (contractError.details as Record<string, unknown>)
          : {};

      return {
        ok: false,
        error: {
          ...contractError,
          details: JSON.parse(
            JSON.stringify({
              ...detailsObj,
              steps: recordedSteps,
              failedStep: stepDef.stepId
            })
          )
        }
      };
    }
  }

  await saveCurrentReceipt("succeeded");

  return {
    ok: true,
    value: {
      ok: true,
      outputs,
      steps: recordedSteps,
      resumedFromStep
    }
  };
}

export const PROTECTED_BRANCH_REGEX = /^(main|master|production|prod|release\/.+|hotfix\/.+)$/i;
export const PRODUCTION_ENV_REGEX = /^(prod|production)$/i;

export interface CommandGovernanceInput {
  readonly command: HighLevelCommandName;
  readonly targetBranch?: string | undefined;
  readonly environmentName?: string | undefined;
  readonly autoApprove?: boolean | undefined;
  readonly approvedBy?: string | undefined;
  readonly actor?: string | undefined;
  readonly permissionMode?: "restricted" | "workspace_auto" | "unattended_isolated" | string | undefined;
  readonly role?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly isolation?: "provider_policy" | "os_sandbox" | "container" | string | undefined;
  readonly workspaceRoot?: string | undefined;
}

/**
 * Enforces command permissions, protected branch restrictions, and role boundaries.
 */
export function enforceCommandGovernance(
  input: CommandGovernanceInput
): OperationResult<PermissionProfile> {
  const {
    command,
    targetBranch,
    environmentName,
    autoApprove,
    approvedBy,
    actor,
    permissionMode,
    role,
    sessionId,
    isolation,
    workspaceRoot
  } = input;

  const isProtectedBranch = targetBranch ? PROTECTED_BRANCH_REGEX.test(targetBranch) : false;
  const isProductionEnv = environmentName ? PRODUCTION_ENV_REGEX.test(environmentName) : false;

  // 1. Protected Branch & Production Deployment Guard
  if (isProtectedBranch || isProductionEnv) {
    if (autoApprove === true) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message:
            "Policy violation: cannot auto-approve protected branch merge or production deployment. Explicit human approval is required."
        }
      };
    }

    const effectiveApprover = approvedBy ?? actor;
    if (effectiveApprover) {
      if (!isHumanApprover(effectiveApprover)) {
        return {
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message:
              "Policy violation: protected branch merge or production deployment requires a human approver."
          }
        };
      }
    } else if (command === "git prepare") {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message:
            "Protected branch merge or production deployment requires explicit human approval via --approved-by <human_operator> (auto-approval is forbidden)."
        }
      };
    }
  }

  // 2. Permission Mode & Role Boundary Guard
  const mutatingCommands: readonly HighLevelCommandName[] = [
    "task implement",
    "git prepare",
    "skills sync"
  ];
  const isMutatingCommand = mutatingCommands.includes(command);

  if (permissionMode === "restricted" && isMutatingCommand) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Permission denied: 'restricted' permission mode is read-only and cannot execute mutating command '${command}'.`
      }
    };
  }

  if (permissionMode === "unattended_isolated") {
    if (!sessionId || !isolation || isolation === "provider_policy") {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message:
            "Permission denied: 'unattended_isolated' mode requires explicit --session-id and OS/container isolation (--isolation os_sandbox|container)."
        }
      };
    }
  }

  if (role === "conversation") {
    if (command === "task implement" || command === "git prepare" || command === "verify") {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message:
            "Role boundary violation: 'conversation' role is the user interface only and cannot directly implement tasks, prepare Git integration, or run verification."
        }
      };
    }
  }

  // Construct and validate PermissionProfile using PermissionProfileSchema
  const effectiveMode =
    (permissionMode as "restricted" | "workspace_auto" | "unattended_isolated") ?? "workspace_auto";
  const effectiveIsolation =
    (isolation as "provider_policy" | "os_sandbox" | "container") ??
    (effectiveMode === "unattended_isolated" ? "container" : "provider_policy");
  const isReadOnly = effectiveMode === "restricted";
  const root = workspaceRoot ?? process.cwd();

  const profileCandidate = {
    schemaVersion: 3 as const,
    profileId: `perm-${command.replace(/\s+/g, "-")}`,
    mode: effectiveMode,
    scope: {
      kind: (sessionId ? "session" : "repository") as "session" | "repository",
      machineId: "local-machine",
      repositoryId: "local-repo",
      workspaceRoot: root,
      ...(sessionId ? { sessionId } : {})
    },
    filesystem: (isReadOnly ? "read_only" : "workspace_write") as "read_only" | "workspace_write",
    readableRoots: [root],
    writableRoots: isReadOnly ? [] : [root],
    deniedRoots: [],
    isolation: effectiveIsolation,
    network: { mode: "deny" as const, allowedHosts: [] },
    allowedTools: [],
    deniedAction: "deny" as const,
    allowGlobalPermissionBypass: false as const
  };

  const parsedProfile = PermissionProfileSchema.safeParse(profileCandidate);
  if (!parsedProfile.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid permission profile: ${parsedProfile.error.message}`
      }
    };
  }

  return { ok: true, value: parsedProfile.data };
}
