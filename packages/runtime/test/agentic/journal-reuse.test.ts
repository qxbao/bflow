import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal } from "../../src/agentic/journal.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bflow-journal-reuse-")); roots.push(root);
  const directory = join(root, "journal"), repository = join(root, "repo"), journal = new AgenticJournal(directory, repository);
  await journal.exclusive(async (_state, save) => { await save(); });
  return { journal, path: join(directory, "state.json") };
}
describe("validated journal snapshot reuse", () => {
  it("does not replace durable bytes for a no-op save, including repeated saves in the same transaction", async () => {
    const { journal, path } = await fixture(), before = await stat(path), bytes = await readFile(path, "utf8");
    await journal.exclusive(async (_state, save) => { await save(); await save(); });
    const after = await stat(path);
    expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });
  it("never exposes mutable callback state through a later cached read", async () => {
    const { journal } = await fixture();
    await expect(journal.exclusive(async state => { state.version = 999 as never; throw Error("aborted mutation"); })).rejects.toThrow("aborted mutation");
    expect(await journal.exclusive(async state => state.version)).toBe(1);
  });
  it("revalidates changed external bytes and never falls back to a cache after malformed or unsupported input", async () => {
    const { journal, path } = await fixture(), bytes = await readFile(path, "utf8");
    await writeFile(path, JSON.stringify({ ...JSON.parse(bytes), version: 999 }));
    await expect(journal.exclusive(async state => state.version)).rejects.toThrow(/journal/i);
    await expect(journal.exclusive(async state => state.version)).rejects.toThrow(/journal/i);
    await writeFile(path, "{malformed");
    await expect(journal.exclusive(async state => state.version)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ ...JSON.parse(bytes), version: 2 }));
    expect(await journal.exclusive(async state => state.version)).toBe(2);
  });
  it("does not let lossy JSON serialization hide an invalid mutation during a purported no-op save", async () => {
    const { journal, path } = await fixture(), before = await readFile(path, "utf8");
    await expect(journal.exclusive(async (state, save) => {
      (state as unknown as { repository: unknown }).repository = new String(state.repository);
      expect(JSON.stringify(state)).toBe(before); await save();
    })).rejects.toThrow(/journal/i);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await journal.exclusive(async state => typeof state.repository)).toBe("string");
  });
  it("recreates unchanged state if its durable file disappears before save, rather than acknowledging a missing commit", async () => {
    const { journal, path } = await fixture();
    await journal.exclusive(async (_state, save) => { await unlink(path); await save(); });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

});
