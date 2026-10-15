import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import {
  ApprovalDecisionSchema,
  CancellationRequestSchema,
  ResumeRunInputSchema,
  RunQuerySchema,
  StartRunInputSchema,
  type ContractError,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from "@ai-flow/contracts";
import { isHumanApprover } from "@ai-flow/runtime";
import {
  createDefaultWorkflowDefinition,
  initRepositoryConfig,
  loadRepositoryConfig,
  loadWorkflowDefinitionFromFile,
  resolveConfigPath
} from "./config.js";
import { formatCommandError, formatCommandSuccess } from "./formatters.js";
import { getHelpText } from "./help.js";
import { parseCliArgs } from "./parser.js";
import {
  CLI_EXIT_CODES,
  type CliCommandData,
  type CliCommandName,
  type CliContext,
  type CliExecutionResult,
  type CliExitCode,
  type CliIo,
  type ParsedCliCommand
} from "./types.js";

function loadPackageVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fallback to default version
  }
  return "0.1.0";
}

export const CLI_VERSION: string = loadPackageVersion();

function makeResult(
  exitCode: CliExitCode,
  ok: boolean,
  command: CliCommandName | undefined,
  data: CliCommandData | undefined,
  error: ContractError | undefined,
  json: boolean,
  io?: CliIo | undefined
): CliExecutionResult {
  let stdout = "";
  let stderr = "";

  if (ok && data !== undefined && command !== undefined) {
    stdout = formatCommandSuccess(command, data, json);
    if (io !== undefined) {
      io.stdout(stdout);
    }
  } else if (!ok && error !== undefined) {
    stderr = formatCommandError(error, command, json);
    if (io !== undefined) {
      io.stderr(stderr);
    }
  }

  return {
    exitCode,
    ok,
    ...(command !== undefined ? { command } : {}),
    stdout,
    stderr,
    ...(data !== undefined ? { data } : {}),
    ...(error !== undefined ? { error } : {})
  };
}

