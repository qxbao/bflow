import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContractError, RuntimeService } from "@bflow/contracts";
import { McpConfigFileSchema, type SetupContext } from "@bflow/machine-setup";
import { SUPPORTED_CLI_COMMANDS } from "../command-reference.js";
import { composeCliRuntime } from "../runtime.js";
import type { CliIo } from "../types.js";
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

function formatHuman(envelope: HighLevelEnvelope): string {
  const output = envelope.result.output as { outcome: string; ids: Record<string, string>; replayed: boolean;
    steps: { id: string; status: string; message?: string }[]; data: unknown };
  const lines = [`bflow ${envelope.command.replace(".", " ")}: ${output.outcome} (status ${envelope.result.status}, exit ${envelope.exitCode})`];
  const ids = Object.entries(output.ids).map(([k, v]) => `${k}=${v}`);
  lines.push(`  commandId=${envelope.result.commandId} correlationId=${envelope.result.correlationId}${ids.length ? ` ${ids.join(" ")}` : ""}${output.replayed ? " (replayed)" : ""}`);
  if (output.steps.length > 0) {
    lines.push("  Steps:");
    for (const step of output.steps) lines.push(`    [${step.status}] ${step.id}${step.message ? ` — ${step.message}` : ""}`);
  }
  if (envelope.result.error) lines.push(`  Error (${envelope.result.error.code}): ${envelope.result.error.message}`);
  if (output.data !== null) lines.push("  Data:", ...JSON.stringify(output.data, null, 2).split("\n").map(line => `    ${line}`));
  return lines.join("\n");
}

function withDefaultPlatformPorts(services: HighLevelServices): HighLevelServices {
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
              const catalog = await skillsMod.loadDefaultSkillCatalog({
                supportedCommands: SUPPORTED_CLI_COMMANDS
              });
              const store = new skillsMod.SkillFileStore(storeRoot);
              const manager = new skillsMod.SkillManager({
                store,
                supportedCommands: SUPPORTED_CLI_COMMANDS,
                approvedBuiltinDigests: catalog.map((item: any) => item.definition.digest)
              });
              return skillsMod.createSkillsSetupSynchronizer(
                manager,
                store,
                catalog.map((item: any) => ({
                  root: item.directory,
                  source: "builtin" as const,
                  expectedDigest: item.definition.digest
                }))
              );
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
    mcpGateway:
      services.mcpGateway ?? {
        async status() {
          const platform = await services.machine.platform();
          const file = join(platform.paths.config, "mcp.json");
          let configuredServices: { serviceId: string }[] = [];
          try {
            const raw = JSON.parse(await readFile(file, "utf8"));
            const parsed = McpConfigFileSchema.safeParse(raw);
            if (parsed.success) {
              configuredServices = Object.values(parsed.data.services);
            }
          } catch {
            // absent or invalid config file is reported separately by mcp.status
          }
          return {
            reachable: true,
            version: "3.0.0",
            backends: configuredServices.map(s => ({
              serviceId: s.serviceId,
              state: "healthy" as const
            }))
          };
        }
      }
  };
}

function withDefaultRuntime(services: HighLevelServices): HighLevelServices {
  if (services.openRuntime !== undefined) return services;
  return {
    ...services,
    async openRuntime(root) {
      if (!existsSync(join(root, ".bflow/config.yaml"))) return undefined;
      const composed = await composeCliRuntime({ cwd: root });
      if (!composed.ok) throw composed.error;
      return { runtime: composed.value.runtime, close: () => composed.value.close() };
    }
  };
}

export async function runHighLevelCli(argv: readonly string[], options: HighLevelRunOptions = {}): Promise<HighLevelRunResult> {
  const { json: leadingJson, rest } = stripLeadingJson(argv);
  const json = leadingJson || rest.includes("--json") || rest.includes("-j");
  const write = (stream: "stdout" | "stderr", text: string) => { options.io?.[stream](text); };

  const usage = (message: string): HighLevelRunResult => {
    const error = usageError(message);
    const stderr = json ? JSON.stringify({ ok: false, error }) : `Error: ${message}`;
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
  let identity = newCommandIdentity();
  let report;
  try {
    const parsed = parseCommandArgs(entry.spec, rest.slice(entry.spec.words.length));
    if (parsed.help) return help(getHighLevelHelp(name), entry.spec.words.join(" "));
    identity = newCommandIdentity(parsed.correlationId ?? process.env.BFLOW_CORRELATION_ID);
    const baseServices = options.services ?? withDefaultPlatformPorts(await createDefaultHighLevelServices());
    const services = withDefaultRuntime(baseServices);
    const context: HighLevelContext = {
      cwd: options.cwd ?? process.cwd(), io: options.io, clock, services, runtime: options.runtime, signal: options.signal
    };
    report = await entry.handler(parsed, context, identity);
  } catch (error) {
    report = errorReport(name, error);
  }

  const envelope = buildEnvelope(identity, report, clock().toISOString());
  let stdout = "";
  let stderr = "";
  if (json) { stdout = JSON.stringify(envelope); write("stdout", stdout); }
  else if (envelope.ok || envelope.result.status === "waiting_user" || report.error === undefined) { stdout = formatHuman(envelope); write("stdout", stdout); }
  else { stderr = formatHuman(envelope); write("stderr", stderr); }
  return { exitCode: envelope.exitCode as HighLevelExitCode, ok: envelope.ok, command: name, stdout, stderr, envelope,
    ...(report.error !== undefined ? { error: report.error } : {}) };
}

export { HIGH_LEVEL_SUMMARY, getHighLevelHelp };
