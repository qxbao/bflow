import { EnvironmentLifecycle } from "./environment.js";
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
} from "@bflow/contracts";
import { isHumanApprover } from "@bflow/runtime";
import {
  createDefaultWorkflowDefinition,
  initRepositoryConfig,
  loadRepositoryConfig,
  loadWorkflowDefinitionFromFile,
  resolveReadableConfigPath
} from "./config.js";
import {
  isStderrInteractive,
  resolveStreamColor,
  toContractError
} from "./presentation.js";
import { formatCommandError, formatCommandSuccess } from "./formatters.js";
import { getHelpText } from "./help.js";
import { parseCliArgs } from "./parser.js";
import { isHighLevelInvocation, runHighLevelCli, type HighLevelRunOptions } from "./high-level/index.js";
import {
  CLI_EXIT_CODES,
  type CliCommandData,
  type CliCommandName,
  type CliContext,
  type CliExecutionResult,
  type CliExitCode,
  type CliIo,
  type HighLevelParsedCliCommand,
  type ParsedCliCommand,
  type PresentationOptions
} from "./types.js";
import { executeHighLevelCommand, isHighLevelCommand } from "./high-level-commands.js";
import { executeSetupCommand } from "./setup-integration.js";
import { codexHookSetupSucceeded, executeCodexHookSetup } from "./codex-hook-setup.js";
import { migrateRepositoryConfig } from "./config-migration.js";
import { CliProgress } from "./progress.js";
import { isIsoInvocation, runIsolator } from "./iso.js";

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

export function resolvePresentation(
  context?: CliContext | undefined,
  json = false,
  isDefaultIo = false
): PresentationOptions {
  if (json || context?.presentation?.json) {
    return {
      stdoutColor: false,
      stderrColor: false,
      interactive: false,
      json: true
    };
  }
  const defaultIo = isDefaultIo || Boolean(context?.presentation?.isDefaultIo) || context?.io === undefined;
  const customIo = context?.io !== undefined && !defaultIo;
  const isCustomInteractive = Boolean(context?.presentation?.interactive);
  const isStdoutTTY = customIo ? isCustomInteractive : Boolean(process.stdout.isTTY);
  const isStderrTTY = customIo ? isCustomInteractive : Boolean(process.stderr.isTTY);

  const stdoutColor = resolveStreamColor({
    isTTY: isStdoutTTY,
    env: process.env,
    explicit: customIo ? context?.presentation?.stdoutColor ?? false : context?.presentation?.stdoutColor
  });

  const stderrColor = resolveStreamColor({
    isTTY: isStderrTTY,
    env: process.env,
    explicit: customIo ? context?.presentation?.stderrColor ?? false : context?.presentation?.stderrColor
  });

  const interactive = isStderrInteractive({
    isTTY: isStderrTTY,
    env: process.env,
    explicitInteractive: customIo ? context?.presentation?.interactive ?? false : context?.presentation?.interactive
  });

  return {
    stdoutColor,
    stderrColor,
    interactive,
    json: false,
    ...(defaultIo ? { isDefaultIo: true } : {})
  };
}

