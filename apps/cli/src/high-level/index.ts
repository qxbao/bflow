import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContractError, RuntimeService } from "@bflow/contracts";
import type { SetupContext } from "@bflow/machine-setup";
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
import { TASK_IMPLEMENT_SPEC, taskImplement } from "./commands/task-implement.js";
import { TASK_PLAN_SPEC, taskPlan } from "./commands/task-plan.js";
import { TOOL_STATUS_SPEC, toolStatus } from "./commands/tool-status.js";
import { VERIFY_SPEC, verify } from "./commands/verify.js";

const ENTRIES: readonly { readonly spec: CommandSpec; readonly handler: HighLevelHandler }[] = [
  { spec: REPO_INSPECT_SPEC, handler: repoInspect },
  { spec: TASK_PLAN_SPEC, handler: taskPlan },
  { spec: TASK_IMPLEMENT_SPEC, handler: taskImplement },
  { spec: VERIFY_SPEC, handler: verify },
  { spec: GIT_PREPARE_SPEC, handler: gitPrepare },
  { spec: MCP_STATUS_SPEC, handler: mcpStatus },
  { spec: TOOL_STATUS_SPEC, handler: toolStatus },
  { spec: SKILLS_SYNC_SPEC, handler: skillsSync },
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
  return specs.map(spec => getHighLevelHelp(spec.name)).join("\n\n");
}


function withDefaultSkillsPort(services: HighLevelServices): HighLevelServices {
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
              const skillsMod: any = await import(
                new URL("../../../../packages/skills/dist/index.js", import.meta.url).href
              );
              const catalog = await loadMachineSkillCatalog();
              const store = new skillsMod.SkillFileStore(storeRoot);
              const manager = new skillsMod.SkillManager({
                store,
                supportedCommands: SUPPORTED_CLI_COMMANDS,
                approvedBuiltinDigests: [...catalog.approvedBuiltinSkillDigests]
              });
              return skillsMod.createSkillsSetupSynchronizer(manager, store, [...catalog.entries]);
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
    const baseServices = options.services ?? withDefaultSkillsPort(await createDefaultHighLevelServices());
    const services = withDefaultRuntime(baseServices);
    const progress = emitProgress ? (step: string) => {
      renderer.event(step);
    } : undefined;
    if (progress) progress(`bflow ${entry.spec.words.join(" ")}: starting`);
    const context: HighLevelContext = {
      cwd: options.cwd ?? process.cwd(), io: options.io, clock, services, runtime: options.runtime, signal: options.signal,
      ...(progress !== undefined ? { onProgress: progress } : {})
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
