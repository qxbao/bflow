import { identifyRepository } from "../repository.js";
import { readEnvironmentConfig } from "../environment-config.js";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MCPServiceObservationSchema, type ContractError, type MCPServiceObservation, type RuntimeService } from "@bflow/contracts";
import { digest, type PlatformProfile, type SetupContext } from "@bflow/machine-setup";
import { SUPPORTED_CLI_COMMANDS } from "../command-reference.js";
import { loadMachineSkillCatalog } from "../skill-catalog.js";
import { composeCliRuntime } from "../runtime.js";
import { resolveReadableConfigPath } from "../config.js";
import type { CliIo, PresentationOptions } from "../types.js";
import { bold, humanText, red } from "../presentation.js";
import { formatHighLevelHuman } from "./presentation.js";
import { isStderrInteractive, resolveStreamColor } from "../presentation.js";
import { CliProgress } from "../progress.js";
import { parseCommandArgs, type CommandSpec } from "./args.js";
import {
  buildEnvelope,
  errorReport,
  HIGH_LEVEL_EXIT_CODES,
  newCommandIdentity,
  usageError,
  type HighLevelCommandName,
  type HighLevelEnvelope,
  type HighLevelExitCode
} from "./envelope.js";
import type { HighLevelContext, HighLevelHandler } from "./context.js";
import { getHighLevelHelp, HIGH_LEVEL_SUMMARY } from "./help.js";
import { createDefaultHighLevelServices, type HighLevelServices } from "./services.js";
import { AGENT_CHECK_SPEC, agentCheck } from "./commands/agent-check.js";
import { GIT_PREPARE_SPEC, gitPrepare } from "./commands/git-prepare.js";
import { MCP_STATUS_SPEC, mcpStatus } from "./commands/mcp-status.js";
import { REPO_INSPECT_SPEC, repoInspect } from "./commands/repo-inspect.js";
import { SKILLS_SYNC_SPEC, skillsSync } from "./commands/skills-sync.js";
import {
  SKILLS_APPROVE_SPEC, SKILLS_DISABLE_SPEC, SKILLS_IMPORT_SPEC, SKILLS_REVOKE_SPEC, SKILLS_SCAN_SPEC, SKILLS_STATUS_SPEC,
  skillsApprove, skillsDisable, skillsImport, skillsRevoke, skillsScan, skillsStatus
} from "./commands/skills-custom.js";
import { TASK_IMPLEMENT_SPEC, taskImplement } from "./commands/task-implement.js";
import { TASK_PREVIEW_SPEC, taskPreview } from "./commands/task-preview.js";
import { HANDOVER_EXPORT_SPEC, HANDOVER_INSPECT_SPEC, HANDOVER_VERIFY_SPEC, handoverExport, handoverInspect, handoverVerify } from "./commands/handover.js";
import { TASK_PLAN_SPEC, taskPlan } from "./commands/task-plan.js";
import { TOOL_STATUS_SPEC, toolStatus } from "./commands/tool-status.js";
import { VERIFY_SPEC, verify } from "./commands/verify.js";

const ENTRIES: readonly { readonly spec: CommandSpec; readonly handler: HighLevelHandler }[] = [
  { spec: REPO_INSPECT_SPEC, handler: repoInspect },
  { spec: TASK_PREVIEW_SPEC, handler: taskPreview },
  { spec: HANDOVER_INSPECT_SPEC, handler: handoverInspect },
  { spec: HANDOVER_EXPORT_SPEC, handler: handoverExport },
  { spec: HANDOVER_VERIFY_SPEC, handler: handoverVerify },
  { spec: TASK_PLAN_SPEC, handler: taskPlan },
  { spec: TASK_IMPLEMENT_SPEC, handler: taskImplement },
  { spec: VERIFY_SPEC, handler: verify },
  { spec: GIT_PREPARE_SPEC, handler: gitPrepare },
  { spec: MCP_STATUS_SPEC, handler: mcpStatus },
  { spec: TOOL_STATUS_SPEC, handler: toolStatus },
  { spec: SKILLS_SYNC_SPEC, handler: skillsSync },
  { spec: SKILLS_SCAN_SPEC, handler: skillsScan },
  { spec: SKILLS_IMPORT_SPEC, handler: skillsImport },
  { spec: SKILLS_APPROVE_SPEC, handler: skillsApprove },
  { spec: SKILLS_DISABLE_SPEC, handler: skillsDisable },
  { spec: SKILLS_REVOKE_SPEC, handler: skillsRevoke },
  { spec: SKILLS_STATUS_SPEC, handler: skillsStatus },
  { spec: AGENT_CHECK_SPEC, handler: agentCheck }
];

