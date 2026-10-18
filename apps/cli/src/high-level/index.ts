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
import { bold, cyan, dim, extractSafeDetails, formatProgressStep, green, humanText, readableLabel, red, resolveActionableRemediation, yellow } from "../presentation.js";
import type { CliCommandName } from "../types.js";
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

function summaryLines(command: HighLevelCommandName, value: unknown): string[] {
  const data = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const lines: string[] = [];
  const add = (label: string, value: unknown, max = 180) => {
    if (value === undefined || value === null || typeof value === "object") return;
    lines.push(`  ${label}: ${humanText(value, max) || "(empty)"}`);
  };
  const list = (label: string, items: unknown, render: (item: unknown) => string) => {
    if (!Array.isArray(items) || items.length === 0) return;
    lines.push(`  ${label}:`);
    for (const item of items.slice(0, 10)) lines.push(`    - ${humanText(render(item), 450)}`);
    if (items.length > 10) lines.push(`    … ${items.length - 10} more`);
  };
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const text = (v: unknown, n = 180) => humanText(v, n);
  switch (command) {
    case "repo.inspect": {
      const repo = object(data.repository), git = object(data.git), project = object(data.project);
      add("Root", repo.root); add("Branch", git.branch); add("HEAD", typeof git.head === "string" ? git.head.slice(0, 12) : undefined);
      add("Working tree", typeof git.dirty === "boolean" ? (git.dirty ? "has changes" : "clean") : undefined);
      add("Project markers", Array.isArray(project.markers) ? project.markers.join(", ") : undefined);
      add("Package manager", project.packageManager);
      add("Workspace packages", Array.isArray(project.workspacePackages) ? project.workspacePackages.length : undefined);
      break;
    }
    case "task.plan": {
      const graph = object(data.graph), trace = object(data.traceability);
      add("Specification", data.specId); add("Traceability", typeof trace.valid === "boolean" ? (trace.valid ? "valid" : "incomplete") : undefined);
      add("Tasks", Array.isArray(graph.tasks) ? graph.tasks.length : graph.taskCount);
      add("Plan file", data.path); add("Written", data.written); add("Preview", data.written === false ? "no files changed" : undefined);
      list("Task graph", graph.tasks, item => {
        const task = object(item);
        const id = text(task.id ?? task.taskId ?? "task", 100);
        const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
        return `${id} (depends on: ${deps})`;
      });
      list("Unmapped criteria", trace.orphanCriterionIds, x => text(x, 100));
      list("Unmapped workflow tasks", trace.unmappedWorkflowTaskIds, x => text(x, 100));
      list("Unknown task mappings", trace.unknownMappedTaskIds, x => text(x, 100));
      list("Unknown criteria", trace.unknownCriterionIds, x => text(x, 100));
      const mappings = object(trace.criterionToTasks);
      list("Criterion mappings", Object.entries(mappings), entry => {
        const [criterion, tasks] = entry as [string, unknown];
        return `${text(criterion, 100)} → ${Array.isArray(tasks) ? tasks.map(x => text(x, 80)).join(", ") || "unmapped" : "unmapped"}`;
      });
      break;
    }
    case "task.implement": {
      const assignment = object(data.assignment), strategy = object(data.testStrategy), decision = object(strategy.tddDecision ?? data.tddDecision);
      add("Task", data.taskKey ?? data.taskId); add("Worktree", data.worktreePath); add("Branch", data.branchName);
      if (Object.keys(assignment).length) {
        add("TDD", object(assignment.tdd).mode ?? object(assignment.tdd).classification ?? decision.mode ?? decision.classification);
        add("Assignment", assignment.status ?? "awaiting_runtime_dispatch");
        lines.push("  Next: Runtime/Coordinator must issue the leased assignment; this command does not dispatch an agent");
      } else add("TDD", decision.mode ?? decision.classification);
      break;
    }
    case "verify": {
      const verification = object(data.verification);
      const findings = Array.isArray(verification.findings) ? verification.findings : [];
      add("Verification", verification.status);
      const counts: Record<string, number> = {};
      for (const finding of findings) { const severity = String(object(finding).severity ?? "unspecified"); counts[severity] = (counts[severity] ?? 0) + 1; }
      if (findings.length) add("Findings", Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", "));
      list("Findings", findings, item => {
        const f = object(item);
        return `${text(f.severity ?? "finding", 40)}: ${text(f.message ?? f.title ?? f.check ?? "No message", 220)}`;
      });
      const cycle = object(data.cycle);
      if (Object.keys(cycle).length) add("Verification cycle", `${cycle.status ?? "unknown"}, iteration ${cycle.iteration ?? "?"}/${cycle.maxIterations ?? "?"}`);
      break;
    }
    case "git.prepare": {
      const integration = object(data.integration), verification = object(data.workflowVerification);
      add("Integration", integration.status ?? integration.outcome); add("Branch", integration.branchName);
      add("Head", integration.headCommitHash); add("Workflow verification", verification.required === true ? "requested through Runtime" : verification.required === false ? "not requested" : undefined);
      const conflict = object(integration.conflict);
      if (Object.keys(conflict).length) add("Conflict", `${conflict.taskKey ?? "task"}: ${Array.isArray(conflict.paths) ? conflict.paths.map(x => text(x, 100)).join(", ") : "review integration record"}`);
      const preview = object(data.preview);
      if (Object.keys(preview).length) {
        add("Integration ID", preview.integrationId); add("Base revision", preview.baseRevision);
        add("Target", preview.mergesInto);
        list("Integration tasks", preview.tasks, item => {
          const task = object(item);
          const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(x => text(x, 80)).join(", ") || "none" : "none";
          return `${text(task.taskKey ?? task.taskId ?? "task", 100)} (depends on: ${deps})`;
        });
        list("Task readiness", data.tasks, item => {
          const task = object(item);
          return `${text(task.taskId ?? task.taskKey ?? "task", 100)}: ${text(task.status ?? "unknown", 60)}; branch ${text(task.branchName ?? "unknown", 100)}; head ${text(task.headCommitHash ?? "unknown", 16)}; ${task.clean === true ? "clean" : task.clean === false ? "has changes" : "cleanliness unknown"}; ${task.ready === true ? "ready" : "not ready"}`;
        });
        lines.push("  Next: Review the preview, then rerun with --yes to collect submissions and prepare integration");
      } else add("Publication", "No push or protected-branch merge was performed");
      break;
    }
    case "agent.check": {
      add("Provider", data.provider); add("Role", data.role); add("Stage", data.stage); add("Readiness", data.status);
      list("Checks", data.checks, item => {
        const check = object(item);
        return `${text(check.status ?? "unknown", 32)} ${text(check.check ?? check.name ?? "check", 80)}${check.message ? ` — ${text(check.message, 180)}` : ""}${check.remediation ? `; next: ${text(check.remediation, 160)}` : ""}`;
      });
      add("Note", data.note); break;
    }
    case "mcp.status": {
      const gateway = object(data.gateway), config = object(data.config);
      add("Gateway", gateway.reachable === true ? "reachable" : gateway.reachable === false ? `unavailable${gateway.reason ? `: ${text(gateway.reason)}` : ""}` : "unknown");
      add("Config", `${config.state ?? "unknown"}${config.path ? ` (${text(config.path)})` : ""}`);
      list("Backends", data.backends, item => { const b = object(item); return `${text(b.serviceId ?? b.id ?? "backend", 70)}: ${text(b.state ?? (b.healthy === true ? "healthy" : b.healthy === false ? "unhealthy" : "unknown"), 60)}${b.reason ? ` — ${text(b.reason, 160)}` : ""}`; });
      break;
    }
    case "tool.status": {
      add("Platform", object(data.platform).os); add("Blocking tools", Array.isArray(data.blocking) ? data.blocking.join(", ") || "none" : undefined);
      list("Tools", data.tools, item => { const t = object(item); return `${text(t.toolId, 70)}: ${text(t.status ?? "unknown", 50)}${t.version ? ` (${text(t.version, 50)})` : ""}${t.required === true ? " [required]" : ""}${t.remediation ? `; next: ${text(t.remediation, 160)}` : ""}`; });
      break;
    }
    case "skills.sync": {
      add("Providers", Array.isArray(data.providers) ? data.providers.join(", ") : data.provider);
      add("Targets", Array.isArray(data.targets) ? data.targets.length : undefined);
      add("Machine-wide targets", data.machineWide);
      add("Manifest digest", data.digest);
      add("Changed paths", Array.isArray(data.ownedPaths) ? data.ownedPaths.length : undefined);
      list("Providers", data.providers, x => text(x, 100));
      list("Targets", data.targets, x => text(x, 200));
      list("Diagnostics", data.diagnostics, x => text(x, 180));
      break;
    }
  }
  return lines;
}