function makeResult(
  exitCode: CliExitCode,
  ok: boolean,
  command: CliCommandName | undefined,
  data: CliCommandData | undefined,
  error: ContractError | undefined,
  json: boolean,
  io?: CliIo | undefined,
  presentation?: PresentationOptions | undefined
): CliExecutionResult {
  let stdout = "";
  let stderr = "";

  if (ok && data !== undefined && command !== undefined) {
    stdout = formatCommandSuccess(command, data, json, presentation);
    if (io !== undefined) {
      io.stdout(stdout);
    }
  } else if (!ok && error !== undefined) {
    const formatted = formatCommandError(error, command, json, presentation);
    stderr = formatted;
    if (json) {
      stdout = formatted;
    }
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
  const presentation = resolvePresentation(context, Boolean(parsed.json));
  const progress = new CliProgress({
    enabled: Boolean(presentation.interactive) && !presentation.json && parsed.command !== "help" && parsed.command !== "version",
    color: presentation.stderrColor,
    io: context?.io,
    // Herdr owns the terminal during attach.
    animate: parsed.command !== "attach"
  });
  const io = context?.io;
  const executionContext = io ? { ...context, io: { ...io,
    stdout: (message: string) => { if (!progress.awaitingInput) progress.stop(); io.stdout(message); },
    stderr: (message: string) => { if (!progress.awaitingInput) progress.stop(); io.stderr(message); }
  } } : context;
  try { return await executeCommandWithProgress(parsed, executionContext, progress); }
  finally { progress.stop(); }
}

async function executeCommandWithProgress(
  parsed: ParsedCliCommand,
  context: CliContext | undefined,
  progress: CliProgress
): Promise<CliExecutionResult> {
  const cwd = context?.cwd ?? process.cwd();
  const io = context?.io;
  const isJson = Boolean(parsed.json) || Boolean(context?.presentation?.json);
  const presentation = resolvePresentation(context, isJson);
  const showProgress = presentation.interactive && !isJson && parsed.command !== "help" && parsed.command !== "version";
  const emitProgress = (step: string) => {
    progress.step(step);
  };

  if (parsed.command === "help") {
    const helpText = getHelpText(parsed.topic);
    const data: CliCommandData = {
      helpText,
      ...(parsed.topic !== undefined ? { topic: parsed.topic } : {})
    };
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "help", data, undefined, isJson, io, presentation);
  }

  if (parsed.command === "version") {
    const data: CliCommandData = {
      version: CLI_VERSION
    };
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "version", data, undefined, isJson, io, presentation);
  }

  if (isHighLevelCommand(parsed.command)) {
    if (showProgress) emitProgress(`Executing ${parsed.command} command...`);
    const hlResult = await executeHighLevelCommand(
      parsed as HighLevelParsedCliCommand,
      context
    );
    return makeResult(
      hlResult.exitCode,
      hlResult.ok,
      parsed.command,
      hlResult.data,
      hlResult.error,
      isJson,
      io,
      presentation
    );
  }

  if (parsed.command === "config-migrate") {
    try {
      const output = await migrateRepositoryConfig(cwd);
      return makeResult(CLI_EXIT_CODES.SUCCESS, true, parsed.command, output, undefined, isJson, io, presentation);
    } catch (error) {
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, parsed.command, undefined, toContractError(error), isJson, io, presentation);
    }
  }

  if (["up", "down", "attach", "doctor", "recover"].includes(parsed.command) ||
    parsed.command === "status" && parsed.runId === undefined && parsed.statusFilter === undefined &&
    parsed.workflowId === undefined && parsed.limit === undefined && parsed.cursor === undefined && context?.runtime === undefined) {
    const envDeps = {
      ...context?.environment,
      ...(context?.operationOptions?.signal ? { signal: context.operationOptions.signal } : {}),
      onProgressDetail: (message: string) => {
        try {
          if (context?.environment?.onProgressDetail) context.environment.onProgressDetail(message);
          else context?.environment?.onProgress?.(message);
        } catch {}
        if (showProgress) progress.detail(message);
      },
      onProgress: (step: string) => {
        try { context?.environment?.onProgress?.(step); } catch {}
        if (showProgress) {
          try { emitProgress(step); } catch {}
        }
      }
    };
    const lifecycle = new EnvironmentLifecycle(cwd, envDeps);
    try {
      let data: CliCommandData;
      switch (parsed.command) {
        case "up": data = await lifecycle.up(parsed.timeoutMs); break;
        case "down": data = await lifecycle.down(parsed.yes, parsed.timeoutMs, parsed.force); break;
        case "attach": data = await lifecycle.attach(); break;
        case "recover": data = await lifecycle.recover(parsed.yes); break;
        case "doctor": data = await lifecycle.doctor(parsed.deep); break;
        default: data = await lifecycle.status();
      }
      const healthy = ( !("healthy" in data) || data.healthy ) && ( !("configuration" in data) || data.configuration === "valid" );
      return makeResult(healthy ? 0 : 1, true, parsed.command, data, undefined, isJson, io, presentation);
    } catch (error) {
      const contractError = toContractError(error);
      return makeResult(1, false, parsed.command, undefined, contractError, isJson, io, presentation);
    }
  }

  if (parsed.command === "init") {
    if (showProgress) {
      emitProgress("Initializing repository configuration...");
    }
    const initRes = await initRepositoryConfig({
      cwd,
      ...(parsed.dir !== undefined ? { dir: parsed.dir } : {}),
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      ...(parsed.projectName !== undefined ? { projectName: parsed.projectName } : {}),
      ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
      force: parsed.force,
      ...(context?.clock !== undefined ? { clock: context.clock } : {}),
      ...(context?.confirmOverwrite !== undefined ? { confirmOverwrite: context.confirmOverwrite } : {})
    });

    if (!initRes.ok) {
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "init", undefined, initRes.error, isJson, io, presentation);
    }

    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "init", initRes.value, undefined, isJson, io, presentation);
  }

  if (parsed.command === "docs") {
    try {
      const { executeDocsCommand } = await import("./docs-command.js");
      const data = await executeDocsCommand(parsed, context, showProgress ? emitProgress : undefined);
      return makeResult(data.ok ? CLI_EXIT_CODES.SUCCESS : CLI_EXIT_CODES.RUNTIME_ERROR, true, "docs", data, undefined, isJson, io, presentation);
    } catch (error) {
      const contractError = toContractError(error);
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "docs", undefined, contractError, isJson, io, presentation);
    }
  }

  if (parsed.command === "setup") {
    if (parsed.codexHooks) {
      try {
        const data = await executeCodexHookSetup(parsed, context, showProgress ? {
          step: emitProgress, confirm: action => progress.confirmation(action)
        } : undefined);
        return makeResult(codexHookSetupSucceeded(data) ? CLI_EXIT_CODES.SUCCESS : CLI_EXIT_CODES.RUNTIME_ERROR,
          true, "setup", data, undefined, isJson, io, presentation);
      } catch (error) {
        const contractError = toContractError(error);
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "setup", undefined, contractError, isJson, io, presentation);
      }
    }
    try {
      const data = await executeSetupCommand(parsed, context, showProgress ? emitProgress : undefined,
        showProgress ? { detail: message => progress.detail(message), important: message => progress.important(message),
          units: (completed, total, label) => progress.units(completed, total, label),
          confirm: action => progress.confirmation(action) } : undefined);
      const successful = data.outcome === undefined || ["healthy", "applied"].includes(data.outcome) ||
        parsed.mode === "dry_run" && data.outcome === "changes_pending";
      return makeResult(successful ? CLI_EXIT_CODES.SUCCESS : CLI_EXIT_CODES.RUNTIME_ERROR, true, "setup", data, undefined, isJson, io, presentation);
    } catch (error) {
      const contractError = toContractError(error);
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "setup", undefined, contractError, isJson, io, presentation);
    }
  }

  if (parsed.command === "up" || parsed.command === "down" || parsed.command === "attach" || parsed.command === "doctor" || parsed.command === "recover") {
    throw new Error("Unreachable environment command");
  }
  if (context?.runtime === undefined) {
    const error: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: "RuntimeService is not configured. Provide a RuntimeService instance in CliContext."
    };
    return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, parsed.command, undefined, error, isJson, io, presentation);
  }

  if (showProgress) {
    emitProgress(`Executing ${parsed.command} command...`);
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
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, wfRes.error, isJson, io, presentation);
        }
        definition = wfRes.value;
      } else {
        const resolvedCfg = resolveReadableConfigPath(cwd, parsed.configPath);
        const cfgRes = await loadRepositoryConfig(resolvedCfg);
        if (cfgRes.ok) {
          definition = cfgRes.value.defaultWorkflow;
        } else if (cfgRes.error.code === "not_found") {
          if (parsed.configPath === undefined) {
            definition = createDefaultWorkflowDefinition();
          } else {
            return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, cfgRes.error, isJson, io, presentation);
          }
        } else {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, cfgRes.error, isJson, io, presentation);
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
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "run", undefined, err, isJson, io, presentation);
      }

      const startRes = await runtime.start(parseInput.data, context.operationOptions);
      if (!startRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, startRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "run", startRes.value, undefined, isJson, io, presentation);
    }

    case "status": {
      if (parsed.runId !== undefined) {
        const getRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!getRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, getRes.error, isJson, io, presentation);
        }
        if (getRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, notFoundErr, isJson, io, presentation);
        }
        return makeResult(CLI_EXIT_CODES.SUCCESS, true, "status", getRes.value, undefined, isJson, io, presentation);
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
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "status", undefined, err, isJson, io, presentation);
      }

      const findRes = await runtime.findRuns(parseQuery.data, context.operationOptions);
      if (!findRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "status", undefined, findRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "status", findRes.value, undefined, isJson, io, presentation);
    }

    case "approve": {
      const decidedBy = parsed.decidedBy ?? "human_operator";
      if (!isHumanApprover(decidedBy)) {
        const err: ContractError = {
          code: "validation",
          retryable: false,
          message: `Mandatory human approval cannot be satisfied by an automated or AI actor ('${decidedBy}').`
        };
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "approve", undefined, err, isJson, io, presentation);
      }

      let resolvedRunId: string;
      let resolvedGeneration: number;

      if (parsed.runId !== undefined) {
        const getRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!getRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, getRes.error, isJson, io, presentation);
        }
        if (getRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, isJson, io, presentation);
        }
        const taskState = getRes.value.tasks.find((t) => t.taskId === parsed.taskId);
        if (taskState === undefined) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Task '${parsed.taskId}' not found in run '${parsed.runId}'.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, isJson, io, presentation);
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
            return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, findRes.error, isJson, io, presentation);
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
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, notFoundErr, isJson, io, presentation);
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
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, conflictErr, isJson, io, presentation);
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
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "approve", undefined, err, isJson, io, presentation);
      }

      const decideRes = await runtime.decide(parseDec.data, context.operationOptions);
      if (!decideRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, decideRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "approve", decideRes.value, undefined, isJson, io, presentation);
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
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "resume", undefined, err, isJson, io, presentation);
      }

      const resumeRes = await runtime.resume(parseResume.data, context.operationOptions);
      if (!resumeRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "resume", undefined, resumeRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "resume", resumeRes.value, undefined, isJson, io, presentation);
    }

    case "cancel": {
      let expectedVersion = parsed.expectedVersion;
      if (expectedVersion === undefined) {
        const snapRes = await runtime.getRun(parsed.runId, context.operationOptions);
        if (!snapRes.ok) {
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, snapRes.error, isJson, io, presentation);
        }
        if (snapRes.value === null) {
          const notFoundErr: ContractError = {
            code: "not_found",
            retryable: false,
            message: `Run '${parsed.runId}' not found.`
          };
          return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, notFoundErr, isJson, io, presentation);
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
        return makeResult(CLI_EXIT_CODES.USAGE_ERROR, false, "cancel", undefined, err, isJson, io, presentation);
      }

      const cancelRes = await runtime.cancel(parseCancel.data, context.operationOptions);
      if (!cancelRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "cancel", undefined, cancelRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "cancel", cancelRes.value, undefined, isJson, io, presentation);
    }
  }
}

