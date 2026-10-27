import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin.js";
import { parseCliArgs } from "../src/parser.js";
const report = { runId: "run-1", fullyStopped: true, blockers: [], retainedWorktrees: ["/tmp/retained"] };
afterEach(() => { process.exitCode = 0; });
describe("cancel --reconcile", () => {
  it("parses explicit recovery and rejects options that would imply another cancellation or a task-only operation", () => {
    expect(parseCliArgs(["cancel", "run-1", "--reconcile", "--json"])).toMatchObject({ ok: true, value: { reconcile: true } });
    for (const args of [["--task", "task-1"], ["--reason", "again"], ["--by", "operator"], ["--expected-version", "3"], ["--idempotency-key", "key-1"]])
      expect(parseCliArgs(["cancel", "run-1", "--reconcile", ...args])).toMatchObject({ ok: false });
  });
  it("uses the existing host recovery route without composing the legacy RuntimeService", async () => {
    const recover = vi.fn(async () => report), getRun = vi.fn(), cancel = vi.fn();
    const result = await main(["cancel", "run-1", "--reconcile", "--json"], { cwd: "/nonexistent", io: { stdout() {}, stderr() {} },
      reconcileCancellation: recover, runtime: { getRun, cancel } as any } as any);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({ ok: true, data: report });
    expect(recover).toHaveBeenCalledWith("run-1"); expect(getRun).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it("returns a nonzero status and shows actionable blockers when stop remains unconfirmed", async () => {
    const result = await main(["cancel", "run-1", "--reconcile"], { io: { stdout() {}, stderr() {} },
      reconcileCancellation: async () => ({ ...report, fullyStopped: false, blockers: ["Old process is still alive"] }) } as any);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Old process is still alive"); expect(result.stdout).toContain("/tmp/retained");
  });
  it("fails closed if there is no existing host and never bootstraps legacy state", async () => {
    const result = await main(["cancel", "run-1", "--reconcile", "--json"], { cwd: "/nonexistent", io: { stdout() {}, stderr() {} } });
    expect(result.exitCode).not.toBe(0); expect(JSON.parse(result.stderr!)).toMatchObject({ ok: false });
  });
  it("rejects malformed or foreign host reports", async () => {
    for (const value of [{ ...report, runId: "other" }, { ...report, fullyStopped: "yes" }, { ...report, secret: "bad" }]) {
      const result = await main(["cancel", "run-1", "--reconcile", "--json"], { io: { stdout() {}, stderr() {} },
        reconcileCancellation: async () => value } as any);
      expect(result.exitCode).not.toBe(0);
    }
  });
});