function commandForRemediation(command: HighLevelCommandName): CliCommandName {
  switch (command) {
    case "repo.inspect": return "repo inspect";
    case "task.plan": return "task plan";
    case "task.implement": return "task implement";
    case "verify": return "verify";
    case "git.prepare": return "git prepare";
    case "mcp.status": return "mcp status";
    case "tool.status": return "tool status";
    case "skills.sync": return "skills sync";
    case "agent.check": return "agent check";
  }
}

function formatHuman(envelope: HighLevelEnvelope, useColor = false): string {
  const output = envelope.result.output as { outcome: string; ids: Record<string, string>; replayed: boolean;
    steps: { id: string; status: string; message?: string }[]; data: unknown };
  const dataRecord = output.data !== null && typeof output.data === "object" && !Array.isArray(output.data)
    ? output.data as Record<string, unknown> : {};
  const heading = `bflow ${envelope.command.replace(".", " ")}`;
  const waiting = output.outcome === "approval_required" || output.outcome === "reconciliation_required" || envelope.result.status === "waiting_user" || envelope.result.status === "unknown";
  const failed = !waiting && (!envelope.ok || ["failed", "not_passed", "not_ready", "conflict_detected"].includes(output.outcome));
  const marker = waiting ? "[WAIT]" : failed ? "[FAIL]" : "[OK]";
  const markerColor = waiting ? yellow : failed ? red : green;
  const title = `${heading}: ${output.outcome} ${marker}`;
  const lines = [useColor ? markerColor(bold(title), true) : title,
    `  status=${envelope.result.status} exit=${envelope.exitCode}`];
  const ids = Object.entries(output.ids).map(([k, v]) => `${k}=${humanText(v, 100)}`);
  if (envelope.result.commandId) ids.unshift(`commandId=${humanText(envelope.result.commandId, 100)}`);
  if (envelope.result.correlationId) ids.unshift(`correlationId=${humanText(envelope.result.correlationId, 100)}`);
  lines.push(`  ${useColor ? dim(ids.join(" "), true) : ids.join(" ")}${output.replayed ? " (replayed; no work repeated)" : ""}`);
  if (output.steps.length > 0) {
    lines.push("  Steps:");
    for (const [index, step] of output.steps.slice(0, 20).entries()) {
      const status = step.status.toUpperCase();
      const paint = step.status === "succeeded" || step.status === "reused" ? green : step.status === "failed" ? red : yellow;
      lines.push(`    ${formatProgressStep(readableLabel(step.id), useColor, index + 1)} ${useColor ? paint(`[${status}]`, true) : `[${status}]`}`);
      if (step.message) lines.push(dim(`        ${humanText(step.message, 220)}`, useColor));
    }
    if (output.steps.length > 20) lines.push(`    … ${output.steps.length - 20} more steps`);
  }
  lines.push(...summaryLines(envelope.command, output.data));
  if (envelope.result.error) {
    const error = envelope.result.error;
    lines.push(`${useColor ? red(bold(`Error [${error.code}]:`), true) : `Error [${error.code}]:`} ${humanText(error.message, 350)}`);
    if (error.details !== undefined) {
      const details = extractSafeDetails(error.details);
      if (details) lines.push(`  Details: ${humanText(Object.entries(details).map(([key, value]) => `${key}=${value}`).join(" "), 240)}`);
    }
    const reason = extractSafeDetails(error.details)?.reason;
    const next = reason === "file_not_found" ? "Check the input path and pass an existing file; use --help to review the required arguments."
      : reason === "invalid_json" || reason === "invalid_workflow" || reason === "invalid_plan" ? "Fix the input JSON to match the documented schema, then rerun the command."
      : reason === "permission_required" ? "Review the requested scope and provide the explicit approval flag only when authorized."
      : reason === "interrupted" || error.code === "unknown_delivery" ? "Inspect the existing receipt, then rerun the same invocation with --resume where supported; preserve the original arguments and idempotency key."
      : reason === "busy" ? "Wait for the active invocation to finish, then retry with the same request."
      : resolveActionableRemediation(error, commandForRemediation(envelope.command));
    lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${humanText(next, 240)}`);
  } else {
    const next = output.outcome === "approval_required"
      ? envelope.command === "skills.sync" ? (dataRecord.machineWide === true
        ? "Review the listed targets, then rerun with --allow-machine-scope to authorize machine-wide writes."
        : "Review the listed targets and request the explicit approval required for this synchronization.")
        : "Review the preview and provide the command's explicit approval flag when authorized."
      : output.outcome === "not_passed" ? "Review each finding and its evidence, address blockers, then rerun verification."
      : output.outcome === "not_ready" ? "Resolve the reported readiness findings and rerun the check."
      : output.outcome === "conflict_detected" ? "Inspect the integration conflict and resolve it before requesting workflow verification."
      : undefined;
    if (next) lines.push(`  ${useColor ? cyan("Next:", true) : "Next:"} ${humanText(next, 240)}`);
  }
  return lines.join("\n");
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
  else if (envelope.ok || envelope.result.status === "waiting_user" || report.error === undefined) { stdout = formatHuman(envelope, stdoutColor); write("stdout", stdout); }
  else { stderr = formatHuman(envelope, stderrColor); write("stderr", stderr); }
  return { exitCode: envelope.exitCode as HighLevelExitCode, ok: envelope.ok, command: name, stdout, stderr, envelope,
    ...(report.error !== undefined ? { error: report.error } : {}) };
}

export { HIGH_LEVEL_SUMMARY, getHighLevelHelp };
