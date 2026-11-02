import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AnalysisWorkflowRuntime, buildAnalysisPack } from "../src/index.js";
import { nativeExtensionFixture } from "./helpers/native-extension.js";

interface DelayedWrite { path: string; status: string; ready(): void; wait: Promise<void>; used: boolean }
const writes = vi.hoisted(() => ({ delayed: undefined as DelayedWrite | undefined }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: string, to: string) => {
    const gate = writes.delayed;
    if (gate && !gate.used && to === gate.path) {
      const journal = JSON.parse(await fs.readFile(from, "utf8"));
      if (journal.runs.length === 1 && journal.runs[0].status === gate.status) {
        gate.used = true; gate.ready(); await gate.wait;
      }
    }
    return fs.rename(from, to);
  } };
});

describe.each(["analysis", "qa"] as const)("%s native SDK durable writes", family => {
  it("cannot overwrite a newer run with a delayed earlier approval snapshot", async () => {
    const f = await nativeExtensionFixture(family), { sdk } = await f.open(); await f.start(sdk);
    const before = JSON.parse(await readFile(f.journalPath, "utf8"));
    let ready!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { ready = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    writes.delayed = { path: f.journalPath, status: family === "analysis" ? "awaiting_business_decision" : "awaiting_design_approval",
      ready, wait, used: false };
    let releaseDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = sdk.drive("run-native");
      await paused;
      const intake = { ...before.runs[0].intake, requestId: "second-request" };
      const pack = buildAnalysisPack({ id: "native-ba", version: "1" });
      const second = sdk instanceof AnalysisWorkflowRuntime ? sdk.start({ runId: "run-second", intake, pack,
        packPin: { id: pack.id, version: pack.version, digest: pack.digest } })
        : sdk.start({ runId: "run-second", intake });
      // A queued writer cannot overtake the first rename. Release after the later start completes if it overtakes;
      // otherwise the deadline only releases the fault injection so a correctly serialized writer can proceed.
      void second.then(release, release);
      releaseDeadline = setTimeout(release, 1000);
      await Promise.all([first, second]);
      const persisted = JSON.parse(await readFile(f.journalPath, "utf8"));
      expect(persisted.runs.map((run: { runId: string }) => run.runId).sort()).toEqual(["run-native", "run-second"]);
      const recovered = await f.open(); expect(recovered.sdk.status("run-second")).toMatchObject({ runId: "run-second", status: "running" });
      expect(recovered.sdk.status("run-native").status).toBe(family === "analysis" ? "awaiting_business_decision" : "awaiting_design_approval");
    } finally { if (releaseDeadline) clearTimeout(releaseDeadline); release(); writes.delayed = undefined; }
  });
});
