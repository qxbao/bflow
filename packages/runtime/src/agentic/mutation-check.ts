import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityGateDefinitionSchema, type QualityGateDefinition } from "@bflow/contracts";
import { record, textField } from "./journal.js";
import { measureBehavior, verificationGit, type BehavioralCommand, type BehavioralMeasurement } from "./behavioral-runner.js";

/**
 * Owner-configured mutation check: replace one protection (for example a lock) in one committed file by `replace`
 * and require that the named tests FAIL. Surviving tests are non-discriminating evidence for that protection.
 * Trusted owner input; it is never accepted from a role message.
 */
export interface MutationCheck {
  readonly id: string;
  /** Must reference a configured owner behavioral command whose testNames include every expected test. */
  readonly commandId: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly expectFailingTests: readonly string[];
}

export type MutatedRevision =
  | { readonly status: "mutated"; readonly revision: string }
  | { readonly status: "not_applicable"; readonly reason: "file_absent" | "pattern_absent" };

/** Same per-run allowance the behavioral budget uses for checkout, setup and cleanup. */
const RUN_ALLOWANCE_MS = 90_000;
const AGGREGATE_BUDGET_MS = 540_000;
const MAX_TEXT = 4096;
const ALLOWED_KEYS = ["id", "commandId", "file", "find", "replace", "expectFailingTests"];