export const HIGH_LEVEL_COMMAND_SPECS: readonly CommandSpec[] = ENTRIES.map(entry => entry.spec);
const GROUPS = new Set(ENTRIES.map(entry => entry.spec.words[0]!));

function stripLeadingJson(argv: readonly string[]): { json: boolean; rest: readonly string[] } {
  let index = 0;
  while (argv[index] === "--json" || argv[index] === "-j") index++;
  return { json: index > 0, rest: argv.slice(index) };
}

/** True when argv addresses a high-level command or its help; legacy commands are left untouched. */
export function isHighLevelInvocation(argv: readonly string[]): boolean {
  const { rest } = stripLeadingJson(argv);
  const first = rest[0];
  if (first === "help") return rest[1] !== undefined && GROUPS.has(rest[1]);
  return first !== undefined && GROUPS.has(first);
}

export interface HighLevelRunOptions {
  readonly cwd?: string | undefined;
  readonly io?: CliIo | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly services?: HighLevelServices | undefined;
  readonly runtime?: RuntimeService | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly presentation?: PresentationOptions | undefined;
}

export interface HighLevelRunResult {
  readonly exitCode: HighLevelExitCode;
  readonly ok: boolean;
  readonly command?: HighLevelCommandName | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope?: HighLevelEnvelope | undefined;
  readonly error?: ContractError | undefined;
}

function groupHelp(group: string): string {
  const specs = ENTRIES.filter(entry => entry.spec.words[0] === group).map(entry => entry.spec);
  return [`Usage: bflow ${group} <command> [options]`, "", "Commands:",
    ...specs.map(spec => `  bflow ${spec.words.join(" ")}  ${spec.behavior.summary}`),
    "", `Run 'bflow ${group} <command> --help' for command options.`,
    "Exit codes: 0 success, 1 failed, 2 usage, 3 not ready, 4 not found, 5 approval required, 6 conflict, 7 unknown (reconcile the receipt before retrying)."].join("\n");
}


