import type { ContractError, OperationResult } from "@bflow/contracts";
import type {
  CliCommandName,
  CliContext,
  CliExitCode,
  HighLevelCommandName,
  HighLevelCommandOutput,
  HighLevelParsedCliCommand
} from "./types.js";
import { CLI_EXIT_CODES } from "./types.js";
import {
  CommandOperationLedger,
  computeRequestFingerprint,
  enforceCommandGovernance,
  withCommandLock
} from "./operation-ledger.js";
import { HighLevelCliFacade, makeExecutionResult } from "./high-level-facade.js";

const HIGH_LEVEL_COMMAND_SET = new Set<HighLevelCommandName>([
  "repo inspect",
  "task plan",
  "task implement",
  "verify",
  "git prepare",
  "mcp status",
  "tool status",
  "skills sync",
  "agent check"
]);

/**
 * Type guard to check if a CLI command name is a high-level command.
 */
export function isHighLevelCommand(command: CliCommandName): command is HighLevelCommandName {
  return HIGH_LEVEL_COMMAND_SET.has(command as HighLevelCommandName);
}

export interface HighLevelExecutionResult {
  readonly exitCode: CliExitCode;
  readonly ok: boolean;
  readonly data?: HighLevelCommandOutput | undefined;
  readonly error?: ContractError | undefined;
}

/**
 * Orchestrates high-level command execution with governance enforcement,
 * concurrency locking, durable idempotency ledger, and facade dispatch.
 */