function assertSafeFile(file: string): void {
  if (file.includes("\0") || file.includes("\\") || file.includes(":") || file.startsWith("/") ||
      file.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Mutation file must be a repository-relative path without traversal");
}

/** Parses owner `mutationChecks` against the already-parsed behavioral commands; rejects unknown or unsafe configuration. */
export function parseMutationChecks(input: unknown, commands: readonly BehavioralCommand[]): MutationCheck[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("mutationChecks must be an array");
  const checks = input.map((raw): MutationCheck => {
    const value = record(raw);
    if (Object.keys(value).some(key => !ALLOWED_KEYS.includes(key))) throw new Error("Unknown mutation check configuration field");
    const id = textField(value.id), commandId = textField(value.commandId), file = textField(value.file);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("Mutation check id must be safe");
    assertSafeFile(file);
    if (typeof value.find !== "string" || value.find.length === 0 || value.find.length > MAX_TEXT) throw new Error("Mutation find must be a nonempty string of at most 4096 characters");
    if (typeof value.replace !== "string" || value.replace.length > MAX_TEXT) throw new Error("Mutation replace must be a string of at most 4096 characters");
    if (value.replace === value.find) throw new Error("Mutation replace must differ from find");
    if (!Array.isArray(value.expectFailingTests) || value.expectFailingTests.length === 0 ||
        value.expectFailingTests.some(name => typeof name !== "string" || !name.length || name.includes("\0")) || new Set(value.expectFailingTests).size !== value.expectFailingTests.length)
      throw new Error("Mutation expectFailingTests must be a nonempty list of unique test names");
    const command = commands.find(item => item.id === commandId);
    if (!command) throw new Error(`Mutation check ${id} references an unknown behavioral command`);
    const expected = value.expectFailingTests as string[];
    if (expected.some(name => !command.testNames.includes(name))) throw new Error(`Mutation check ${id} expects tests that the behavioral command does not run`);
    return { id, commandId, file, find: value.find, replace: value.replace, expectFailingTests: expected };
  });
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new Error("Duplicate mutation check identity");
  // Mutation runs share the behavioral request deadline, so both budgets are summed against the same host limit.
  const behavioral = commands.reduce((total, command) => total + command.timeoutMs + RUN_ALLOWANCE_MS, 0);
  const mutation = checks.reduce((total, check) => total + commands.find(item => item.id === check.commandId)!.timeoutMs + RUN_ALLOWANCE_MS, 0);
  if (behavioral + mutation > AGGREGATE_BUDGET_MS) throw new Error("Aggregate behavioral and mutation execution budget exceeds the host deadline");
  return checks;
}

/** Host gate definitions, one per configured mutation check. The check binds no acceptance criteria. */
export function mutationChecks(checks: readonly MutationCheck[], commands: readonly BehavioralCommand[]): QualityGateDefinition[] {
  return checks.map(check => {
    const command = commands.find(item => item.id === check.commandId);
    if (!command) throw new Error(`Mutation check ${check.id} references an unknown behavioral command`);
    return QualityGateDefinitionSchema.parse({ id: `host-mutation-${check.id}`, name: `Mutation ${check.id}`, evaluator: "host-mutation-check", required: true,
      timeout: { executionTimeoutMs: command.timeoutMs + 60_000, onTimeout: "block" },
      configuration: { kind: "deterministic", method: command.method, command: command.command, criterionIds: [], testNames: [...check.expectFailingTests],
        role: "quality_gate", levels: command.levels } });
  });
}

/**
 * Builds a dangling commit whose tree is `revision` with exactly one occurrence of `find` replaced in `file`.
 * No worktree, HEAD or repository index is touched: the blob is hashed from stdin and the tree is assembled in a
 * private scratch index (GIT_INDEX_FILE), then committed with a fixed identity. No ref is created.
 */
export async function createMutatedRevision(cwd: string, revision: string, check: Pick<MutationCheck, "id" | "file" | "find" | "replace">): Promise<MutatedRevision> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Mutation revision must be a full commit identity");
  assertSafeFile(check.file);
  const entry = (await verificationGit(cwd, ["ls-tree", revision, "--", check.file])).trim();
  if (!entry) return { status: "not_applicable", reason: "file_absent" };
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\n]*)$/.exec(entry);
  if (!match || match[3] !== check.file) throw new Error(`Mutation ${check.id} target must be a committed regular file`);
  const content = await verificationGit(cwd, ["cat-file", "blob", match[2]!]);
  if (content.includes("�")) throw new Error(`Mutation ${check.id} target is not UTF-8 text`);
  const count = content.split(check.find).length - 1;
  if (count === 0) return { status: "not_applicable", reason: "pattern_absent" };
  if (count > 1) throw new Error(`Mutation ${check.id} find text occurs ${count} times; make the owner pattern unique`);
  const index = content.indexOf(check.find);
  const mutated = content.slice(0, index) + check.replace + content.slice(index + check.find.length);
  const scratch = await mkdtemp(join(tmpdir(), "bflow-mutation-"));
  try {
    const indexFile = join(scratch, "index");
    const blob = (await verificationGit(cwd, ["hash-object", "-w", "--stdin"], { input: mutated })).trim();
    await verificationGit(cwd, ["read-tree", revision], { indexFile });
    await verificationGit(cwd, ["update-index", "--add", "--cacheinfo", `${match[1]},${blob},${check.file}`], { indexFile });
    const tree = (await verificationGit(cwd, ["write-tree"], { indexFile })).trim();
    const commit = (await verificationGit(cwd, ["-c", "user.name=bflow", "-c", "user.email=bflow@localhost", "-c", "commit.gpgSign=false",
      "commit-tree", tree, "-p", revision, "-m", `bflow mutation ${check.id}`])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Mutated revision was not created");
    return { status: "mutated", revision: commit };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs `use` with a temporary detached checkout of `revision` (the behavioral measurement requires its cwd HEAD to be
 * the measured revision). The checkout is removed afterwards; the caller's worktree is never modified.
 */
export async function withMutatedCheckout<T>(cwd: string, revision: string, use: (checkout: string) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "bflow-mutation-"));
  const checkout = join(temporary, "checkout");
  let added = false;
  try {
    await verificationGit(cwd, ["worktree", "add", "--detach", checkout, revision]);
    added = true;
    return await use(checkout);
  } finally {
    try { if (added) await verificationGit(cwd, ["worktree", "remove", "--force", checkout]); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

/** Pure kill/survive decision: killed only when every expected test failed (assertion failures, see parseNodeTap). */
export function assessMutation(check: Pick<MutationCheck, "expectFailingTests">, measured: Pick<BehavioralMeasurement, "testResults">) {
  const passedNames = check.expectFailingTests.filter(name => measured.testResults.find(result => result.name === name)?.passed !== false);
  return { killed: passedNames.length === 0, survivors: passedNames, killedCount: check.expectFailingTests.length - passedNames.length };
}

/** Measures the mutated commit through the same owner command; `measureBehavior` throws on non-assertion failures. */
export async function measureMutation(command: BehavioralCommand, cwd: string, mutatedRevision: string): Promise<BehavioralMeasurement> {
  return withMutatedCheckout(cwd, mutatedRevision, checkout => measureBehavior(command, checkout, mutatedRevision));
}
