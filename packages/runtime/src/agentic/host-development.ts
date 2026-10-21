import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AgentExecutionHandleSchema, PaneBindingSchema, RoleMessageSchema, type PaneBinding } from "@bflow/contracts";
import { measureBehavior, parseBehavioralCommands, type BehavioralCommand } from "./behavioral-runner.js";
import { TestRunnerSource, resolveTaskCommands } from "./task-commands.js";
import { isConflictResolverAssignment, type AgenticWorkflowRuntime } from "./runtime.js";
import { json, record, strings, textField } from "./journal.js";
import type { JsonValue, Specification, TestStrategy } from "@bflow/contracts";

const execute = promisify(execFile);
/** Rules every conflict resolver receives in assignment_context and workspace_status. */
export const CONFLICT_RESOLVER_RULES: readonly string[] = [
  "Edit only the files listed in conflictPaths; every other path is refused.",
  "Combine both sides' intent; never take ours or theirs wholesale without checking what the other side changed.",
  "Remove every conflict marker; never reset, abort or restart the merge.",
  "Commit the resolution with commit_changes (expectedHead = head); it concludes the merge and Runtime submits it to P18 accept_conflict_resolution.",
  "request_verification, authorize_implementation and submit_implementation do not apply; after commit_changes, end your turn.",
  "If you cannot resolve it, send task.status with status \"failed\" and the reason to coordinator (causation_id = assignment message_id)."
];
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
  private commandsFor(task: { spec: { specification: Specification; strategy: TestStrategy }; worktrees?: { baseCommitHash: string }[] }, ownedPaths: string[]) {
    return resolveTaskCommands({ owner: this.runners.owner, profiles: this.runners.profilesForRevision(task.worktrees?.at(-1)?.baseCommitHash), strategy: task.spec.strategy,
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
    return { binding, runId: handle.runId, taskId: handle.taskId, args, cwd: binding.worktreePath,
      resolver: isConflictResolverAssignment(RoleMessageSchema.parse(candidates[0]!.message)) };
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
  /** The current resolver assignment of this pane, or undefined when the pane holds an ordinary Core task (or none). */
  private async resolverIdentity(binding: PaneBinding) {
    try { const context = await this.identity(binding, {}); return context.resolver ? context : undefined; }
    catch { return undefined; }
  }
  /** Full working context for a conflict resolver: files, worktree, revisions and the rules it must follow. */
  async conflictResolutionContext(binding: PaneBinding): Promise<JsonValue | undefined> {
    const context = await this.resolverIdentity(binding);
    if (!context) return undefined;
    return this.runtime().withConflictResolverWorkspace(context.binding, context.runId, context.taskId, async resolution => {
      let mergeHead: string | null = null;
      try { mergeHead = (await this.git(context.cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).trim() || null; } catch { mergeHead = null; }
      const unmerged = (await this.git(context.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      return json({ kind: "conflict_resolution", runId: context.runId, taskId: context.taskId, worktreePath: context.cwd,
        branch: (await this.git(context.cwd, ["branch", "--show-current"])).trim(), expectedBranch: resolution.branchName,
        base: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim(), head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim(),
        incomingCommitHash: resolution.incomingCommitHash ?? mergeHead, mergeInProgress: mergeHead !== null,
        conflictPaths: resolution.conflictPaths, unmergedPaths: unmerged, attempt: resolution.attempt, maxAttempts: resolution.maxAttempts,
        previousFailures: resolution.previousFailures, rules: CONFLICT_RESOLVER_RULES });
    });
  }
  /** Core-task-only tools refuse a resolver with an actionable message instead of a missing-task error. */
  async refuseForResolver(binding: PaneBinding, tool: string): Promise<void> {
    if (await this.resolverIdentity(binding))
      throw new Error(`${tool} is not used for a conflict resolution assignment; edit only the conflicted files, commit the resolution with commit_changes, then end your turn`);
  }
  async authorizeFileEdit(binding: PaneBinding, input: unknown): Promise<void> {
    const context = await this.identity(binding, {}), hook = record(input), toolInput = record(hook.tool_input);
    if (!["Edit", "Write"].includes(String(hook.tool_name))) throw new Error("Only scoped file-edit tools are supported");
    const path = await this.relativePath(context.cwd, textField(toolInput.file_path));
    if (context.resolver) {
      // A conflict resolver edits only the files P18 reported as conflicted; P18 re-checks the task scope on acceptance.
      await this.runtime().withConflictResolverWorkspace(context.binding, context.runId, context.taskId, async resolution => {
        if (!resolution.conflictPaths.includes(path)) throw new Error(`Path '${path}' is not one of the conflicted files: ${resolution.conflictPaths.join(", ")}`);
      });
      return;
    }
    await this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async (task, definition) => {
      this.scope(path, strings(record(definition.metadata).ownedPaths), strings(record(definition.metadata).forbiddenPaths ?? []));
      const strategy = task.spec.strategy;
      const tests = this.commandsFor(task, strings(record(definition.metadata).ownedPaths)).flatMap(command => [...command.testPaths, ...Object.keys(command.definitionBlobs ?? {})]);
      const isTest = tests.some(test => test === path);
      const evidence = strategy.metadata?.tddEvidence;
      if (strategy.tddDecision.mode === "required" && Array.isArray(evidence) && evidence.length && isTest)
        throw new Error("Red test files are frozen after independent Red measurement");
      if (!(strategy.tddDecision.mode === "required" && isTest)) this.runtime().ports.policies.assertReadyToImplement(strategy);
    });
  }
  async status(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input);
    if (context.resolver) return (await this.conflictResolutionContext(binding))!;
    return this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async task =>
      json({ runId: context.runId, taskId: context.taskId, head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim(),
        branch: (await this.git(context.cwd, ["branch", "--show-current"])).trim(), worktreePath: context.cwd,
        tddDecision: task.spec.strategy.tddDecision, recordedEvidence: task.spec.strategy.metadata?.tddEvidence ?? [] }));
  }
  /** Useful Developer feedback, deliberately not authenticated QA evidence. */
  async check(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input);
    if (context.resolver) return json({ applicable: false, independentAcceptanceEvidence: false,
      reason: "check_work does not apply to a conflict resolution: it has no task test plan. Commit the resolution with commit_changes; Runtime then runs independent workflow verification on the integrated result." });
    const selected = await this.runtime().withDeveloperWorkspace(context.binding, context.runId, context.taskId, async (task, definition) => ({
      commands: this.commandsFor(task, strings(record(definition.metadata).ownedPaths)),
      head: (await this.git(context.cwd, ["rev-parse", "HEAD"])).trim(),
      originalRevision: task.worktrees.at(-1)!.baseCommitHash
    }));
    if (!selected.commands.length) throw new Error("No automated checks for this task: configure an owner command or make the accepted criteria and test files resolvable");
    const measurements = [];
    for (const command of selected.commands) measurements.push(await measureBehavior(command.checkoutDependencyRoots === undefined ? command : { ...command, originalRevision: selected.originalRevision }, context.cwd, selected.head));
    return json({ independentAcceptanceEvidence: false, sourceRevision: selected.head, measurements });
  }
  /**
   * Concludes the preserved P18 merge with the resolver's edits. Only the conflicted files may differ from what the merge staged,
   * no conflict marker may remain, and nothing is chosen automatically: the Developer's edited content is committed as is.
   */
  private async commitMergeResolution(cwd: string, expected: string, message: string, resolution: { conflictPaths: string[]; branchName: string }): Promise<string> {
    if ((await this.git(cwd, ["rev-parse", "HEAD"])).trim() !== expected || (await this.git(cwd, ["branch", "--show-current"])).trim() !== resolution.branchName)
      throw new Error("Integration branch/revision changed; inspect before retrying a commit");
    try { await this.git(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]); }
    catch { throw new Error("No merge is in progress in the integration worktree; the conflict cannot be concluded by this commit"); }
    if ((await this.git(cwd, ["ls-files", "-v", "-z"])).split("\0").some(item => /^[a-zS] /.test(item)))
      throw new Error("Hidden Git index flags require reconciliation before committing");
    const conflicted = new Set(resolution.conflictPaths);
    for (const line of (await this.git(cwd, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])).split("\0").filter(Boolean)) {
      const path = line.slice(3);
      if (conflicted.has(path)) continue;
      // Entries the merge itself staged are fine; unstaged, untracked or still-unmerged non-conflict paths are not the resolver's to change.
      if (line[1] !== " " || line.slice(0, 2).includes("U") || ["AA", "DD"].includes(line.slice(0, 2)))
        throw new Error(`Path '${path}' is outside the conflicted files: ${resolution.conflictPaths.join(", ")}`);
    }
    for (const path of resolution.conflictPaths) {
      const local = await this.relativePath(cwd, path);
      let content: string | undefined;
      try { content = await readFile(resolve(cwd, local), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (content !== undefined && /^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(content)) throw new Error(`Conflict markers remain in '${path}'`);
    }
    await this.git(cwd, ["add", "--all", "--", ...resolution.conflictPaths]);
    if ((await this.git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").some(Boolean))
      throw new Error("Unmerged paths remain; resolve every conflicted file before committing");
    await this.git(cwd, ["commit", "-m", message]);
    return (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
  }
  async commit(binding: PaneBinding, input: unknown) {
    const context = await this.identity(binding, input), expected = textField(context.args.expectedHead), message = textField(context.args.message);
    if (!/^[a-f0-9]{40}$/.test(expected) || message.includes("\0") || message.length > 500) throw new Error("Invalid expected revision or commit message");
    if (context.resolver) return this.runtime().commitConflictResolution(context.binding, context.runId, context.taskId, resolution =>
      this.commitMergeResolution(context.cwd, expected, message, resolution));
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
      const tests = this.commandsFor(task, owned).flatMap(command => [...command.testPaths, ...Object.keys(command.definitionBlobs ?? {})]);
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
