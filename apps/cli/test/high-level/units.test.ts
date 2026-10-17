import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionResultSchema } from "@bflow/contracts";
import { parseCommandArgs } from "../../src/high-level/args.js";
import {
  buildEnvelope,
  errorReport,
  exitCodeForError,
  HIGH_LEVEL_EXIT_CODES,
  HighLevelEnvelopeSchema,
  HighLevelError,
  newCommandIdentity,
  permissionError,
  toContractError
} from "../../src/high-level/envelope.js";
import { CommandJournal, requestDigest } from "../../src/high-level/journal.js";
import { HIGH_LEVEL_COMMAND_SPECS } from "../../src/high-level/index.js";
import { TASK_IMPLEMENT_SPEC } from "../../src/high-level/commands/task-implement.js";
import { tempDir } from "./fixtures.js";

const usage = (fn: () => unknown) => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(HighLevelError);
    expect((error as HighLevelError).exitCode).toBe(HIGH_LEVEL_EXIT_CODES.USAGE);
    return (error as HighLevelError).message;
  }
  throw new Error("expected a usage error");
};

describe("high-level argument parsing", () => {
  it("parses positionals, repeated, boolean and common flags", () => {
    const parsed = parseCommandArgs(TASK_IMPLEMENT_SPEC, ["implement", "--run", "run-1", "--spec=spec.json", "--owned-path", "src/a",
      "--owned-path", "src/b", "--resume", "-j", "--correlation-id", "corr-9"]);
    expect(parsed.positionals["task-id"]).toBe("implement");
    expect(parsed.strings.get("--spec")).toBe("spec.json");
    expect(parsed.lists.get("--owned-path")).toEqual(["src/a", "src/b"]);
    expect(parsed.booleans.has("--resume")).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.correlationId).toBe("corr-9");
  });

  it("rejects invalid arguments with usage errors", () => {
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--run", "r", "--spec", "s", "--bogus"]))).toContain("Unknown option '--bogus'");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--spec", "s"]))).toContain("Missing required option '--run'");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["--run", "r", "--spec", "s"]))).toContain("Missing required argument <task-id>");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "extra", "--run", "r", "--spec", "s"]))).toContain("Unexpected argument 'extra'");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["../etc", "--run", "r", "--spec", "s"]))).toContain("not a valid identifier");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--run"]))).toContain("requires a value");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--run", "a", "--run", "b", "--spec", "s"]))).toContain("only once");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--run", "r", "--spec", "s", "--resume=yes"]))).toContain("does not take a value");
    expect(usage(() => parseCommandArgs(TASK_IMPLEMENT_SPEC, ["t1", "--run", "r", "--spec", "s", "--idempotency-key", "a b"]))).toContain("safe identifier");
  });

  it("returns help without enforcing required arguments", () => {
    const parsed = parseCommandArgs(TASK_IMPLEMENT_SPEC, ["--help"]);
    expect(parsed.help).toBe(true);
  });

  it("every command declares --json and --help through the common flags", () => {
    for (const spec of HIGH_LEVEL_COMMAND_SPECS) {
      const required = spec.positionals.filter(p => p.required).map(() => "x1");
      const flags = Object.entries(spec.flags).filter(([, f]) => f.required).flatMap(([name]) => [name, "v1"]);
      expect(parseCommandArgs(spec, [...required, ...flags, "--json"]).json).toBe(true);
      expect(parseCommandArgs(spec, ["--help"]).help).toBe(true);
    }
  });
});

describe("result envelope and exit codes", () => {
  it("maps contract errors to stable exit codes", () => {
    expect(exitCodeForError({ code: "not_found", retryable: false, message: "x" })).toBe(4);
    expect(exitCodeForError({ code: "conflict", retryable: true, message: "x" })).toBe(6);
    expect(exitCodeForError({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "x" })).toBe(7);
    expect(exitCodeForError(permissionError("needs --yes", "--yes"))).toBe(5);
    expect(exitCodeForError({ code: "validation", retryable: false, message: "x" })).toBe(1);
    expect(exitCodeForError({ code: "timeout", retryable: true, retrySafety: "not_started", message: "x" })).toBe(1);
  });

  it("normalizes thrown values, including Git engine busy errors", () => {
    expect(toContractError(new Error("boom"))).toEqual({ code: "validation", retryable: false, message: "boom" });
    expect(toContractError(Object.assign(new Error("Repository is busy"), { code: "busy" })).code).toBe("conflict");
    expect(toContractError({ code: "not_found", retryable: false, message: "gone" }).code).toBe("not_found");
  });

  it("produces envelopes that satisfy CommandExecutionResult and reject inconsistent ones", () => {
    const identity = newCommandIdentity("corr-1");
    const failed = buildEnvelope(identity, errorReport("verify", new HighLevelError({ code: "not_found", retryable: false, message: "no task" }),
      { runId: "run-1", taskId: "t" }), new Date().toISOString());
    expect(failed.exitCode).toBe(4);
    expect(failed.ok).toBe(false);
    expect(failed.result.correlationId).toBe("corr-1");
    expect(CommandExecutionResultSchema.safeParse(failed.result).success).toBe(true);
    const unknown = errorReport("task.implement", new HighLevelError({ code: "unknown_delivery", retryable: false,
      manualInterventionRequired: true, message: "interrupted" }));
    expect(unknown.status).toBe("unknown");
    expect(unknown.outcome).toBe("reconciliation_required");
    expect(HighLevelEnvelopeSchema.safeParse({ ...failed, ok: true }).success).toBe(false);
    expect(HighLevelEnvelopeSchema.safeParse({ ...failed, command: "repo.inspect" }).success).toBe(false);
  });
});

