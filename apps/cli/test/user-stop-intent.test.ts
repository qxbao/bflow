import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearUserStopIntent, readUserStopIntent, writeUserStopIntent } from "../src/user-stop-intent.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bflow-stop-intent-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const file = () => join(root, ".bflow", "state", "user-stop.json");
const intent = { version: 1 as const, repositoryId: "repo-1", sessionName: "sess-1", source: "web" as const, operationId: "op-1", requestedAt: "2026-11-09T10:00:00.000Z" };

describe("user stop intent", () => {
  it("is absent before any write", async () => {
    expect(await readUserStopIntent(root, "repo-1", "sess-1")).toBeUndefined();
  });
  it("writes, reads and clears with mode 0600", async () => {
    await writeUserStopIntent(root, intent);
    expect(await readUserStopIntent(root, "repo-1", "sess-1")).toEqual(intent);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    await clearUserStopIntent(root);
    expect(await readUserStopIntent(root, "repo-1", "sess-1")).toBeUndefined();
    await clearUserStopIntent(root);
  });
  it("throws on a corrupt file instead of treating it as absent", async () => {
    await mkdir(join(root, ".bflow", "state"), { recursive: true });
    await writeFile(file(), "{not json");
    await expect(readUserStopIntent(root, "repo-1", "sess-1")).rejects.toThrow();
    await writeFile(file(), JSON.stringify({ ...intent, extra: 1 }));
    await expect(readUserStopIntent(root, "repo-1", "sess-1")).rejects.toThrow();
    await writeFile(file(), "x".repeat(5000));
    await expect(readUserStopIntent(root, "repo-1", "sess-1")).rejects.toThrow();
  });
  it("treats an intent of another repository or session as absent", async () => {
    await writeUserStopIntent(root, intent);
    expect(await readUserStopIntent(root, "repo-2", "sess-1")).toBeUndefined();
    expect(await readUserStopIntent(root, "repo-1", "sess-2")).toBeUndefined();
  });
  it("rejects a symlink", async () => {
    await mkdir(join(root, ".bflow", "state"), { recursive: true });
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(intent));
    await symlink(target, file());
    await expect(readUserStopIntent(root, "repo-1", "sess-1")).rejects.toThrow();
    expect(JSON.parse(await readFile(target, "utf8")).source).toBe("web");
  });
  it("rejects an invalid intent on write", async () => {
    await expect(writeUserStopIntent(root, { ...intent, sessionName: "bad name!" })).rejects.toThrow();
  });
});
