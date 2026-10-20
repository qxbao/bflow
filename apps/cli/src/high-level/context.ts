import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { WorkflowDefinitionSchema, type JsonValue, type RuntimeService, type WorkflowDefinition } from "@bflow/contracts";
import { identifyRepository, type RepositoryIdentity } from "../repository.js";
import type { CliIo } from "../types.js";
import type { ParsedHighLevelArgs } from "./args.js";
import {
  errorReport,
  HighLevelError,
  notFoundError,
  validationError,
  type CommandIdentity,
  type CommandReport,
  type CommandStep,
  type HighLevelCommandName
} from "./envelope.js";
import { readOnlyGit } from "./git.js";
import { CommandJournal, reportFromRecord, type JournalAttempt, type JournalRecord } from "./journal.js";
import type { HighLevelServices } from "./services.js";

export interface HighLevelContext {
  readonly cwd: string;
  readonly io?: CliIo | undefined;
  readonly clock: () => Date;
  readonly services: HighLevelServices;
  /** Explicit RuntimeService (tests, embedding hosts). Otherwise services.openRuntime is used. */
  readonly runtime?: RuntimeService | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((step: string) => void) | undefined;
  readonly onUnits?: ((completed: number, total: number, label: string) => void) | undefined;
}

/** Human observations cannot change command outcomes or receipts. */
export function reportUnits(ctx: HighLevelContext, completed: number, total: number, label: string): void {
  try { ctx.onUnits?.(completed, total, label); } catch { /* observational only */ }
}

export type HighLevelHandler = (args: ParsedHighLevelArgs, ctx: HighLevelContext, identity: CommandIdentity) => Promise<CommandReport>;

export const CLI_STATE_DIRECTORY = ".bflow/state/cli";

export async function requireRepository(cwd: string): Promise<RepositoryIdentity> {
  try {
    return await identifyRepository(cwd);
  } catch (error) {
    throw new HighLevelError(notFoundError(error instanceof Error ? error.message : `Not a Git repository: ${cwd}`,
      { reason: "not_a_repository", cwd }));
  }
}

export function resolveInput(ctx: HighLevelContext, path: string): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

export async function readJsonFile(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HighLevelError(notFoundError(`${label} file not found: ${path}`, { reason: "file_not_found", path }));
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HighLevelError(validationError(`${label} file is not valid JSON: ${path}: ${(error as Error).message}`,
      { reason: "invalid_json", path }));
  }
}

