import { describe, expect, it, vi } from "vitest";
import { defaultDirectorProgressDeps, parseProgressCliArgs, runProgressCommand, runQueueCommand, type DirectorProgressDeps } from "../src/director-progress.js";

const T = "2026-11-03T00:00:00.000Z";
const issue = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, issueId: "iss-1", runId: "run-1", taskKey: "t1", kind: "transport_failure", status: "open", summary: "Lỗi mạng", attempts: 1, evidence: [], createdAt: T, updatedAt: T, ...over });
const snapshot = { schemaVersion: 1, generatedAt: T, director: { presence: "active" }, runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [] };

function make(over: Partial<DirectorProgressDeps> = {}, ownerImpl?: (m: string, i: unknown) => unknown) {
  const out: string[] = []; const err: string[] = [];
  const ac = new AbortController();
  const ownerCall = vi.fn(async (_o: unknown, m: string, i: unknown) => ownerImpl ? ownerImpl(m, i) : snapshot);
  const deps: DirectorProgressDeps = {
    cwd: "/repo",
    identify: async () => ({ root: "/repo", sessionName: "bf-1" }),
    ownerCall: ownerCall as never,
    render: vi.fn(() => ["line A", "line B"]) as never,
    now: () => new Date(T),
    sleep: async () => {},
    signal: ac.signal,
    stdout: { write: c => { out.push(c); }, columns: 100, rows: 30 },
    stderr: { write: c => { err.push(c); } },
    ...over
  };
  return { deps, out, err, ownerCall, ac };
}
describe("progress", () => {
  it("renders once as text and as one JSON value", async () => {
    const a = make();
    expect(await runProgressCommand({ cmd: "progress", follow: false, json: false }, a.deps)).toBe(0);
    expect(a.out.join("")).toBe("line A\nline B\n");
    expect(a.deps.render).toHaveBeenCalledWith(snapshot, { width: 100, height: 30, now: new Date(T) });
    const b = make();
    await runProgressCommand({ cmd: "progress", follow: false, json: true }, b.deps);
    expect(JSON.parse(b.out.join(""))).toEqual(snapshot);
  });
  it("host down without follow exits 1", async () => {
    const a = make({}, () => { throw new Error("Host unavailable"); });
    expect(await runProgressCommand({ cmd: "progress", follow: false, json: false }, a.deps)).toBe(1);
    expect(a.err.join("")).toContain("Chưa có phiên");
  });
  it("follow redraws two cycles then stops on abort, surviving a down host", async () => {
    let n = 0;
    const a = make({}, () => { if (n++ === 0) throw new Error("Host unavailable"); return snapshot; });
    let sleeps = 0;
    a.deps = { ...a.deps, sleep: async () => { if (++sleeps === 2) a.ac.abort(); } };
    expect(await runProgressCommand({ cmd: "progress", follow: true, json: false }, a.deps)).toBe(0);
    expect(a.out).toHaveLength(2);
    expect(a.out[0]).toContain("\x1b[H\x1b[2J");
    expect(a.out[0]).toContain("Chưa có phiên");
    expect(a.out[1]).toContain("line A");
  });
});

describe("progress garbage response and signals", () => {
  it("garbage response without follow exits 1", async () => {
    const a = make({}, () => ({ nope: true }));
    expect(await runProgressCommand({ cmd: "progress", follow: false, json: false }, a.deps)).toBe(1);
    expect(a.err.join("")).toContain("Chưa có phiên");
  });
  it("garbage response with follow draws unavailable line and continues", async () => {
    const a = make({}, () => ({ nope: true }));
    let sleeps = 0;
    a.deps = { ...a.deps, sleep: async () => { if (++sleeps === 2) a.ac.abort(); } };
    expect(await runProgressCommand({ cmd: "progress", follow: true, json: false }, a.deps)).toBe(0);
    expect(a.out).toHaveLength(2);
    expect(a.out.every(o => o.includes("Chưa có phiên"))).toBe(true);
  });
  it("non-follow adds no signal listeners; follow adds then removes them", async () => {
    const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const base = count();
    await defaultDirectorProgressDeps("/repo");
    expect(count()).toBe(base);
    const deps = await defaultDirectorProgressDeps("/repo", true);
    expect(count()).toBe(base + 2);
    const mine = process.listeners("SIGINT").at(-1) as () => void;
    const out: string[] = [];
    const run = runProgressCommand({ cmd: "progress", follow: true, json: false }, {
      ...deps,
      identify: async () => ({ root: "/repo", sessionName: "bf" }),
      ownerCall: async () => snapshot,
      sleep: async () => { mine(); },
      stdout: { write: c => { out.push(c); } }
    });
    expect(await run).toBe(0);
    expect(count()).toBe(base);
  });
});

describe("queue", () => {
  it("empty list", async () => {
    const a = make({}, () => []);
    expect(await runQueueCommand({ cmd: "queue", sub: "list", json: false }, a.deps)).toBe(0);
    expect(a.out.join("")).toContain("Hàng đợi lỗi trống");
  });
  it("list table and json with status filter", async () => {
    const a = make({}, () => [issue()]);
    await runQueueCommand({ cmd: "queue", sub: "list", status: ["open"], json: false }, a.deps);
    expect(a.out.join("")).toContain("iss-1");
    expect(a.ownerCall.mock.calls[0]![2]).toEqual({ status: ["open"] });
    const b = make({}, () => [issue()]);
    await runQueueCommand({ cmd: "queue", sub: "list", json: true }, b.deps);
    expect(JSON.parse(b.out.join(""))).toHaveLength(1);
  });
  it("show", async () => {
    const a = make({}, () => issue());
    await runQueueCommand({ cmd: "queue", sub: "show", issueId: "iss-1", json: false }, a.deps);
    expect(a.out.join("")).toContain("Tóm tắt: Lỗi mạng");
  });
  it("retry and dismiss call the right status", async () => {
    const a = make({}, (_m, i) => issue({ status: (i as { status: string }).status }));
    await runQueueCommand({ cmd: "queue", sub: "retry", issueId: "iss-1" }, a.deps);
    expect(a.ownerCall.mock.calls[0]!.slice(1)).toEqual(["director_issue_status", { issueId: "iss-1", status: "retrying" }]);
    await runQueueCommand({ cmd: "queue", sub: "dismiss", issueId: "iss-1" }, a.deps);
    expect(a.ownerCall.mock.calls[1]![2]).toEqual({ issueId: "iss-1", status: "dismissed" });
  });
  it("parser rejects missing id and bad status", () => {
    expect(parseProgressCliArgs("queue", ["retry"]).ok).toBe(false);
    expect(parseProgressCliArgs("queue", ["show"]).ok).toBe(false);
    expect(parseProgressCliArgs("queue", ["list", "--status", "bogus"]).ok).toBe(false);
    expect(parseProgressCliArgs("queue", ["list", "--status", "open,retrying"]).ok).toBe(true);
    expect(parseProgressCliArgs("progress", ["--follow", "--json"]).ok).toBe(true);
  });
});