export async function runCli(
  argv: readonly string[],
  context?: CliContext | undefined
): Promise<CliExecutionResult> {
  if (isIsoInvocation(argv)) {
    return runIsolator(argv.slice(1), context);
  }
  if (argv[0] === "help" && argv[1] === "iso") {
    const helpText = getIsoHelpText();
    context?.io?.stdout(helpText);
    return { command: "help", exitCode: 0, ok: true, stdout: helpText, stderr: "" };
  }
  const useFacadePath =
    context?.highLevel !== undefined ||
    (context?.cwd !== undefined &&
      context?.io === undefined &&
      context?.highLevelServices === undefined);
  if (!useFacadePath && isHighLevelInvocation(argv)) {
    const options: HighLevelRunOptions = {
      cwd: context?.cwd, io: context?.io, clock: context?.clock, services: context?.highLevelServices,
      runtime: context?.runtime as HighLevelRunOptions["runtime"], signal: context?.operationOptions?.signal,
      presentation: resolvePresentation(context, Boolean(context?.presentation?.json))
    };
    const effectiveArgv = context?.presentation?.json ? ["--json", ...argv] : argv;
    const result = await runHighLevelCli(effectiveArgv, options);
    return {
      exitCode: result.exitCode,
      ok: result.ok,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.envelope !== undefined ? { highLevel: result.envelope } : {}),
      ...(result.error !== undefined ? { error: result.error } : {})
    };
  }
  const parseRes = parseCliArgs(argv);
  if (!parseRes.ok) {
    const isJson = Boolean(parseRes.json) || Boolean(context?.presentation?.json);
    const presentation = resolvePresentation(context, isJson);
    const stderr = formatCommandError(parseRes.error, parseRes.command, isJson, presentation);
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

export function getIsoHelpText(): string {
  return `Usage: bflow iso <command> [arguments]

Run isolated provider profiles. Provider arguments are passed through unchanged.

Commands:
  codex, claude, agy  Launch a provider profile [--name NAME] [--] [ARGS...]
  run <provider>      Launch a provider profile [--name NAME] [--] [ARGS...]
  login <provider>    Start provider login/onboarding [--name NAME]
  status              List profiles; Agy authentication is unverified
  sync-skills         Sync Codex skills: --name NAME or --all [--source PATH]
  remove <provider>   Remove a profile and its managed aliases
  help                Show this help
  version             Show engine version

Examples:
  bflow iso codex --name work -- --help
  bflow iso run claude --name personal -- --help
  bflow iso login agy --name personal
  bflow iso status
  bflow iso sync-skills --name work
  bflow iso sync-skills --all

Agy login opens Agy's native onboarding UI. Profile status does not probe Agy auth or models and reports its authentication as unverified. The original ai-isolator v0.4.4 supports two-way profile compatibility with Codex and Claude; Agy is a Bflow addition and is not supported by that original version.

Requires Bash, Python 3.11 or newer, and curl or wget for MCP synchronization and linked-provider checks. POSIX ps is used to clean up provider processes when bflow receives SIGTERM. Git Bash process-tree cleanup is unverified.`;
}