describe("command journal", () => {
  const begin = (journal: CommandJournal, request: object, extra: Partial<Parameters<CommandJournal["begin"]>[0]> = {}) =>
    journal.begin({ key: "k1", command: "task.implement", request: request as never, identity: newCommandIdentity(),
      retrySafe: false, resume: false, now: () => new Date().toISOString(), ...extra });
  const report = { command: "task.implement" as const, outcome: "prepared" as const, status: "succeeded" as const, exitCode: 0 as const,
    steps: [{ id: "prepare-worktree", status: "succeeded" as const }], data: { taskKey: "x" } };

  it("replays a completed receipt and rejects reuse of its key for another request", async () => {
    const journal = await CommandJournal.open(join(tempDir("bflow-journal-"), "commands"));
    const first = await begin(journal, { a: 1 });
    if (first.kind !== "execute") throw new Error("expected execute");
    await first.attempt.complete(report);
    await first.attempt.release();
    const second = await begin(journal, { a: 1 });
    expect(second.kind).toBe("replay");
    await expect(begin(journal, { a: 2 })).rejects.toMatchObject({ contractError: { code: "conflict" } });
  });

  it("serializes concurrent invocations of one key", async () => {
    const journal = await CommandJournal.open(join(tempDir("bflow-journal-"), "commands"));
    const first = await begin(journal, { a: 1 });
    await expect(begin(journal, { a: 1 })).rejects.toMatchObject({ contractError: { code: "conflict", details: { reason: "busy" } } });
    if (first.kind === "execute") await first.attempt.release();
  });

  it("refuses to repeat an interrupted unsafe operation until --resume, and recovers stale locks", async () => {
    const directory = join(tempDir("bflow-journal-"), "commands");
    const journal = await CommandJournal.open(directory);
    const first = await begin(journal, { a: 1 });
    if (first.kind !== "execute") throw new Error("expected execute");
    await first.attempt.progress([{ id: "prepare-worktree", status: "blocked", message: "in progress" }]);
    // Simulate process death: the lock remains with a PID that no longer exists.
    const lock = readdirSync(directory).find(name => name.endsWith(".lock"))!;
    writeFileSync(join(directory, lock), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(),
      token: "dead", acquiredAt: new Date().toISOString() }));
    await expect(begin(journal, { a: 1 })).rejects.toMatchObject({ contractError: { code: "unknown_delivery" }, exitCode: 7 });
    const resumed = await begin(journal, { a: 1 }, { resume: true });
    expect(resumed.kind).toBe("execute");
    if (resumed.kind === "execute") {
      expect(resumed.attempt.resumed).toBe(true);
      expect(resumed.attempt.previous?.steps.at(-1)?.id).toBe("prepare-worktree");
      await resumed.attempt.release();
    }
  });

  it("re-executes failed receipts and treats corrupt receipts as corruption", async () => {
    const directory = join(tempDir("bflow-journal-"), "commands");
    const journal = await CommandJournal.open(directory);
    const first = await begin(journal, { a: 1 });
    if (first.kind !== "execute") throw new Error("expected execute");
    await first.attempt.complete({ ...report, status: "failed", outcome: "failed", exitCode: 1,
      error: { code: "validation", retryable: false, message: "bad" } });
    await first.attempt.release();
    const retry = await begin(journal, { a: 1 });
    expect(retry.kind).toBe("execute");
    if (retry.kind === "execute") await retry.attempt.release();
    mkdirSync(directory, { recursive: true });
    for (const name of readdirSync(directory).filter(n => n.endsWith(".json"))) writeFileSync(join(directory, name), "{\"nope\":1}");
    await expect(begin(journal, { a: 1 })).rejects.toMatchObject({ contractError: { code: "corruption" } });
  });

  it("digests requests canonically", () => {
    expect(requestDigest({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(requestDigest({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(requestDigest({ a: 1 })).not.toBe(requestDigest({ a: 2 }));
  });
});

describe("published command reference", () => {
  it("matches the parser specs (regenerate apps/cli/docs/command-reference.json on change)", async () => {
    const { describeHighLevelCommands } = await import("../../src/high-level/reference.js");
    const { readFileSync } = await import("node:fs");
    const published = JSON.parse(readFileSync(join(import.meta.dirname, "../../docs/command-reference.json"), "utf8"));
    expect(published).toEqual(describeHighLevelCommands(HIGH_LEVEL_COMMAND_SPECS));
    const doc = readFileSync(join(import.meta.dirname, "../../docs/command-reference.md"), "utf8");
    for (const spec of HIGH_LEVEL_COMMAND_SPECS) {
      expect(doc, spec.name).toContain(`bflow ${spec.words.join(" ")}`);
      for (const flag of Object.keys(spec.flags)) expect(doc, `${spec.name} ${flag}`).toContain(flag);
    }
  });
});