function withDefaultSkillsPort(services: HighLevelServices, cwd: string): HighLevelServices {
  return {
    ...services,
    skills:
      services.skills ??
      (() => {
        let cachedSynchronizer: Promise<any> | undefined;
        const getSynchronizer = (ctx: SetupContext) => {
          if (!cachedSynchronizer) {
            cachedSynchronizer = (async () => {
              const storeRoot = join(ctx.platform.paths.data, "skills-store");
              await mkdir(storeRoot, { recursive: true, mode: 0o700 });
              await chmod(storeRoot, 0o700);
              // Untyped as before the package-specifier import: local port types do not match the package declarations yet.
              const skillsMod: any = await import("@bflow/skills");
              let repository;
              try { repository = await identifyRepository(cwd); } catch { /* Machine-only sync outside a repo retains builtin catalog. */ }
              const input = repository && existsSync(resolveReadableConfigPath(repository.root))
                ? { repository, config: await readEnvironmentConfig(repository), env: process.env } : undefined;
              const catalog = await loadMachineSkillCatalog(input);
              const store = new skillsMod.SkillFileStore(storeRoot);
              const manager = new skillsMod.SkillManager({
                store,
                supportedCommands: SUPPORTED_CLI_COMMANDS,
                approvedBuiltinDigests: [...catalog.approvedBuiltinSkillDigests]
              });
              return new skillsMod.SkillsSetupSynchronizer(manager, store, [...catalog.entries]);
            })();
          }
          return cachedSynchronizer;
        };
        return {
          observe: async (ctx: SetupContext) => (await getSynchronizer(ctx)).observe(ctx),
          desired: async (ctx: SetupContext) => (await getSynchronizer(ctx)).desired(ctx),
          sync: async (ctx: SetupContext) => (await getSynchronizer(ctx)).sync(ctx)
        };
      }),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

async function readBoundedRegularJson(filePath: string): Promise<unknown> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) {
    throw new Error(`Not a bounded regular setup file: ${filePath}`);
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

function createMachineSetupMcpGatewayPort(
  platform: PlatformProfile,
  clock: () => Date
): NonNullable<HighLevelServices["mcpGateway"]> {
  return {
    async status(opts) {
      const configFile = join(platform.paths.config, "setup-gateway.json");
      const rawCfg = (await readBoundedRegularJson(configFile)) as Record<string, unknown> | null;
      if (
        !rawCfg ||
        typeof rawCfg !== "object" ||
        rawCfg.schemaVersion !== 3 ||
        typeof rawCfg.definitionDigest !== "string" ||
        !Array.isArray(rawCfg.services) ||
        typeof rawCfg.receiptPath !== "string"
      ) {
        throw new Error(`Invalid machine-setup Gateway configuration at ${configFile}`);
      }
      if (rawCfg.definitionDigest !== digest(rawCfg.services)) {
        throw new Error(`Gateway configuration digest mismatch at ${configFile}`);
      }
      const expectedReceiptPath = join(platform.paths.state, "setup-gateway-ready.json");
      if (resolve(rawCfg.receiptPath) !== resolve(expectedReceiptPath)) {
        throw new Error(`Gateway readiness receipt path '${rawCfg.receiptPath}' does not match owned state directory`);
      }

      let rawReady: Record<string, unknown> | null;
      try {
        rawReady = (await readBoundedRegularJson(expectedReceiptPath)) as Record<string, unknown> | null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Shared MCP Gateway readiness receipt not found at ${expectedReceiptPath}`);
        }
        throw error;
      }
      if (
        !rawReady ||
        typeof rawReady !== "object" ||
        rawReady.schemaVersion !== 3 ||
        rawReady.definitionDigest !== rawCfg.definitionDigest ||
        typeof rawReady.pid !== "number" ||
        !Number.isSafeInteger(rawReady.pid) ||
        rawReady.pid <= 1 ||
        typeof rawReady.endpoint !== "string" ||
        typeof rawReady.observedAt !== "string" ||
        !Array.isArray(rawReady.observations)
      ) {
        throw new Error(`Invalid or stale Shared MCP Gateway readiness receipt at ${expectedReceiptPath}`);
      }
      const observedAtMs = Date.parse(rawReady.observedAt);
      const ageMs = clock().getTime() - observedAtMs;
      if (!Number.isFinite(observedAtMs) || ageMs > 60_000 || ageMs < -5_000) {
        throw new Error(`Shared MCP Gateway readiness receipt at ${expectedReceiptPath} is stale`);
      }
      if (!processIsAlive(rawReady.pid)) {
        throw new Error(`Shared MCP Gateway daemon (pid ${rawReady.pid}) is not running`);
      }

      const endpointUrl = new URL(rawReady.endpoint);
      if (endpointUrl.protocol !== "http:" || endpointUrl.hostname !== "127.0.0.1") {
        throw new Error(`Refusing non-loopback Shared MCP Gateway endpoint '${rawReady.endpoint}'`);
      }
      const healthUrl = new URL("/health", endpointUrl);
      const signal = AbortSignal.any([
        AbortSignal.timeout(3_000),
        ...(opts?.signal !== undefined ? [opts.signal] : [])
      ]);
      const response = await fetch(healthUrl, { method: "GET", redirect: "error", signal });
      await response.body?.cancel().catch(() => undefined);

      const observations: MCPServiceObservation[] = rawReady.observations.map((item) =>
        MCPServiceObservationSchema.parse(item)
      );
      const backends = observations.map((obs) => {
        const state: "healthy" | "degraded" | "unavailable" | "unknown" =
          obs.status === "ready"
            ? "healthy"
            : obs.status === "starting"
              ? "degraded"
              : obs.status === "blocked" || obs.status === "stopped"
                ? "unavailable"
                : "unknown";
        const detail =
          obs.status === "ready"
            ? `Gateway verified (${obs.discoveredTools.length} tool(s))`
            : `Gateway observed status '${obs.status}' (${obs.diagnosticCode})`;
        return { serviceId: obs.serviceId, state, detail };
      });
      return { reachable: true, backends };
    }
  };
}

async function withDefaultMcpGateway(
  services: HighLevelServices,
  clock: () => Date
): Promise<HighLevelServices> {
  if (services.mcpGateway !== undefined) return services;
  const platform = await services.machine.platform();
  const configFile = join(platform.paths.config, "setup-gateway.json");
  if (!existsSync(configFile)) return services;
  return {
    ...services,
    mcpGateway: createMachineSetupMcpGatewayPort(platform, clock)
  };
}

function withDefaultRuntime(services: HighLevelServices): HighLevelServices {
  if (services.openRuntime !== undefined) return services;
  return {
    ...services,
    async openRuntime(root) {
      if (!existsSync(resolveReadableConfigPath(root))) return undefined;
      const composed = await composeCliRuntime({ cwd: root });
      if (!composed.ok) throw composed.error;
      return { runtime: composed.value.runtime, close: () => composed.value.close() };
    }
  };
}

export async function runHighLevelCli(argv: readonly string[], options: HighLevelRunOptions = {}): Promise<HighLevelRunResult> {
  const { json: leadingJson, rest } = stripLeadingJson(argv);
  const json = leadingJson || rest.includes("--json") || rest.includes("-j") || Boolean(options.presentation?.json);
  const write = (stream: "stdout" | "stderr", text: string) => { options.io?.[stream](text); };
  const presentation = options.presentation ?? {
    stdoutColor: options.io === undefined && resolveStreamColor({ isTTY: Boolean(process.stdout.isTTY) }),
    stderrColor: options.io === undefined && resolveStreamColor({ isTTY: Boolean(process.stderr.isTTY) }),
    interactive: options.io === undefined && isStderrInteractive({ isTTY: Boolean(process.stderr.isTTY) }),
    json: false
  };
  const stdoutColor = json ? false : Boolean(presentation.stdoutColor);
  const stderrColor = json ? false : Boolean(presentation.stderrColor);
  const emitProgress = !json && Boolean(presentation.interactive) && options.io !== undefined;

  const usage = (message: string): HighLevelRunResult => {
    const error = usageError(message);
    const stderr = json ? JSON.stringify({ ok: false, error }) : `${stderrColor ? red(bold("Error:"), true) : "Error:"} ${humanText(message, 300)}\n  Next: ${humanText(`Run 'bflow ${rest[0] ?? "--help"} --help' for usage information.`, 200)}`;
    write("stderr", stderr);
    return { exitCode: HIGH_LEVEL_EXIT_CODES.USAGE, ok: false, stdout: "", stderr, error };
  };
  const help = (text: string, topic: string): HighLevelRunResult => {
    const stdout = json ? JSON.stringify({ ok: true, command: "help", data: { helpText: text, topic } }) : text;
    write("stdout", stdout);
    return { exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS, ok: true, stdout, stderr: "" };
  };

  if (rest[0] === "help") {
    const words = rest.slice(1).filter(word => !word.startsWith("-"));
    const entry = ENTRIES.find(e => e.spec.words.every((w, i) => words[i] === w) && words.length === e.spec.words.length);
    if (entry) return help(getHighLevelHelp(entry.spec.name), entry.spec.words.join(" "));
    if (words.length === 1 && GROUPS.has(words[0]!)) return help(groupHelp(words[0]!), words[0]!);
    return usage(`Unknown help topic '${words.join(" ")}'. Run 'bflow --help'.`);
  }

  const entry = ENTRIES.find(e => e.spec.words.every((w, i) => rest[i] === w));
  if (entry === undefined) {
    const group = rest[0]!;
    if (rest.slice(1).some(a => a === "--help" || a === "-h")) return help(groupHelp(group), group);
    const known = ENTRIES.filter(e => e.spec.words[0] === group).map(e => e.spec.words.join(" "));
    return usage(`${rest[1] === undefined ? "Missing" : `Unknown`} subcommand for 'bflow ${group}'${rest[1] !== undefined ? ` '${rest[1]}'` : ""}. Available: ${known.join(", ")}.`);
  }

  const name = entry.spec.name;
  const clock = options.clock ?? (() => new Date());
  const renderer = new CliProgress({ enabled: emitProgress, color: stderrColor, io: options.io });
  let identity = newCommandIdentity();
  let report;
  try {
    const parsed = parseCommandArgs(entry.spec, rest.slice(entry.spec.words.length));
    if (parsed.help) return help(getHighLevelHelp(name), entry.spec.words.join(" "));
    identity = newCommandIdentity(parsed.correlationId ?? process.env.BFLOW_CORRELATION_ID);
    const defaultServices = options.services === undefined
      ? withDefaultSkillsPort(await createDefaultHighLevelServices(), options.cwd ?? process.cwd())
      : undefined;
    const baseServices = options.services ?? (
      name === "mcp.status"
        ? await withDefaultMcpGateway(defaultServices!, clock)
        : defaultServices!
    );
    const services = withDefaultRuntime(baseServices);
    const progress = emitProgress ? (step: string) => {
      renderer.event(step);
    } : undefined;
    if (progress) progress(`bflow ${entry.spec.words.join(" ")}: starting`);
    const context: HighLevelContext = {
      cwd: options.cwd ?? process.cwd(), io: options.io, clock, services, runtime: options.runtime, signal: options.signal,
      ...(progress !== undefined ? { onProgress: progress,
        onUnits: (completed: number, total: number, label: string) => renderer.units(completed, total, label) } : {})
    };
    report = await entry.handler(parsed, context, identity);
  } catch (error) {
    report = errorReport(name, error);
  } finally {
    renderer.stop();
  }

  const envelope = buildEnvelope(identity, report, clock().toISOString());
  let stdout = "";
  let stderr = "";
  if (json) { stdout = JSON.stringify(envelope); write("stdout", stdout); }
  else if (envelope.ok || envelope.result.status === "waiting_user" || report.error === undefined) { stdout = formatHighLevelHuman(envelope, stdoutColor); write("stdout", stdout); }
  else { stderr = formatHighLevelHuman(envelope, stderrColor); write("stderr", stderr); }
  return { exitCode: envelope.exitCode as HighLevelExitCode, ok: envelope.ok, command: name, stdout, stderr, envelope,
    ...(report.error !== undefined ? { error: report.error } : {}) };
}

export { HIGH_LEVEL_SUMMARY, getHighLevelHelp };
