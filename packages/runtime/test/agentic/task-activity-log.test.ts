import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";

const roots: string[] = [];
async function log(options?: { maxEntries?: number; maxBytes?: number }) {
  const root = await mkdtemp(join(tmpdir(), "bflow-task-log-test-")); roots.push(root);
  return { root, log: await TaskActivityLog.open(join(root, "activity.jsonl"), options) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("TaskActivityLog", () => {
  it("keeps concise ordered task milestones and filters recent context", async () => {
    const { log: activity } = await log();
    await activity.record({ kind: "assignment", role: "runtime", action: "dispatch", runId: "run-1", taskId: "task-1", outcome: "accepted" });
    await activity.record({ kind: "verification", role: "qa", action: "independent_check", runId: "run-1", taskId: "task-1", outcome: "passed" });
    await activity.record({ kind: "approval", role: "conversation", action: "human_decision", runId: "run-2", outcome: "pending" });

    expect((await activity.read({ runId: "run-1", taskId: "task-1" })).map(item => item.kind)).toEqual(["assignment", "verification"]);
  });

  it("redacts secrets and strips terminal controls and line injection before persistence", async () => {
    const { root, log: activity } = await log();
    await activity.record({ kind: "tool", role: "developer", action: "run", outcome: "Authorization: Bearer super-secret\n\u001b[31mforged event\u001b[0m" });
    const raw = await readFile(join(root, "activity.jsonl"), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("\u001b");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    expect((await activity.read())[0]?.outcome).toBe("Authorization: Bearer [REDACTED] forged event");
  });

  it("bounds entry count and record size while retaining the newest milestones", async () => {
    const { log: activity } = await log({ maxEntries: 2, maxBytes: 1200 });
    await activity.record({ kind: "progress", role: "coordinator", action: "old" });
    await activity.record({ kind: "progress", role: "developer", action: "middle", outcome: "x".repeat(5000) });
    await activity.record({ kind: "result", role: "runtime", action: "new", outcome: "verified" });
    const entries = await activity.read();
    expect(entries.map(item => item.action)).toEqual(["middle", "new"]);
    expect(Buffer.byteLength(await readFile(activity.path))).toBeLessThanOrEqual(1200);
  });

  it("serializes concurrent records and keeps the full bounded ring instead of only the read default", async () => {
    const { log: activity } = await log({ maxEntries: 150, maxBytes: 100_000 });
    await Promise.all(Array.from({ length: 125 }, (_, index) => activity.record({ kind: "progress", role: "coordinator", action: `step-${index}` })));
    const entries = await activity.read({ lines: 150, maxBytes: 100_000 });
    expect(entries).toHaveLength(125);
    expect(entries[0]?.action).toBe("step-0");
    expect(entries.at(-1)?.action).toBe("step-124");
  });

  it("preserves contract-length identifiers through read filters and bounds Unicode-heavy records", async () => {
    const { log: activity } = await log();
    const runId = `r${"x".repeat(199)}`, taskId = `t${"y".repeat(199)}`, attemptId = `a${"z".repeat(199)}`;
    const write = activity.record({ kind: "progress", role: "工".repeat(32), action: "進".repeat(80), runId, taskId, attemptId, outcome: "証".repeat(240) });
    await expect(Promise.race([write, new Promise<boolean>((_resolve, reject) => setTimeout(() => reject(new Error("Unicode record shortening did not terminate")), 1000))])).resolves.toBe(true);
    const [entry] = await activity.read({ runId, taskId, lines: 1 });
    expect(entry).toMatchObject({ runId, taskId, attemptId });
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(2048);
  });

  it("does not throw when diagnostics storage is unavailable", async () => {
    const { root } = await log();
    const activity = await TaskActivityLog.open(root);
    expect(await activity.record({ kind: "error", role: "runtime", action: "capture" })).toBe(false);
  });

  it("keeps raw task scopes distinct even when display redaction or whitespace normalization collides", async () => {
    const { log: activity } = await log();
    for (const taskId of ["task a", "task\na", "sk-abcdefghijklmnop", "sk-qrstuvwxyzabcdef"]) {
      await activity.record({ kind: "progress", role: "developer", action: taskId === "task a" ? "first" : "other", runId: "run-1", taskId });
    }
    expect((await activity.read({ taskId: "task a" })).map(item => item.action)).toEqual(["first"]);
    expect(await activity.read({ taskId: "task\na" })).toHaveLength(1);
    expect(await activity.read({ taskId: "sk-abcdefghijklmnop" })).toHaveLength(1);
    expect(JSON.stringify(await activity.read())).not.toContain("sk-abcdefghijklmnop");
  });

  it("preserves legacy rows while giving new repeated events distinct identities", async () => {
    const { log: activity } = await log();
    await writeFile(activity.path, JSON.stringify({ at: "2026-10-20T00:00:00Z", kind: "progress", role: "runtime", action: "legacy", runId: "run-old" }) + "\n");
    await activity.record({ kind: "progress", role: "developer", action: "repeat", runId: "run-new" });
    await activity.record({ kind: "progress", role: "developer", action: "repeat", runId: "run-new" });
    expect(await activity.read({ runId: "run-old" })).toHaveLength(1);
    const fresh = await activity.read({ runId: "run-new" });
    expect(fresh).toHaveLength(2);
    expect(fresh[0]?.id).toBeTruthy();
    expect(fresh[0]?.id).not.toBe(fresh[1]?.id);
    expect(JSON.stringify(fresh)).not.toContain("scopes");
  });
});
