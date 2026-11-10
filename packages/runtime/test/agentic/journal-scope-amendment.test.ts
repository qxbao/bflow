import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal, parseAgenticJournalState } from "../../src/agentic/journal.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const amendment = { amendmentId: "1".repeat(64), at: "2026-11-09T00:00:00.000Z", source: "coordinator", reason: "drop files never written",
  fromSpecVersion: 1, toSpecVersion: 2, fromSpecDigest: "2".repeat(64), toSpecDigest: "3".repeat(64),
  fromStrategyDigest: "4".repeat(64), toStrategyDigest: "5".repeat(64),
  diff: { droppedAffectedPaths: ["test/live.test.ts"], addedAffectedPaths: [], ownedPathsBefore: ["src", "test"], ownedPathsAfter: ["src", "test"], testNamesChanged: [] } };
const fixture = async () => JSON.parse(await readFile(join(import.meta.dirname, "../fixtures/journal-v7-real.json"), "utf8"));
async function withAmendment(version: 9 | 10) {
  const value = await fixture(); value.version = version;
  value.runs[0].tasks[0].scopeAmendments = [{ ...amendment }];
  return value;
}

describe("private journal v10 scope amendments", () => {
  it("rejects amendments in v9 and keeps valid ones in v10", async () => {
    const old = await withAmendment(9);
    expect(() => parseAgenticJournalState(old, old.repository)).toThrow("private journal v10");
    const next = await withAmendment(10);
    expect(parseAgenticJournalState(next, next.repository).runs[0]!.tasks[0]!.scopeAmendments).toEqual([amendment]);
  });
  it("rejects malformed digests and oversized path lists", async () => {
    for (const patch of [{ fromSpecDigest: "bad" }, { toStrategyDigest: "x" }, { amendmentId: "z" },
      { diff: { ...amendment.diff, droppedAffectedPaths: Array.from({ length: 51 }, (_, i) => `t/${i}`) } }, { extra: true }]) {
      const value = await withAmendment(10);
      (value.runs[0]!.tasks[0] as any).scopeAmendments = [{ ...amendment, ...patch }];
      expect(() => parseAgenticJournalState(value, value.repository)).toThrow();
    }
  });
  it("keeps v9 without amendments at v9 and upgrades amendment writes to v10", async () => {
    const state = await fixture(); state.version = 9;
    const root = await mkdtemp(join(tmpdir(), "bflow-journal-scope-")); roots.push(root);
    const directory = join(root, "journal"); await mkdir(directory);
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    const journal = new AgenticJournal(directory, state.repository);
    await journal.exclusive(async (loaded, save) => { loaded.runs[0]!.error = "touched"; await save(); });
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).version).toBe(9);
    await journal.exclusive(async (loaded, save) => { (loaded.runs[0]!.tasks[0] as any).scopeAmendments = [{ ...amendment }]; await save(); });
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(saved.version).toBe(10);
    expect(saved.runs[0].tasks[0].scopeAmendments).toEqual([amendment]);
  });
});