export async function executeCommand(
  parsed: ParsedCliCommand,
  context?: CliContext | undefined
): Promise<CliExecutionResult> {
  const cwd = context?.cwd ?? process.cwd();
  const io = context?.io;

  if (parsed.command === "help") {
    const helpText = getHelpText(parsed.topic);
    const data: CliCommandData = {
      helpText,
      ...(parsed.topic !== undefined ? { topic: parsed.topic } : {})
    };
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "help", data, undefined, parsed.json, io);
  }

  if (parsed.command === "version") {
    const data: CliCommandData = {
      version: CLI_VERSION
    };
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "version", data, undefined, parsed.json, io);
  }

  if (parsed.command === "init") {
    const initRes = await initRepositoryConfig({
      cwd,
      ...(parsed.dir !== undefined ? { dir: parsed.dir } : {}),
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      ...(parsed.projectName !== undefined ? { projectName: parsed.projectName } : {}),
      force: parsed.force,
      ...(context?.clock !== undefined ? { clock: context.clock } : {}),
      ...(context?.confirmOverwrite !== undefined ? { confirmOverwrite: context.confirmOverwrite } : {})
    });

    if (!initRes.ok) {
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "init", undefined, initRes.error, parsed.json, io);
    }

    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "init", initRes.value, undefined, parsed.json, io);
  }

  if (context?.runtime === undefined) {
    const error: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: "RuntimeService is not configured. Provide a RuntimeService instance in CliContext."
    };
    return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, parsed.command, undefined, error, parsed.json, io);
  }

  const runtime = context.runtime;
  const now = context.clock !== undefined ? context.clock() : new Date();
  const isoNow = now.toISOString();

  switch (parsed.command) {
    case "run": {
      let definition: WorkflowDefinition;
      if (parsed.workflowPath !== undefined) {
        const fullWfPath = isAbsolute(parsed.workflowPath) ? parsed.workflowPath : resolve(cwd, parsed.workflowPath);
        const wfRes = await loadWorkflowDefinitionFromFile(fullWfPath);
        if (!wfRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, wfRes.error, parsed.json, io);
        }
        definition = wfRes.value;
      } else {
        const resolvedCfg = resolveConfigPath(cwd, parsed.configPath);
        const cfgRes = await loadRepositoryConfig(resolvedCfg);
        if (cfgRes.ok) {
          definition = cfgRes.value.defaultWorkflow;
        } else if (cfgRes.error.code === "not_found") {
          if (parsed.configPath === undefined) {
            definition = createDefaultWorkflowDefinition();
          } else {
            return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, cfgRes.error, parsed.json, io);
          }
        } else {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, cfgRes.error, parsed.json, io);
        }
      }

      const runId = parsed.runId ?? `run-${randomUUID()}`;
      const startInput = {
        runId,
        definition,
        input: { requirement: parsed.requirement },
        idempotencyKey: parsed.idempotencyKey ?? `start-${runId}`,
        requestedAt: isoNow,
        metadata: { source: "cli", requirement: parsed.requirement }
      };

      const parseInput = StartRunInputSchema.safeParse(startInput);
      if (!parseInput.success) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Invalid start run input: ${parseInput.error.issues.map((i) => i.message).join("; ")}`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "run", undefined, err, parsed.json, io);
      }

      const startRes = await runtime.start(parseInput.data, context.operationOptions);
      if (!startRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, startRes.error, parsed.json, io);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "run", startRes.value, undefined, parsed.json, io);
    }

    case "status": {
      if (parsed.runId !== undefined) {
        const getRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!getRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, getRes.error, parsed.json, io);
        }
        if (getRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, notFoundErr, parsed.json, io);
        }
        return makeResult(CLI_EXIT_CODES.SUCCESS, true, "status", getRes.value, undefined, parsed.json, io);
      }

      const query = {
        ...(parsed.statusFilter !== undefined ? { status: [...parsed.statusFilter] } : {}),
        ...(parsed.workflowId !== undefined ? { workflowId: parsed.workflowId } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {})
      };

      const parseQuery = RunQuerySchema.safeParse(query);
      if (!parseQuery.success) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Invalid run query: ${parseQuery.error.issues.map((i) => i.message).join("; ")}`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "status", undefined, err, parsed.json, io);
      }

      const findRes = await runtime.findRuns(parseQuery.data, context.operationOptions);
      if (!findRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, findRes.error, parsed.json, io);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "status", findRes.value, undefined, parsed.json, io);
    }

    case "approve": {
      const decidedBy = parsed.decidedBy ?? "human_operator";
      if (!isHumanApprover(decidedBy)) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Mandatory human approval cannot be satisfied by an automated or AI actor ('${decidedBy}').`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "approve", undefined, err, parsed.json, io);
      }

      let resolvedRunId: string;
      let resolvedGeneration: number;

      if (parsed.runId !== undefined) {
        const getRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!getRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, getRes.error, parsed.json, io);
        }
        if (getRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, parsed.json, io);
        }
        const taskState = getRes.value.tasks.find((t) => t.taskId === parsed.taskId);
        if (taskState === undefined) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Task '${parsed.taskId}' not found in run '${parsed.runId}'.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, parsed.json, io);
        }
        resolvedRunId = parsed.runId;
        resolvedGeneration = parsed.generation ?? taskState.generation;
      } else {
        const allRuns: WorkflowRunSnapshot[] = [];
        let pageCursor: string | undefined = undefined;
        const visitedCursors = new Set<string>();

        while (true) {
          const findRes = await runtime.findRuns(
            pageCursor !== undefined ? { cursor: pageCursor } : {},
            context.operationOptions
          );
          if (!findRes.ok) {
            return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, findRes.error, parsed.json, io);
          }
          allRuns.push(...findRes.value.items);
          if (!findRes.value.nextCursor || visitedCursors.has(findRes.value.nextCursor)) {
            break;
          }
          visitedCursors.add(findRes.value.nextCursor);
          pageCursor = findRes.value.nextCursor;
        }

        const matchingRuns = allRuns.filter((r) => r.tasks.some((t) => t.taskId === parsed.taskId));
        if (matchingRuns.length === 0) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `No run found containing task '${parsed.taskId}'. Specify --run <run-id>.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, parsed.json, io);
        }

        const activeRuns = matchingRuns.filter((r) =>
          ["waiting", "blocked", "running", "queued"].includes(r.status)
        );

        const awaitingApprovalRuns = activeRuns.filter((r) => {
          const t = r.tasks.find((task) => task.taskId === parsed.taskId);
          return t !== undefined && (t.status === "waiting" || t.blockage?.code === "awaiting_approval");
        });

        let candidates: readonly WorkflowRunSnapshot[];
        if (awaitingApprovalRuns.length > 0) {
          candidates = awaitingApprovalRuns;
        } else if (activeRuns.length > 0) {
          candidates = activeRuns;
        } else {
          candidates = matchingRuns;
        }

        if (candidates.length > 1) {
          const conflictErr: ContractError = {
            code: "conflict",
            retryable: true,
            message: `Multiple active runs contain task '${parsed.taskId}'. Specify --run <run-id>.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, conflictErr, parsed.json, io);
        }

        const targetRun = candidates[0]!;
        resolvedRunId = targetRun.runId;
        const taskState = targetRun.tasks.find((t) => t.taskId === parsed.taskId)!;
        resolvedGeneration = parsed.generation ?? taskState.generation;
      }

      const decision = {
        schemaVersion: 1,
        approvalId: parsed.approvalId ?? `appr-${randomUUID()}`,
        runId: resolvedRunId,
        target: { type: "task" as const, taskId: parsed.taskId },
        revision: parsed.revision ?? 1,
        generation: resolvedGeneration,
        decision: parsed.decision,
        decidedBy,
        decidedAt: isoNow,
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        feedbackArtifacts: [],
        idempotencyKey: parsed.idempotencyKey ?? `approve-${resolvedRunId}-${parsed.taskId}-${randomUUID()}`
      };

      const parseDec = ApprovalDecisionSchema.safeParse(decision);
      if (!parseDec.success) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Invalid approval decision: ${parseDec.error.issues.map((i) => i.message).join("; ")}`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "approve", undefined, err, parsed.json, io);
      }

      const decideRes = await runtime.decide(parseDec.data, context.operationOptions);
      if (!decideRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, decideRes.error, parsed.json, io);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "approve", decideRes.value, undefined, parsed.json, io);
    }

    case "resume": {
      const resumeInput = {
        runId: parsed.runId,
        idempotencyKey: parsed.idempotencyKey ?? `resume-${parsed.runId}-${randomUUID()}`,
        requestedAt: isoNow
      };

      const parseResume = ResumeRunInputSchema.safeParse(resumeInput);
      if (!parseResume.success) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Invalid resume run input: ${parseResume.error.issues.map((i) => i.message).join("; ")}`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "resume", undefined, err, parsed.json, io);
      }

      const resumeRes = await runtime.resume(parseResume.data, context.operationOptions);
      if (!resumeRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "resume", undefined, resumeRes.error, parsed.json, io);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "resume", resumeRes.value, undefined, parsed.json, io);
    }

    case "cancel": {
      let expectedVersion = parsed.expectedVersion;
      if (expectedVersion === undefined) {
        const snapRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!snapRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, snapRes.error, parsed.json, io);
        }
        if (snapRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, notFoundErr, parsed.json, io);
        }
        expectedVersion = snapRes.value.version;
      }

      const cancelReq = {
        schemaVersion: 1,
        cancellationId: `cancel-${randomUUID()}`,
        runId: parsed.runId,
        ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
        requestedBy: parsed.requestedBy ?? "human_operator",
        requestedAt: isoNow,
        expectedVersion,
        reason: parsed.reason ?? "Cancelled by operator via CLI",
        idempotencyKey: parsed.idempotencyKey ?? `cancel-key-${randomUUID()}`
      };

      const parseCancel = CancellationRequestSchema.safeParse(cancelReq);
      if (!parseCancel.success) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Invalid cancellation request: ${parseCancel.error.issues.map((i) => i.message).join("; ")}`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "cancel", undefined, err, parsed.json, io);
      }

      const cancelRes = await runtime.cancel(parseCancel.data, context.operationOptions);
      if (!cancelRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, cancelRes.error, parsed.json, io);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "cancel", cancelRes.value, undefined, parsed.json, io);
    }
  }
}

export async function runCli(
  argv: readonly string[],
  context?: CliContext | undefined
): Promise<CliExecutionResult> {
  const parseRes = parseCliArgs(argv);
  if (!parseRes.ok) {
    const stderr = formatCommandError(parseRes.error, parseRes.command, parseRes.json);
    if (context?.io !== undefined) {
      context.io.stderr(stderr);
    }
    return {
      exitCode: CLI_EXIT_CODES.USAGE_ERROR,
      ok: false,
      ...(parseRes.command !== undefined ? { command: parseRes.command } : {}),
      stdout: "",
      stderr,
      error: parseRes.error
    };
  }

  return executeCommand(parseRes.value, context);
}
