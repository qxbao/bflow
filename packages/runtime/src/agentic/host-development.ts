import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentExecutionHandleSchema, PaneBindingSchema, RoleMessageSchema, type PaneBinding } from "@bflow/contracts";
import { measureBehavior, parseBehavioralCommands, type BehavioralCommand } from "./behavioral-runner.js";
import { TestRunnerSource, resolveTaskCommands } from "./task-commands.js";
import type { AgenticWorkflowRuntime } from "./runtime.js";
import { json, record, strings, textField } from "./journal.js";
import type { Specification, TestStrategy } from "@bflow/contracts";

const execute = promisify(execFile);
const covers = (prefix: string, path: string) => prefix === path || path.startsWith(prefix + "/");
const safe = (path: string) => !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");

/** Developer mutations remain inside the current leased task, accepted scope,
 * and TDD phase. Git commits are structured host operations, never shell input. */
export class HostDevelopment {
  private readonly runners: TestRunnerSource;
  constructor(private readonly runtime: () => AgenticWorkflowRuntime, runners: TestRunnerSource | readonly BehavioralCommand[]) {
    this.runners = runners instanceof TestRunnerSource ? runners : new TestRunnerSource(parseBehavioralCommands(runners));
  }
  /** The same resolver as Verification: owner commands and automatic profiles, bound to this task's identities and ownership. */
  private commandsFor(task: { spec: { specification: Specification; strategy: TestStrategy } }, ownedPaths: string[]) {
    return resolveTaskCommands({ owner: this.runners.owner, profiles: this.runners.profiles, strategy: task.spec.strategy,
      specification: task.spec.specification, ownedPaths });
  }
  private async git(cwd: string, args: string[]) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("NODE_")));
    return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args],
      { cwd, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  private async identity(bindingInput: PaneBinding, input: unknown) {
    const binding = PaneBindingSchema.parse(bindingInput), args = record(input);
    if (binding.role !== "developer" || !binding.worktreePath) throw new Error("An assigned Developer worktree is required");
    const state = record(await this.runtime().inspect());
    if (!Array.isArray(state.outbound)) throw new Error("Invalid Runtime assignment state");
    const candidates = state.outbound.map(record).filter(out => out.status === "accepted" && out.handle &&
      RoleMessageSchema.parse(out.message).type === "task.assignment" &&
      AgentExecutionHandleSchema.parse(out.handle).target.paneId === binding.paneId &&
      (args.runId === undefined || AgentExecutionHandleSchema.parse(out.handle).runId === args.runId) &&
      (args.taskId === undefined || AgentExecutionHandleSchema.parse(out.handle).taskId === args.taskId));
    if (candidates.length !== 1) throw new Error("No unique current task assignment for this Developer pane");
    const handle = AgentExecutionHandleSchema.parse(candidates[0]!.handle);
    return { binding, runId: handle.runId, taskId: handle.taskId, args, cwd: binding.worktreePath };
  }
  private async relativePath(cwd: string, input: string): Promise<string> {
    const root = await realpath(cwd), absolute = resolve(root, input), local = relative(root, absolute);
    if (!safe(local)) throw new Error("Developer path escapes its task workspace");
    let current = root;
    for (const segment of local.split(sep)) {
      current = resolve(current, segment);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Developer file tools may not traverse symlinks"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return local.split(sep).join("/");
  }
  private scope(path: string, owned: string[], forbidden: string[]) {
    if (!safe(path) || !owned.some(prefix => covers(prefix, path)) || [...forbidden, ".git", ".bflow"].some(prefix => covers(prefix, path)))
      throw new Error(`Path '${path}' is outside the accepted task ownership`);
  }
  async authorizeFileEdit(binding: PaneBinding, input: unknown): Promise<void> {
    const context = await this.identity(binding, {}), hook = record(input), toolInput = record(hook.tool_input);
    if (!["Edit", "Write"].includes(String(hook.tool_name))) throw new Error("Only scoped file-edit tools are supported");
    const path = await this.relativePath(context.cwd, textField(toolInput.file_path));
    await this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async (task, definition) => {
      this.scope(path, strings(record(definition.metadata).ownedPaths), strings(record(definition.metadata).forbiddenPaths ?? []));
      const strategy = task.spec.strategy;
      const tests = this.commandsFor(task, strings(record(definition.metadata).ownedPaths)).flatMap(command => command.testPaths);
      const isTest = tests.some(test => test === path);
      const evidence = strategy.metadata?.tddEvidence;
      if (strategy.tddDecision.mode === "required" && Array.isArray(evidence) && evidence.length && isTest)
        throw new Error("Red test files are frozen after independent Red measurement");
      if (!(strategy.tddDecision.mode === "required" && isTest)) this.runtime().ports.policies.assertReadyToImplement(strategy);
    });
  }
  async status(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input);
    return this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async task =>
      json({ runId: context.runId, taskId: context.taskId, head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim(),
        branch: (await this.git(context.cwd, ["branch", "--show-current"])).trim(), worktreePath: context.cwd,
        tddDecision: task.spec.strategy.tddDecision, recordedEvidence: task.spec.strategy.metadata?.tddEvidence ?? [] }));
  }
  /** Useful Developer feedback, deliberately not authenticated QA evidence. */
  async check(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input);
    const selected = await this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async (task, definition) => ({
      commands: this.commandsFor(task, strings(record(definition.metadata).ownedPaths)),
      head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim()
    }));
    if (!selected.commands.length) throw new Error("No automated checks for this task: configure an owner command or make the accepted criteria and test files resolvable");
    const measurements = [];
    for (const command of selected.commands) measurements.push(await measureBehavior(command, context.cwd, selected.head));
    return json({ independentAcceptanceEvidence: false, sourceRevision: selected.head, measurements });
  }
  async commit(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input), expected = textField(context.args.expectedHead), message = textField(context.args.message);
    if (!/^[a-f0-9]{40}$/.test(expected) || message.includes("\0") || message.length > 500) throw new Error("Invalid expected revision or commit message");
    return this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async (task, definition) => {
      const tree = task.worktrees.at(-1)!;
      if ((await this.git(context.cwd, ["rev-parse", "HEAD"])).trim() !== expected ||
          (await this.git(context.cwd, ["branch", "--show-current"])).trim() !== tree.branchName)
        throw new Error("Task branch/revision changed; inspect before retrying a commit");
      if ((await this.git(context.cwd, ["ls-files", "-v", "-z"])).split("\0").some(item => /^[a-zS] /.test(item)))
        throw new Error("Hidden Git index flags require reconciliation before committing");
      const changes = (await this.git(context.cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])).split("\0").filter(Boolean);
      const owned = strings(record(definition.metadata).ownedPaths), forbidden = strings(record(definition.metadata).forbiddenPaths ?? []);
      const paths = changes.map(line => {
        if (line.slice(0, 2).includes("U") || ["AA", "DD"].includes(line.slice(0, 2))) throw new Error("Conflicts need explicit resolution");
        const path = line.slice(3); this.scope(path, owned, forbidden); return path;
      });
      if (!paths.length) return json({ committed: false, head: expected });
      const tests = this.commandsFor(task, owned).flatMap(command => command.testPaths);
      if (task.spec.strategy.tddDecision.mode === "required") {
        const evidence = task.spec.strategy.metadata?.tddEvidence;
        if (Array.isArray(evidence) && evidence.length && paths.some(path => tests.includes(path)))
          throw new Error("Red test files are frozen after independent Red measurement");
        if (!paths.every(path => tests.includes(path))) this.runtime().ports.policies.assertReadyToImplement(task.spec.strategy);
      } else this.runtime().ports.policies.assertReadyToImplement(task.spec.strategy);
      await this.git(context.cwd, ["add", "--all", "--", ...paths]);
      await this.git(context.cwd, ["commit", "-m", message]);
      return json({ committed: true, head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim() });
    });
  }
}
