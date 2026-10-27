import { EnvironmentLifecycle } from "./environment.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
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
  sanitizeIdentifier,
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
  type InitCommandArgs,
  type InitCommandOutput,
  type ParsedCliCommand,
  type PresentationOptions
} from "./types.js";
import { executeHighLevelCommand, isHighLevelCommand } from "./high-level-commands.js";
import { executeSetupCommand } from "./setup-integration.js";
import { defaultEnvironmentConfig, ENVIRONMENT_CONFIG_PATH, readEnvironmentConfig } from "./environment-config.js";
import { identifyRepository } from "./repository.js";
import {
  checkRepositoryGitNexus,
  gitNexusServiceId,
  GITNEXUS_POLYFORM_NOTICE,
  isRepositoryGitNexusRegistered,
  prepareRepositoryGitNexus,
  removeRepositoryGitNexus,
  resolveSetupPlatform
} from "./gateway-repositories.js";
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
  isDefaultIo = false,
  isDebug = false
): PresentationOptions {
  const debug = Boolean(isDebug || context?.presentation?.debug);
  if (json || context?.presentation?.json) {
    return {
      stdoutColor: false,
      stderrColor: false,
      interactive: false,
      json: true,
      debug
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
    debug,
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
  const effectivePresentation = presentation !== undefined
    ? { ...presentation, debug: Boolean(presentation.debug) }
    : undefined;

  if (ok && data !== undefined && command !== undefined) {
    stdout = formatCommandSuccess(command, data, json, effectivePresentation);
    if (io !== undefined) {
      io.stdout(stdout);
    }
  } else if (!ok && error !== undefined) {
    const formatted = formatCommandError(error, command, json, effectivePresentation);
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
  const isDebug = Boolean("debug" in parsed && parsed.debug) || Boolean(context?.presentation?.debug);
  const presentation = resolvePresentation(context, Boolean(parsed.json), false, isDebug);
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

export async function promptConfirmOverwrite(configPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const safePath = sanitizeIdentifier(configPath);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await terminal.question(`Tệp cấu hình đã tồn tại tại ${safePath}. Bạn có muốn ghi đè không? [y/N] `)).trim());
  } finally {
    terminal.close();
  }
}

/**
 * Asks before the first GitNexus index of a repository; non-interactive runs need --yes or
 * --accept-gitnexus-license. Unlike --yes, --accept-gitnexus-license does not force config overwrite.
 */
async function approveGitNexusIndexing(
  args: InitCommandArgs,
  repositoryRoot: string,
  context: CliContext | undefined,
  progress: CliProgress | undefined
): Promise<boolean> {
  if (args.yes || args.acceptGitnexusLicense) return true;
  const prompt = `${GITNEXUS_POLYFORM_NOTICE}\n\nTạo chỉ mục '${repositoryRoot}' bằng GitNexus (ghi .gitnexus/ và .git/info/exclude) và đăng ký dịch vụ Gateway?`;
  const ask = async () => {
    if (context?.setup?.confirm) return context.setup.confirm(prompt);
    if (args.json || !process.stdin.isTTY || !process.stderr.isTTY) return false;
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^(y|yes)$/i.test((await terminal.question(`${prompt} [y/N] `)).trim()); }
    finally { terminal.close(); }
  };
  return progress ? progress.confirmation(ask) : ask();
}

