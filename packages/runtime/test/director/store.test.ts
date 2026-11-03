import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DirectorAuthError, DirectorStore } from "../../src/director/store.js";

const dirs: string[] = [];
let clock = new Date("2026-11-03T00:00:00.000Z");
const now = () => new Date(clock);

async function fresh(): Promise<{ store: DirectorStore; dir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-store-"));
  dirs.push(root);
  const dir = path.join(root, "state");
  clock = new Date("2026-11-03T00:00:00.000Z");
  return { store: new DirectorStore({ directory: dir, now }), dir };
}
const reg = (store: DirectorStore) => store.register({ provider: "claude", repositoryRoot: "/repo" });
const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

describe("DirectorStore", () => {
  it("authenticates the current token and rejects the replaced one", async () => {
    const { store } = await fresh();
    const first = await reg(store);
    expect((await store.authenticate(first.token)).directorId).toBe(first.session.directorId);
    const second = await reg(store);
    await expect(store.authenticate(first.token)).rejects.toBeInstanceOf(DirectorAuthError);
    expect((await store.authenticate(second.token)).tokenId).toBe(second.session.tokenId);
  });

  it("rejects malformed tokens without leaking the secret", async () => {
    const { store } = await fresh();
    const { session, token } = await reg(store);
    const secret = token.split(".")[1]!;
    await expect(store.authenticate("garbage")).rejects.toBeInstanceOf(DirectorAuthError);
    await expect(store.authenticate(`${session.tokenId}.`)).rejects.toBeInstanceOf(DirectorAuthError);
    const wrong = `${session.tokenId}.${"0".repeat(64)}`;
    const error = await store.authenticate(wrong).catch((e: Error) => e);
    expect(error).toBeInstanceOf(DirectorAuthError);
    expect((error as Error).message).not.toContain("0".repeat(64));
    expect((error as Error).message).not.toContain(secret);
  });

  it("uses private modes and rejects an unsafe existing directory", async () => {
    const { store, dir } = await fresh();
    await reg(store);
    await store.appendMessage({ author: "user", channel: "cli", text: "hi" });
    await store.upsertIssue({ runId: "run-1", kind: "other", summary: "s" });
    expect(await mode(dir)).toBe(0o700);
    for (const name of ["session.json", "token.json", "transcript.jsonl", "issues.json"]) {
      expect(await mode(path.join(dir, name))).toBe(0o600);
    }
    const bad = path.join(path.dirname(dir), "bad");
    await fs.mkdir(bad, { mode: 0o755 });
    await fs.chmod(bad, 0o755);
    const unsafe = new DirectorStore({ directory: bad, now });
    await expect(unsafe.presence()).rejects.toThrow("Unsafe director state directory");
  });

  it("derives presence", async () => {
    const { store } = await fresh();
    expect((await store.presence()).presence).toBe("absent");
    const { token } = await reg(store);
    expect((await store.presence()).presence).toBe("active");
    await store.heartbeat(token, true);
    expect((await store.presence()).presence).toBe("waiting");
    clock = new Date(clock.getTime() + 120001);
    expect((await store.presence()).presence).toBe("absent");
    await store.heartbeat(token, false);
    expect((await store.presence()).presence).toBe("active");
    await store.revoke();
    expect((await store.presence()).presence).toBe("absent");
    await store.revoke();
  });

  it("serializes concurrent appends", async () => {
    const { store } = await fresh();
    const out = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendMessage({ author: "user", channel: "web", text: `m${i}` }))
    );
    expect(out.map(m => m.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const page = await store.readMessages({ afterSeq: 15 });
    expect(page.map(m => m.seq)).toEqual([16, 17, 18, 19, 20]);
  });

  it("tolerates a partial last line and rejects a corrupt middle line", async () => {
    const { store, dir } = await fresh();
    await store.appendMessage({ author: "user", channel: "cli", text: "a" });
    await store.appendMessage({ author: "director", channel: "cli", text: "b" });
    const file = path.join(dir, "transcript.jsonl");
    await fs.appendFile(file, '{"schemaVersion":1,"seq":3');
    expect((await store.readMessages({ afterSeq: 0 })).map(m => m.seq)).toEqual([1, 2]);
    expect((await store.appendMessage({ author: "user", channel: "cli", text: "c" })).seq).toBe(3);
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    lines[1] = "{garbage";
    await fs.writeFile(file, lines.join("\n"));
    await expect(store.readMessages({ afterSeq: 0 })).rejects.toThrow("Corrupt director transcript at line 2");
  });

  it("upserts and updates issues", async () => {
    const { store } = await fresh();
    const created = await store.upsertIssue({ issueId: "iss-1", runId: "run-1", kind: "other", summary: "one" });
    await store.setIssueStatus("iss-1", "retrying");
    clock = new Date(clock.getTime() + 5000);
    const updated = await store.upsertIssue({ issueId: "iss-1", runId: "run-1", kind: "environment", summary: "two", attempts: 2 });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.status).toBe("retrying");
    expect(updated.summary).toBe("two");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect((await store.version()).issuesRevision).toBe(3);
    await expect(store.setIssueStatus("nope", "resolved")).rejects.toThrow("Unknown director issue nope");
  });

  it("caps the issue queue at 500", async () => {
    const { store } = await fresh();
    for (let i = 0; i < 500; i += 1) {
      await store.upsertIssue({ issueId: `i-${String(i).padStart(3, "0")}`, runId: "run-1", kind: "other", summary: "s" });
    }
    await expect(store.upsertIssue({ runId: "run-1", kind: "other", summary: "extra" })).rejects.toThrow("Director issue queue is full");
    expect((await store.listIssues()).length).toBe(500);
    clock = new Date(clock.getTime() + 1000);
    await store.setIssueStatus("i-007", "resolved");
    clock = new Date(clock.getTime() + 1000);
    await store.setIssueStatus("i-003", "dismissed");
    await store.upsertIssue({ issueId: "extra", runId: "run-1", kind: "other", summary: "extra" });
    const ids = (await store.listIssues()).map(i => i.issueId);
    expect(ids.length).toBe(500);
    expect(ids).toContain("extra");
    expect(ids).not.toContain("i-007");
    expect(ids).toContain("i-003");
  }, 60000);

  it("waits for changes", async () => {
    const { store } = await fresh();
    const since = await store.version();
    const pending = store.waitForChange(since, 2000);
    await new Promise(r => setTimeout(r, 10));
    await store.appendMessage({ author: "user", channel: "cli", text: "x" });
    expect(await pending).toBe(true);
    const current = await store.version();
    expect(await store.waitForChange(current, 50)).toBe(false);
    const ac = new AbortController();
    const aborted = store.waitForChange(current, 5000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect(await aborted).toBe(false);
    expect(await store.waitForChange(since, 50)).toBe(true);
  });
});
