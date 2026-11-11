import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgenticJournal, parseAgenticJournalState } from "../../src/agentic/journal.js";
import { run, state as fixtureState } from "../interaction/fixtures.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function phaseState() {
  const state = fixtureState([run()]);
  state.version = 8;
  state.outbound.push({
    message: { schema_version: 2, message_id: "phase-1", correlation_id: "corr-1", run_id: "run-1",
      sender: { role: "runtime" }, recipient: { role: "tester" }, type: "verification.requested",
      payload: { kind: "conditional_evidence", taskId: "implement", phase: "red", sourceRevision: "a".repeat(40) }, artifact_references: [] },
    status: "released", selector: "tester", taskId: "implement", attemptId: "attempt-1", capabilities: [],
    phaseFailure: { summary: "missing declared test", repairable: false, applied: true }
  });
  return state;
}
const blocker = { code: "declared_test_missing", fixableBy: "director", fingerprint: "1".repeat(64),
  specDigest: "2".repeat(64), strategyDigest: "3".repeat(64), sourceRevision: "a".repeat(40), details: { paths: ["test/missing.test.ts"] } } as const;

describe("private journal v9 blocker", () => {
  it("rejects a blocker in v8 and preserves a valid blocker in v9", () => {
    const old = phaseState(); old.outbound[0]!.phaseFailure!.blocker = { ...blocker };
    expect(() => parseAgenticJournalState(old, old.repository)).toThrow("Invalid private policy failure outcome");
    const next = structuredClone(old); next.version = 9;
    expect(parseAgenticJournalState(next, next.repository).outbound[0]!.phaseFailure!.blocker).toEqual(blocker);
  });

  it("preserves v8 without blockers and upgrades blocker writes to v9", async () => {
    const state = phaseState();
    const root = await mkdtemp(join(tmpdir(), "bflow-journal-blocker-")); roots.push(root);
    const directory = join(root, "journal"); await mkdir(directory);
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    const journal = new AgenticJournal(directory, state.repository);
    await journal.exclusive(async (loaded, save) => { loaded.outbound[0]!.error = "touched"; await save(); });
    expect(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).version).toBe(8);
    await journal.exclusive(async (loaded, save) => { loaded.outbound[0]!.phaseFailure!.blocker = { ...blocker }; await save(); });
    const saved = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    expect(saved.version).toBe(9);
    expect(saved.outbound[0].phaseFailure.blocker).toEqual(blocker);
  });

  it("rejects a blocker whose fixableBy disagrees with the registry", () => {
    const value = phaseState(); value.version = 9;
    value.outbound[0]!.phaseFailure!.blocker = { ...blocker, fixableBy: "runtime" };
    expect(() => parseAgenticJournalState(value, value.repository)).toThrow("Invalid private policy failure outcome");
  });
  it("rejects malformed digests, revisions and oversized blocker paths", () => {
    for (const patch of [
      { fingerprint: "bad" }, { specDigest: "bad" }, { strategyDigest: "bad" }, { sourceRevision: "bad" },
      { details: { paths: Array.from({ length: 51 }, (_, i) => `test/${i}.ts`) } },
      { details: { paths: ["a".repeat(1025)] } },
      { details: { paths: [null] } }
    ]) {
      const value = phaseState(); value.version = 9;
      value.outbound[0]!.phaseFailure!.blocker = { ...blocker, ...patch } as any;
      expect(() => parseAgenticJournalState(value, value.repository), JSON.stringify(patch).slice(0, 70))
        .toThrow("Invalid private policy failure outcome");
    }
  });
  it("requires v9 for a parked plan_mismatch episode, including history", async () => {
    const raw = JSON.parse(await readFile(join(import.meta.dirname, "../fixtures/journal-v7-real.json"), "utf8"));
    raw.version = 8;
    const park = { at: "2026-11-09T00:00:00Z", reason: "Missing committed test", kind: "plan_mismatch", source: "auto", episode: 1 };
    raw.runs[0].tasks[0].parked = park;
    expect(() => parseAgenticJournalState(structuredClone(raw), raw.repository)).toThrow();
    raw.version = 9;
    expect(parseAgenticJournalState(structuredClone(raw), raw.repository).runs[0]!.tasks[0]!.parked?.kind).toBe("plan_mismatch");
    delete raw.runs[0].tasks[0].parked;
    raw.runs[0].tasks[0].parkHistory = [park];
    expect(parseAgenticJournalState(structuredClone(raw), raw.repository).runs[0]!.tasks[0]!.parkHistory?.[0]?.kind).toBe("plan_mismatch");
  });
});