export async function executeHighLevelCommand(
  parsed: HighLevelParsedCliCommand,
  context?: CliContext
): Promise<HighLevelExecutionResult> {
  const workspaceRoot = context?.cwd ?? process.cwd();
  if (parsed.command === "task preview") {
    return { exitCode: CLI_EXIT_CODES.USAGE_ERROR, ok: false, error: { code: "validation", retryable: false, message: "Execution preview requires the read-only binary dispatcher." } };
  }

  // 1. Enforce permission, role boundary, and protected branch governance
  const govResult = enforceCommandGovernance({
    command: parsed.command,
    targetBranch: "targetBranch" in parsed ? (parsed as any).targetBranch : undefined,
    environmentName: "environmentName" in parsed ? (parsed as any).environmentName : undefined,
    autoApprove: "autoApprove" in parsed ? (parsed as any).autoApprove : undefined,
    approvedBy: "approvedBy" in parsed ? (parsed as any).approvedBy : undefined,
    actor: "actor" in parsed ? (parsed as any).actor : ("developerId" in parsed ? (parsed as any).developerId : undefined),
    permissionMode: "permissionMode" in parsed ? (parsed as any).permissionMode : undefined,
    role: "role" in parsed ? (parsed as any).role : undefined,
    sessionId: "sessionId" in parsed ? (parsed as any).sessionId : undefined,
    isolation: "isolation" in parsed ? (parsed as any).isolation : undefined,
    workspaceRoot
  });

  if (!govResult.ok) {
    return {
      exitCode: CLI_EXIT_CODES.USAGE_ERROR,
      ok: false,
      error: govResult.error
    };
  }

  // 2. Concurrency lock to prevent simultaneous invocations on the same resource scope
  const scopeKey = `${parsed.command}:${
    ("runId" in parsed && (parsed as any).runId) ||
    ("sessionId" in parsed && (parsed as any).sessionId) ||
    "default"
  }`;

  const lockResult = await withCommandLock<HighLevelExecutionResult>(
    workspaceRoot,
    scopeKey,
    async (): Promise<OperationResult<HighLevelExecutionResult>> => {
    // 3. Durable operation ledger for idempotency and resume checks
    const ledger = new CommandOperationLedger(workspaceRoot);
    const requestFingerprint = computeRequestFingerprint(parsed);

    const idempotencyCheck = await ledger.checkIdempotencyOrResume({
      command: parsed.command,
      idempotencyKey: parsed.idempotencyKey,
      requestFingerprint,
      resume: "resume" in parsed ? (parsed as any).resume : false,
      runId: "runId" in parsed ? (parsed as any).runId : undefined,
      taskId: "taskId" in parsed ? (parsed as any).taskId : undefined
    });

    if (idempotencyCheck.action === "error") {
      return {
        ok: false,
        error: idempotencyCheck.error!
      };
    }

    if (idempotencyCheck.action === "reuse" && idempotencyCheck.receipt) {
      const storedReceipt = idempotencyCheck.receipt;
      const executionResult =
        storedReceipt.executionResult ??
        makeExecutionResult({
          commandId: storedReceipt.commandId,
          correlationId: storedReceipt.correlationId,
          runId: storedReceipt.runId,
          status: storedReceipt.status === "succeeded" ? "succeeded" : "failed",
          output: (storedReceipt.details?.outputs as any) ?? {},
          error: storedReceipt.error
        });

      const reusedData: HighLevelCommandOutput = {
        schemaVersion: 3,
        command: parsed.command,
        commandId: storedReceipt.commandId,
        correlationId: storedReceipt.correlationId,
        idempotencyKey: storedReceipt.idempotencyKey,
        runId: storedReceipt.runId,
        taskId: storedReceipt.taskId,
        status: storedReceipt.status === "succeeded" ? "succeeded" : "failed",
        reusedReceipt: true,
        steps: storedReceipt.steps,
        executionResult,
        details: storedReceipt.details ?? {}
      };

      if (storedReceipt.details) {
        Object.assign(reusedData, storedReceipt.details);
      }

      let exitCode: CliExitCode = CLI_EXIT_CODES.SUCCESS;
      if (parsed.command === "verify") {
        if ((reusedData.details?.result as any)?.status === "failed") {
          exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
        }
      } else if (parsed.command === "git prepare") {
        if ((reusedData.details as any)?.conflictsDetected === true) {
          exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
        }
      } else if (
        parsed.command === "mcp status" ||
        parsed.command === "tool status" ||
        parsed.command === "agent check"
      ) {
        if ((reusedData.details as any)?.healthy === false) {
          exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
        }
      }

      return {
        ok: true,
        value: {
          exitCode,
          ok: true,
          data: reusedData
        }
      };
    }

    const priorReceipt =
      idempotencyCheck.action === "resume" ? idempotencyCheck.receipt : undefined;
    const ledgerContext = { ledger, priorReceipt };

    // 4. Facade instantiation and command dispatch
    const facade = new HighLevelCliFacade(workspaceRoot, (context as any)?.highLevel);

    let output: HighLevelCommandOutput;
    switch (parsed.command) {
      case "repo inspect":
        output = await facade.inspectRepository(parsed);
        break;
      case "task plan":
        output = await facade.planTask(parsed);
        break;
      case "task implement":
        output = await facade.implementTask(parsed, ledgerContext);
        break;
      case "verify":
        output = await facade.verify(parsed, ledgerContext);
        break;
      case "git prepare":
        output = await facade.prepareGitIntegration(parsed, ledgerContext);
        break;
      case "mcp status":
        output = await facade.getMcpStatus(parsed);
        break;
      case "tool status":
        output = await facade.getToolStatus(parsed);
        break;
      case "skills sync":
        output = await facade.syncSkills(parsed, ledgerContext);
        break;
      case "agent check":
        output = await facade.checkAgents(parsed);
        break;
      default: {
        const exhaustive: never = parsed;
        throw new Error(`Unhandled high-level command: ${(exhaustive as any)?.command}`);
      }
    }

    // 5. Compute exit code based on command outcome
    if (output.status === "failed") {
      const err =
        output.executionResult.error ??
        (output.details?.error as ContractError | undefined) ?? {
          code: "conflict" as const,
          retryable: true,
          message: `Command '${parsed.command}' failed.`
        };
      const isValidation = err.code === "validation";
      return {
        ok: true,
        value: {
          exitCode: isValidation ? CLI_EXIT_CODES.USAGE_ERROR : CLI_EXIT_CODES.RUNTIME_ERROR,
          ok: false,
          data: output,
          error: err
        }
      };
    }

    // 6. Persist successful command execution receipt for durable replay/idempotency
    if (output.status === "succeeded") {
      await ledger.saveReceipt({
        schemaVersion: 3,
        command: parsed.command,
        commandId: output.commandId,
        correlationId: output.correlationId,
        idempotencyKey: output.idempotencyKey,
        requestFingerprint,
        runId: output.runId,
        taskId: output.taskId,
        status: "succeeded",
        steps: [...output.steps],
        details: output.details,
        executionResult: output.executionResult,
        updatedAt: new Date().toISOString()
      });
    }

    // Check domain health / failure conditions even if command execution status is succeeded
    let exitCode: CliExitCode = CLI_EXIT_CODES.SUCCESS;

    if (parsed.command === "verify") {
      if ((output.details?.result as any)?.status === "failed") {
        exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
      }
    } else if (parsed.command === "git prepare") {
      if ((output.details as any)?.conflictsDetected === true) {
        exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
      }
    } else if (
      parsed.command === "mcp status" ||
      parsed.command === "tool status" ||
      parsed.command === "agent check"
    ) {
      if ((output.details as any)?.healthy === false) {
        exitCode = CLI_EXIT_CODES.RUNTIME_ERROR;
      }
    }

    return {
      ok: true,
      value: {
        exitCode,
        ok: true,
        data: output
      }
    };
  });

  if (lockResult.ok) {
    return lockResult.value;
  }

  const isValidation = lockResult.error.code === "validation";
  return {
    exitCode: isValidation ? CLI_EXIT_CODES.USAGE_ERROR : CLI_EXIT_CODES.RUNTIME_ERROR,
    ok: false,
    error: lockResult.error
  };
}
