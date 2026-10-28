import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanups, fixture } from "../../../packages/runtime/test/helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const binary = resolve("apps/cli/dist/bin.js");

/** A real completed P19 run whose journal and ArtifactStore are placed where the binary finds private Runtime state. */
async function completedRepository() {
  const f = await fixture();
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
  await f.approve();
  const agentic = join(f.repository, ".bflow/state/agentic");
  await mkdir(join(agentic, "journal"), { recursive: true, mode: 0o700 });
  await chmod(join(agentic, "journal"), 0o700);
  const journal = join(agentic, "journal", "state.json");
  await writeFile(journal, await readFile(join(f.root, "journal", "state.json")), { mode: 0o600 });
  await cp(join(f.root, "artifacts"), join(agentic, "artifacts"), { recursive: true });
  await chmod(join(agentic, "artifacts"), 0o700);
  const run = (args: string[]) => spawnSync(process.execPath, [binary, ...args], { cwd: f.repository, encoding: "utf8",
    env: { ...process.env, HOME: join(f.root, "home"), BFLOW_HOME: join(f.root, "machine"), NO_COLOR: "1" } });
  const json = (args: string[]) => { const result = run([...args, "--json"]); return { status: result.status, envelope: JSON.parse(result.stdout), stderr: result.stderr }; };
  return { f, journal, run, json, revision: (await f.inspect()).workflowChange.headCommitHash as string };
}

describe.skipIf(process.platform === "win32")("bflow handover (built binary)", () => {
  it("inspects, exports, reuses and verifies an eligible offline package without touching Runtime state", async () => {
    const { f, journal, run, json, revision } = await completedRepository();
    const before = await readFile(journal);
    const inspected = json(["handover", "inspect", "--run", "run-1"]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const data = inspected.envelope.result.output.data;
    expect(data).toMatchObject({ runId: "run-1", status: "eligible", integratedRevision: revision });

    expect(run(["handover", "export", "--run", "run-1", "--out", "pkg"]).status).toBe(2);
    const wrong = json(["handover", "export", "--run", "run-1", "--revision", "0".repeat(40), "--out", "pkg"]);
    expect(wrong.status).toBe(6);
    await expect(stat(join(f.repository, "pkg"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(json(["handover", "export", "--run", "missing", "--snapshot", data.snapshotId, "--out", "pkg"]).status).toBe(4);

    const out = join(f.root, "pkg");
    const exported = json(["handover", "export", "--run", "run-1", "--revision", revision, "--snapshot", data.snapshotId, "--out", out]);
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.envelope.result.output).toMatchObject({ command: "handover.export", outcome: "ready", data: { outcome: "published", status: "eligible" } });
    expect((await readdir(out)).sort()).toEqual(["handover.json", "handover.md", "index.html", "manifest.json"]);
    const again = json(["handover", "export", "--run", "run-1", "--revision", revision, "--out", out]);
    expect(again.status).toBe(0);
    expect(again.envelope.result.output.data.outcome).toBe("reused");

    const verified = json(["handover", "verify", "--package", out]);
    expect(verified.status).toBe(0);
    expect(verified.envelope.result.output).toMatchObject({ outcome: "passed", data: { valid: true, status: "eligible" } });
    const text = run(["handover", "verify", "--package", out]);
    expect(text.stdout).toContain("Handover status: eligible");
    await writeFile(join(out, "handover.md"), "tampered\n");
    const tampered = json(["handover", "verify", "--package", out]);
    expect(tampered.status).toBe(3);
    expect(tampered.envelope.result.output.data.problems).toContain("Hash mismatch for handover.md");

    const mdOnly = json(["handover", "export", "--run", "run-1", "--revision", revision, "--format", "md", "--out", join(f.root, "md-only")]);
    expect(mdOnly.status).toBe(0);
    expect((await readdir(join(f.root, "md-only"))).sort()).toEqual(["handover.json", "handover.md", "manifest.json"]);
    expect(json(["handover", "verify", "--package", join(f.root, "md-only")]).status).toBe(0);
    const withEvidence = json(["handover", "export", "--run", "run-1", "--revision", revision, "--include-evidence", "--out", join(f.root, "evidence-pkg")]);
    expect(withEvidence.status, withEvidence.stderr).toBe(0);
    expect(withEvidence.envelope.result.output.data.files.some((path: string) => /^evidence\/[a-f0-9]{64}\.txt$/.test(path))).toBe(true);
    expect(json(["handover", "verify", "--package", join(f.root, "evidence-pkg")]).status).toBe(0);
    expect(await readFile(journal)).toEqual(before);
  }, 120_000);

  it("publishes an incomplete run only as a draft that exits NOT_READY, then replaces it on request", async () => {
    const { f, journal, json, revision } = await completedRepository();
    const original = await readFile(journal);
    const state = JSON.parse(original.toString("utf8"));
    state.runs[0].status = "awaiting_approval"; delete state.runs[0].decision;
    await writeFile(journal, JSON.stringify(state), { mode: 0o600 });
    const inspected = json(["handover", "inspect", "--run", "run-1"]).envelope.result.output.data;
    expect(inspected.status).toBe("draft");
    const out = join(f.root, "draft");
    const exported = json(["handover", "export", "--run", "run-1", "--snapshot", inspected.snapshotId, "--out", out]);
    expect(exported.status).toBe(3);
    expect(exported.envelope.result.output).toMatchObject({ outcome: "not_ready", data: { status: "draft" } });
    expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).status).toBe("draft");
    const verified = json(["handover", "verify", "--package", out]);
    expect(verified.status).toBe(3);
    expect(verified.envelope.result.output).toMatchObject({ outcome: "not_passed", data: { valid: true, status: "draft" } });

    await writeFile(journal, original, { mode: 0o600 });
    const conflict = json(["handover", "export", "--run", "run-1", "--revision", revision, "--out", out]);
    expect(conflict.status).toBe(6);
    expect(JSON.stringify(conflict.envelope)).toMatch(/another snapshot.*--replace/);
    const replaced = json(["handover", "export", "--run", "run-1", "--revision", revision, "--replace", "--out", out]);
    expect(replaced.status, replaced.stderr).toBe(0);
    expect(replaced.envelope.result.output.data).toMatchObject({ outcome: "replaced", status: "eligible" });
    expect(json(["handover", "verify", "--package", out]).status).toBe(0);
  }, 120_000);
});