export async function readWorkflowFile(path: string): Promise<WorkflowDefinition> {
  const parsed = WorkflowDefinitionSchema.safeParse(await readJsonFile(path, "Workflow"));
  if (!parsed.success)
    throw new HighLevelError(validationError(`Invalid workflow definition '${path}': ${parsed.error.issues.map(i => i.message).join("; ")}`,
      { reason: "invalid_workflow", path }));
  return parsed.data;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** Ordered command steps; progress is persisted before each side-effecting step. */
export class StepLog {
  readonly steps: CommandStep[] = [];
  constructor(private readonly attempt?: JournalAttempt | undefined, private readonly onProgress?: ((step: string) => void) | undefined) {}

  private progress(step: string): void {
    try { this.onProgress?.(step.replace(/[-_]+/g, " ")); } catch { /* presentation cannot affect command execution */ }
  }

  add(step: CommandStep): void {
    this.steps.push(step);
    this.progress(`${step.id}: ${step.status}`);
  }

  /** Records the intent of a side effect durably, then performs it. */
  async sideEffect<T>(id: string, action: () => Promise<T>, describe?: (value: T) => JsonValue): Promise<T> {
    this.progress(`${id}: starting`);
    await this.attempt?.progress([...this.steps, { id, status: "blocked", message: "in progress" }]);
    try {
      const value = await action();
      this.steps.push({ id, status: "succeeded", ...(describe !== undefined ? { data: describe(value) } : {}) });
      await this.attempt?.progress(this.steps);
      this.progress(`${id}: complete`);
      return value;
    } catch (error) {
      this.steps.push({ id, status: "failed", message: describeError(error) });
      this.progress(`${id}: failed`);
      throw error;
    }
  }

  /** A side-effect-free step: failures become a failed step and propagate. */
  async check<T>(id: string, action: () => Promise<T> | T, describe?: (value: T) => JsonValue): Promise<T> {
    this.progress(`${id}: checking`);
    try {
      const value = await action();
      this.steps.push({ id, status: "succeeded", ...(describe !== undefined ? { data: describe(value) } : {}) });
      this.progress(`${id}: complete`);
      return value;
    } catch (error) {
      this.steps.push({ id, status: "failed", message: describeError(error) });
      this.progress(`${id}: failed`);
      throw error;
    }
  }
}

/** Converts a thrown failure into a structured report that keeps the completed steps. */
export async function guarded(
  command: HighLevelCommandName,
  log: StepLog,
  partial: Partial<CommandReport>,
  body: () => Promise<CommandReport>
): Promise<CommandReport> {
  try {
    return await body();
  } catch (error) {
    return errorReport(command, error, { ...partial, steps: log.steps });
  }
}

export interface JournaledOptions {
  readonly command: HighLevelCommandName;
  /** Repository whose Git-ignored `.bflow/state/cli/commands` holds the receipts. */
  readonly repositoryRoot?: string | undefined;
  /** Explicit receipt directory for machine-scoped commands that need no repository. */
  readonly directory?: string | undefined;
  readonly key: string;
  /** Semantic request only; control flags such as --yes/--resume/--json are excluded. */
  readonly request: JsonValue;
  readonly retrySafe: boolean;
  readonly resume: boolean;
  readonly identity: CommandIdentity;
  readonly clock: () => Date;
  readonly onProgress?: ((step: string) => void) | undefined;
}

/**
 * CLI receipts live in the checkout; they must be Git-ignored so recording them never dirties the
 * tree that the Git engine requires to be clean. `bflow init` installs `.bflow/.gitignore`.
 */
export async function assertStateIgnored(root: string): Promise<void> {
  const result = await readOnlyGit(root, ["check-ignore", "-q", "--no-index", `${CLI_STATE_DIRECTORY}/commands/receipt.json`]);
  if (!result.ok)
    throw new HighLevelError(validationError(`'${CLI_STATE_DIRECTORY}' is not Git-ignored in ${root}; run 'bflow init' (adds .bflow/.gitignore) first`,
      { reason: "state_not_ignored" }));
}

export async function openJournal(location: { repositoryRoot?: string | undefined; directory?: string | undefined }): Promise<CommandJournal> {
  if (location.directory !== undefined) return CommandJournal.open(location.directory);
  if (location.repositoryRoot === undefined) throw new Error("A journal needs a repository root or a directory");
  await assertStateIgnored(location.repositoryRoot);
  return CommandJournal.open(join(location.repositoryRoot, CLI_STATE_DIRECTORY, "commands"));
}

/** Receipts of machine-scoped commands live in the user's private Bflow state directory. */
export function machineJournalDirectory(stateDirectory: string): string {
  return join(stateDirectory, "cli", "commands");
}

/** Runs a command body under an idempotency receipt and returns the stored or new report. */
export async function runJournaled(
  options: JournaledOptions,
  body: (log: StepLog, attempt: JournalAttempt) => Promise<CommandReport>,
  onError: (error: unknown, log: StepLog) => CommandReport
): Promise<CommandReport> {
  const journal = await openJournal(options);
  const begin = await journal.begin({
    key: options.key,
    command: options.command,
    request: options.request,
    identity: options.identity,
    retrySafe: options.retrySafe,
    resume: options.resume,
    now: () => options.clock().toISOString()
  });
  if (begin.kind === "replay") {
    const report = reportFromRecord(begin.record);
    return {
      ...report,
      steps: [{ id: "idempotent-replay", status: "reused", message: "Completed receipt replayed; no side effect repeated",
        data: { originalCommandId: begin.record.commandId, completedAt: begin.record.updatedAt } }, ...report.steps]
    };
  }
  const { attempt } = begin;
  const log = new StepLog(attempt, options.onProgress);
  if (attempt.resumed)
    log.add({ id: "resume", status: "succeeded", message: "Reconciling an interrupted invocation",
      data: { previousCommandId: attempt.previous?.commandId ?? null, previousSteps: attempt.previous?.steps.map(s => s.id) ?? [] } });
  let report: CommandReport;
  try {
    report = await body(log, attempt);
  } catch (error) {
    report = onError(error, log);
  }
  try {
    await attempt.complete(report);
  } finally {
    await attempt.release();
  }
  return report;
}

/**
 * Completed receipts of one command, oldest first by completion time. Receipt files are named by
 * key hash, so directory order is meaningless; callers that need "the" task take the last match.
 */
export async function listJournalReports(repositoryRoot: string, command: HighLevelCommandName): Promise<CommandReport[]> {
  const { readdir } = await import("node:fs/promises");
  const directory = join(repositoryRoot, CLI_STATE_DIRECTORY, "commands");
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const journal = await CommandJournal.open(directory);
  const records: JournalRecord[] = [];
  for (const name of names.filter(n => n.endsWith(".json"))) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(directory, name), "utf8")); } catch { continue; }
    const key = (raw as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof key !== "string") continue;
    const record = await journal.read(key);
    if (record?.command === command && record.status === "succeeded" && record.report !== undefined) records.push(record);
  }
  records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.idempotencyKey.localeCompare(b.idempotencyKey));
  return records.map(reportFromRecord);
}