async function executeCommandWithProgress(
  parsed: ParsedCliCommand,
  context: CliContext | undefined,
  progress: CliProgress
): Promise<CliExecutionResult> {
  const cwd = context?.cwd ?? process.cwd();
  const io = context?.io;
  const isJson = Boolean(parsed.json) || Boolean(context?.presentation?.json);
  const isDebug = Boolean("debug" in parsed && parsed.debug) || Boolean(context?.presentation?.debug);
  const presentation = resolvePresentation(context, isJson, false, isDebug);
  const showProgress = presentation.interactive && !isJson && parsed.command !== "help" && parsed.command !== "version";
  const emitProgress = (step: string, detail?: string) => {
    progress.step(step, detail);
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
    if (showProgress) emitProgress(`Đang thực thi lệnh ${parsed.command}...`);
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
    if (showProgress) {
      emitProgress("Chuyển đổi cấu hình kho mã nguồn", "Kiểm tra tệp cấu hình cũ và tạo bản sao lưu an toàn");
    }
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
        case "up":
          if (showProgress) emitProgress("Khởi động môi trường Bflow", "Kiểm tra điều kiện cần thiết và khởi chạy các vai trò");
          data = await lifecycle.up(parsed.timeoutMs);
          break;
        case "down":
          if (showProgress) emitProgress("Dừng môi trường Bflow", "Đóng phiên làm việc và giải phóng tài nguyên cục bộ");
          data = await lifecycle.down(parsed.yes, parsed.timeoutMs, parsed.force);
          break;
        case "attach":
          if (showProgress) emitProgress("Kết nối khung chat Conversation", "Chuyển tiêu điểm tới phiên Herdr của kho mã nguồn");
          data = await lifecycle.attach();
          break;
        case "recover":
          if (showProgress) emitProgress("Khôi phục môi trường Bflow", "Đối soát trạng thái phiên, vai trò và khóa vòng đời");
          data = await lifecycle.recover(parsed.yes);
          break;
        case "doctor":
          if (showProgress) emitProgress("Kiểm tra sức khỏe môi trường", "Đánh giá công cụ, agent, MCP, kỹ năng và trạng thái phiên");
          data = await lifecycle.doctor(parsed.deep);
          break;
        default:
          if (showProgress) emitProgress("Kiểm tra trạng thái môi trường", "Đọc trạng thái phiên và dịch vụ hiện tại");
          data = await lifecycle.status();
      }
      const healthy = ( !("healthy" in data) || data.healthy ) && ( !("configuration" in data) || data.configuration === "valid" );
      return makeResult(healthy ? 0 : 1, true, parsed.command, data, undefined, isJson, io, presentation);
    } catch (error) {
      const contractError = toContractError(error);
      return makeResult(1, false, parsed.command, undefined, contractError, isJson, io, presentation);
    }
  }

  if (parsed.command === "init") {
    const targetDir = resolve(cwd, parsed.dir ?? ".");
    if (parsed.check) {
      if (showProgress) {
        emitProgress("Chuẩn bị kho mã nguồn", "Kiểm tra thông tin Git và cấu hình Bflow");
      }
      try {
        const repository = await identifyRepository(targetDir);
        const configPath = resolve(repository.root, parsed.configPath ?? ENVIRONMENT_CONFIG_PATH);
        let envConfig: Awaited<ReturnType<typeof readEnvironmentConfig>> | undefined;
        let configValid = false;
        const configDiagnostics: string[] = [];
        try {
          envConfig = await readEnvironmentConfig(repository);
          configValid = true;
        } catch (error) {
          configDiagnostics.push(error instanceof Error ? error.message : String(error));
        }
        const platform = resolveSetupPlatform(context);
        const rawGitnexus = await checkRepositoryGitNexus({ repository, platform });
        const gitnexusEnabled = envConfig ? envConfig.environment.tools?.gitnexus?.enabled !== false : true;
        const gitnexus = gitnexusEnabled
          ? rawGitnexus
          : {
              ...rawGitnexus,
              status: "skipped" as const,
              diagnostics: ["GitNexus is disabled in .bflow/config.yml (tools.gitnexus.enabled: false)."]
            };
        const healthy = configValid && (!gitnexusEnabled || gitnexus.status === "ready");
        const diagnostics = [
          ...(!configValid
            ? [`Repository configuration is missing or invalid (${configDiagnostics.join("; ") || configPath}); run 'bflow init' in '${repository.root}'.`]
            : []),
          ...gitnexus.diagnostics
        ];
        const config = envConfig ?? defaultEnvironmentConfig(repository, parsed.projectName, context?.clock?.(), parsed.provider);
        const output: InitCommandOutput = {
          configPath,
          config,
          overwritten: false,
          mode: "check",
          healthy,
          configValid,
          gitnexus,
          diagnostics
        };
        return makeResult(
          healthy ? CLI_EXIT_CODES.SUCCESS : CLI_EXIT_CODES.RUNTIME_ERROR,
          true,
          "init",
          output,
          undefined,
          isJson,
          io,
          presentation
        );
      } catch (error) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "init", undefined, toContractError(error), isJson, io, presentation);
      }
    }

    if (parsed.remove) {
      if (showProgress) {
        emitProgress("Cấu hình GitNexus", "Gỡ đăng ký dịch vụ GitNexus của kho mã nguồn");
      }
      try {
        // A deleted repository can still be unregistered by its former path.
        const repository = await identifyRepository(targetDir).catch(() => undefined);
        const workspaceRoot = repository?.root ?? targetDir;
        const configPath = resolve(workspaceRoot, parsed.configPath ?? ENVIRONMENT_CONFIG_PATH);
        const platform = resolveSetupPlatform(context);
        const gitnexus = await removeRepositoryGitNexus({ workspaceRoot, platform });
        const loaded = repository ? await loadRepositoryConfig(configPath) : undefined;
        const config = loaded?.ok ? loaded.value : undefined;
        const output: InitCommandOutput = {
          configPath,
          ...(config ? { config } : {}),
          overwritten: false,
          mode: "remove",
          healthy: true,
          gitnexus,
          diagnostics: gitnexus.diagnostics
        };
        return makeResult(CLI_EXIT_CODES.SUCCESS, true, "init", output, undefined, isJson, io, presentation);
      } catch (error) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "init", undefined, toContractError(error), isJson, io, presentation);
      }
    }

    if (showProgress) {
      emitProgress("Chuẩn bị kho mã nguồn", "Kiểm tra thông tin Git và cấu hình Bflow");
    }
    const initRes = await initRepositoryConfig({
      cwd,
      ...(parsed.dir !== undefined ? { dir: parsed.dir } : {}),
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      ...(parsed.projectName !== undefined ? { projectName: parsed.projectName } : {}),
      ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
      force: parsed.force,
      ...(parsed.update !== undefined ? { update: parsed.update } : {}),
      ...(context?.clock !== undefined ? { clock: context.clock } : {}),
      ...(context?.confirmOverwrite !== undefined ? { confirmOverwrite: context.confirmOverwrite } : {})
    });

    if (!initRes.ok) {
      return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "init", undefined, initRes.error, isJson, io, presentation);
    }

    const repository = await identifyRepository(targetDir);
    const platform = resolveSetupPlatform(context);
    let gitnexusEnabled = !parsed.noGitnexus;
    if (gitnexusEnabled) {
      try {
        const envConfig = await readEnvironmentConfig(repository);
        if (envConfig.environment.tools?.gitnexus?.enabled === false) {
          gitnexusEnabled = false;
        }
      } catch {
        // Keep gitnexusEnabled = true if environment config could not be read
      }
    }

    if (showProgress && gitnexusEnabled) {
      emitProgress("Cấu hình GitNexus", "Tạo và kiểm tra bộ chỉ mục mã nguồn cho kho này");
    }

    // GitNexus is PolyForm-Noncommercial and writes into the repository, so a first registration needs explicit approval.
    const approved = gitnexusEnabled && (await isRepositoryGitNexusRegistered({ repository, platform }) ||
      await approveGitNexusIndexing(parsed, repository.root, context, showProgress ? progress : undefined));
    const gitnexus = approved
      ? await prepareRepositoryGitNexus({ repository, platform })
      : gitnexusEnabled
        ? {
            status: "skipped" as const,
            serviceId: gitNexusServiceId(repository.root),
            indexed: false,
            registered: false,
            gatewayReady: false,
            diagnostics: [GITNEXUS_POLYFORM_NOTICE,
              "GitNexus indexing was not approved; rerun 'bflow init --accept-gitnexus-license' to accept the license and index this repository without overwriting .bflow/config.yml, or pass --no-gitnexus."]
          }
        : {
          status: "skipped" as const,
          serviceId: gitNexusServiceId(repository.root),
          indexed: false,
          registered: false,
          gatewayReady: false,
          diagnostics: [
            parsed.noGitnexus
              ? "GitNexus indexing and Gateway registration skipped (--no-gitnexus)."
              : "GitNexus indexing and Gateway registration skipped (tools.gitnexus.enabled: false in .bflow/config.yml)."
          ]
        };

    const output: InitCommandOutput = {
      ...initRes.value,
      mode: "init",
      healthy: !gitnexusEnabled || gitnexus.status === "ready",
      configValid: true,
      gitnexus,
      diagnostics: gitnexus.diagnostics
    };

    if (showProgress) {
      progress.done("Hoàn tất cấu hình kho mã nguồn ✓");
    }
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "init", output, undefined, isJson, io, presentation);
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
  if (parsed.command === "status" && parsed.telemetry && parsed.runId) {
    const { executeTelemetryStatus } = await import("./telemetry.js");
    const report = await executeTelemetryStatus(parsed.runId, context);
    return makeResult(CLI_EXIT_CODES.SUCCESS, true, "status", report, undefined, isJson, io, presentation);
  }
  if (context?.runtime === undefined) {
    const error: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: "RuntimeService is not configured. Provide a RuntimeService instance in CliContext."
    };
    return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, parsed.command, undefined, error, isJson, io, presentation);
  }

  const runtime = context.runtime;
  const now = context.clock !== undefined ? context.clock() : new Date();
  const isoNow = now.toISOString();

  switch (parsed.command) {
    case "run": {
      if (showProgress) {
        emitProgress("Đang tải cấu hình kho mã nguồn và định nghĩa quy trình...");
      }
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

      if (showProgress) {
        emitProgress("Đang khởi chạy quy trình làm việc...");
      }
      const startRes = await runtime.start(parseInput.data, context.operationOptions);
      if (!startRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "run", undefined, startRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "run", startRes.value, undefined, isJson, io, presentation);
    }

    case "status": {
      if (parsed.runId !== undefined) {
        if (showProgress) {
          emitProgress(`Đang truy vấn trạng thái luồng chạy '${parsed.runId}'...`);
        }
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

      if (showProgress) {
        emitProgress("Đang truy vấn danh sách luồng chạy...");
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

      if (showProgress) {
        emitProgress(`Đang xác định luồng chạy mục tiêu cho tác vụ '${parsed.taskId}'...`);
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

      if (showProgress) {
        emitProgress(`Đang ghi nhận quyết định phê duyệt (${parsed.decision}) cho tác vụ '${parsed.taskId}'...`);
      }

      const decideRes = await runtime.decide(parseDec.data, context.operationOptions);
      if (!decideRes.ok) {
        return makeResult(CLI_EXIT_CODES.RUNTIME_ERROR, false, "approve", undefined, decideRes.error, isJson, io, presentation);
      }

      return makeResult(CLI_EXIT_CODES.SUCCESS, true, "approve", decideRes.value, undefined, isJson, io, presentation);
    }

    case "resume": {
      if (showProgress) {
        emitProgress(`Đang tiếp tục luồng chạy '${parsed.runId}'...`);
      }

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
      if (showProgress) {
        emitProgress(`Đang hủy luồng chạy '${parsed.runId}'...`);
      }

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
    const isDebug = argv.includes("--debug") || Boolean(context?.presentation?.debug);
    const options: HighLevelRunOptions = {
      cwd: context?.cwd, io: context?.io, clock: context?.clock, services: context?.highLevelServices,
      runtime: context?.runtime as HighLevelRunOptions["runtime"], signal: context?.operationOptions?.signal,
      presentation: resolvePresentation(context, Boolean(context?.presentation?.json), false, isDebug)
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
    const isDebug = argv.includes("--debug") || Boolean(context?.presentation?.debug);
    const presentation = resolvePresentation(context, isJson, false, isDebug);
    const stderr = formatCommandError(parseRes.error, parseRes.command, isJson, { ...presentation, debug: isDebug });
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

  const isDebug = Boolean(parseRes.value.debug || context?.presentation?.debug);
  return executeCommand(parseRes.value, isDebug ? { ...context, presentation: { ...context?.presentation, debug: true } } : context);
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
