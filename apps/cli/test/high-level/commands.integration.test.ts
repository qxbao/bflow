import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionResultSchema } from "@bflow/contracts";
import { CommandJournal, HighLevelEnvelopeSchema, runCli } from "../../src/index.js";
import { newCommandIdentity } from "../../src/high-level/envelope.js";
import {
  approvedSpecification,
  bflow,
  captureIo,
  createRepository,
  draftSpecification,
  git,
  hasFlock,
  IndependentGate,
  openStore,
  output,
  RecordingGitPort,
  resolver,
  RUN_ID,
  services,
  storedChangeSet,
  TASK_ID,
  tempDir,
  verificationPlanInput,
  writeJson
} from "./fixtures.js";

async function preparedRepository(port?: RecordingGitPort) {
  const root = createRepository();
  const spec = await approvedSpecification(root);
  const specPath = writeJson(tempDir("bflow-hl-in-"), "spec.json", spec);
  const git = port ?? new RecordingGitPort(root);
  return { root, spec, specPath, git, svc: await services({ git }) };
}

describe("bflow help and argument contract", () => {
  it("prints help for every command, group and the global listing", async () => {
    for (const argv of [["repo", "inspect", "--help"], ["task", "plan", "-h"], ["help", "task", "implement"], ["verify", "--help"],
      ["git", "prepare", "--help"], ["mcp", "status", "--help"], ["tool", "status", "--help"], ["skills", "sync", "--help"],
      ["agent", "check", "--help"], ["task", "--help"]]) {
      const io = captureIo();
      const result = await runCli(argv, { io });
      expect(result.exitCode, argv.join(" ")).toBe(0);
      expect(io.out.join("\n")).toContain("Usage: bflow");
      expect(io.out.join("\n")).toContain("Exit codes:");
    }
    const io = captureIo();
    await runCli(["--help"], { io });
    expect(io.out.join("\n")).toContain("task implement <id>");
    const json = captureIo();
    expect((await runCli(["verify", "--help", "--json"], { io: json })).exitCode).toBe(0);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ ok: true, command: "help" });
  });

  it("rejects invalid arguments with exit code 2 and a validated envelope", async () => {
    const svc = await services();
    const missing = await bflow(process.cwd(), svc, "task", "implement", "t1");
    expect(missing.exitCode).toBe(2);
    expect(missing.result.error?.message).toContain("--run");
    const badProvider = await bflow(process.cwd(), svc, "agent", "check", "gpt");
    expect(badProvider.exitCode).toBe(2);
    const io = captureIo();
    const unknown = await runCli(["task", "deploy", "--json"], { io });
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse(io.err[0]!)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("leaves legacy commands untouched", async () => {
    const io = captureIo();
    const result = await runCli(["version", "--json"], { io });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(io.out[0]!)).toMatchObject({ ok: true, command: "version" });
  });
});

describe("bflow repo inspect", () => {
  it("reports repository, Git and project context without writing", async () => {
    const root = createRepository();
    writeFileSync(join(root, "AGENTS.md"), "# rules\n");
    const before = git(root, "status", "--porcelain");
    const envelope = await bflow(root, await services(), "repo", "inspect", "--correlation-id", "corr-inspect");
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.correlationId).toBe("corr-inspect");
    const data = output(envelope).data;
    expect(data.git.branch).toBe("main");
    expect(data.git.dirty).toBe(true);
    expect(data.git.changes).toEqual([{ status: "??", path: "AGENTS.md" }]);
    expect(data.project.markers).toContain("node");
    expect(data.project.packageManager).toBe("pnpm@12.5.1");
    expect(data.project.contextFiles).toContain("AGENTS.md");
    expect(git(root, "status", "--porcelain")).toBe(before);
  });

  it("returns not found outside a repository", async () => {
    const envelope = await bflow(tempDir("bflow-hl-norepo-"), await services(), "repo", "inspect");
    expect(envelope.exitCode).toBe(4);
    expect(envelope.result.status).toBe("failed");
    expect(envelope.result.error?.code).toBe("not_found");
  });
});

describe("bflow task plan", () => {
  it("previews, writes, re-runs idempotently and protects existing plans", async () => {
    const root = createRepository();
    const specPath = writeJson(root, "spec.json", draftSpecification());
    const svc = await services();
    const preview = await bflow(root, svc, "task", "plan", "--spec", specPath);
    expect(preview.exitCode).toBe(0);
    expect(output(preview).outcome).toBe("preview");
    expect(output(preview).data.graph.tasks).toEqual([{ id: TASK_ID, role: "developer", dependsOn: [] }]);
    expect(existsSync(join(root, ".bflow/plans"))).toBe(false);

    const written = await bflow(root, svc, "task", "plan", "--spec", specPath, "--write");
    expect(output(written).data).toMatchObject({ written: true, path: ".bflow/plans/spec-1.workflow.json" });
    const again = await bflow(root, svc, "task", "plan", "--spec", specPath, "--write");
    expect(again.exitCode).toBe(0);
    expect(output(again).replayed).toBe(true);
    expect(output(again).steps[0]!.id).toBe("idempotent-replay");

    const planPath = join(root, ".bflow/plans/spec-1.workflow.json");
    writeFileSync(planPath, "{}\n");
    const changed = await bflow(root, svc, "task", "plan", "--spec", specPath, "--write", "--idempotency-key", "plan-2");
    expect(changed.exitCode).toBe(5);
    expect(changed.result.error?.details).toMatchObject({ reason: "permission_required", permission: "--force" });
    const forced = await bflow(root, svc, "task", "plan", "--spec", specPath, "--write", "--force", "--idempotency-key", "plan-3");
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(planPath, "utf8")).id).toBe("spec-spec-1");
  });

  it("checks an existing workflow and reports traceability gaps as not ready", async () => {
    const root = createRepository();
    const specPath = writeJson(root, "spec.json", draftSpecification());
    const svc = await services();
    await bflow(root, svc, "task", "plan", "--spec", specPath, "--write");
    const planPath = join(root, ".bflow/plans/spec-1.workflow.json");
    const valid = await bflow(root, svc, "task", "plan", "--spec", specPath, "--workflow", planPath);
    expect(valid.exitCode).toBe(0);
    expect(output(valid).data.valid).toBe(true);
    const workflow = JSON.parse(readFileSync(planPath, "utf8"));
    workflow.tasks.push({ ...workflow.tasks[0], id: "orphan" });
    const invalidPath = writeJson(root, "orphan.json", workflow);
    const invalid = await bflow(root, svc, "task", "plan", "--spec", specPath, "--workflow", invalidPath);
    expect(invalid.exitCode).toBe(3);
    expect(output(invalid).data.traceability.unmappedWorkflowTaskIds).toEqual(["orphan"]);
  });

  it("fails on missing or invalid specifications", async () => {
    const root = createRepository();
    const svc = await services();
    expect((await bflow(root, svc, "task", "plan", "--spec", "nope.json")).exitCode).toBe(4);
    const invalid = await bflow(root, svc, "task", "plan", "--spec", writeJson(root, "bad.json", { schemaVersion: 2 }));
    expect(invalid.exitCode).toBe(1);
    expect(invalid.result.error?.details).toMatchObject({ reason: "invalid_specification" });
    expect(output(invalid).steps).toEqual([expect.objectContaining({ id: "load-specification", status: "failed" })]);
  });
});

describe("bflow task implement", () => {
  it("prepares worktree, specification context, TDD policy and assignment request", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    const envelope = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.result.runId).toBe(RUN_ID);
    const out = output(envelope);
    expect(out.ids).toMatchObject({ runId: RUN_ID, taskId: TASK_ID, idempotencyKey: `task.implement:${RUN_ID}:${TASK_ID}:attempt-1` });
    expect(out.steps.map(s => s.id)).toEqual(["load-specification", "check-approval", "check-run-binding", "resolve-task",
      "resolve-tdd-policy", "build-context", "open-resources", "verify-specification-artifact", "prepare-worktree",
      "prepare-assignment", "observe-execution"]);
    const assignment = out.data.assignment;
    expect(assignment).toMatchObject({ status: "awaiting_runtime_dispatch", role: "developer", runId: RUN_ID, taskId: TASK_ID });
    expect(assignment.tdd.mode).toBe("required");
    expect(assignment.tdd.requiresFailingTestFirst).toBe(true);
    expect(assignment.acceptanceCriteria.map((c: { id: string }) => c.id)).toEqual(["ac-1", "ac-2"]);
    expect(out.steps.at(-1)!.data).toMatchObject({ git: { status: "active" }, runtime: { observed: false } });
    expect(port.calls).toEqual(["prepare:implement"]);
  });

  it("replays a completed preparation without repeating the worktree side effect", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    const first = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    const second = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(second.exitCode).toBe(0);
    expect(output(second).replayed).toBe(true);
    expect(output(second).data.taskKey).toBe(output(first).data.taskKey);
    expect(second.result.commandId).not.toBe(first.result.commandId);
    expect(port.calls).toEqual(["prepare:implement"]);
  });

  it("reports Runtime task state when a Runtime is available", async () => {
    const { root, specPath, svc } = await preparedRepository();
    const runtime = { getRun: async () => ({ ok: true, value: { runId: RUN_ID, status: "running",
      tasks: [{ taskId: TASK_ID, status: "running", attempt: 1, generation: 0 }] } }) } as never;
    const io = captureIo();
    await runCli(["task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath, "--json"], { cwd: root, io, highLevelServices: svc, runtime });
    const envelope = HighLevelEnvelopeSchema.parse(JSON.parse(io.out[0]!));
    expect(output(envelope).steps.at(-1)!.data).toMatchObject({ runtime: { observed: true, runStatus: "running", taskStatus: "running" } });
  });

  it("returns not found for a task the specification does not trace", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    const envelope = await bflow(root, svc, "task", "implement", "ghost", "--run", RUN_ID, "--spec", specPath);
    expect(envelope.exitCode).toBe(4);
    expect(envelope.result.error?.details).toMatchObject({ reason: "task_not_found", knownTasks: [TASK_ID] });
    expect(port.calls).toEqual([]);
  });

  it("blocks unapproved specifications and run mismatches before any side effect", async () => {
    const root = createRepository();
    const port = new RecordingGitPort(root);
    const svc = await services({ git: port });
    const draft = writeJson(root, "draft.json", draftSpecification());
    const blocked = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", draft);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.result.error?.details).toMatchObject({ reason: "specification_not_approved" });
    const approved = writeJson(tempDir("bflow-hl-in-"), "spec.json", await approvedSpecification(root));
    const mismatch = await bflow(root, svc, "task", "implement", TASK_ID, "--run", "run-other", "--spec", approved);
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.result.error?.details).toMatchObject({ reason: "run_mismatch" });
    expect(port.calls).toEqual([]);
  });

  it("fails closed when the approved specification differs from its stored artifact", async () => {
    const root = createRepository();
    const spec = await approvedSpecification(root);
    const tampered = writeJson(tempDir("bflow-hl-in-"), "spec.json", { ...spec, summary: "Tampered after approval" });
    const port = new RecordingGitPort(root);
    const envelope = await bflow(root, await services({ git: port }), "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", tampered);
    expect(envelope.exitCode).toBe(1);
    expect(output(envelope).steps.at(-1)).toMatchObject({ id: "verify-specification-artifact", status: "failed" });
    expect(port.calls).toEqual([]);
  });

  it("fails at a middle step, records progress and succeeds on retry", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    port.failPrepare = new Error("Git working tree has uncommitted changes");
    const failed = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(failed.exitCode).toBe(1);
    expect(failed.result.status).toBe("failed");
    const steps = output(failed).steps;
    expect(steps.filter(s => s.status === "succeeded").map(s => s.id)).toContain("verify-specification-artifact");
    expect(steps.at(-1)).toMatchObject({ id: "prepare-worktree", status: "failed", message: "Git working tree has uncommitted changes" });
    port.failPrepare = undefined;
    const retried = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(retried.exitCode).toBe(0);
    expect(output(retried).replayed).toBe(false);
  });

  it("refuses to repeat an interrupted preparation until --resume reconciles it", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    // Simulate a crash after the worktree intent was recorded: a dangling receipt and a dead owner's lock.
    const journal = await CommandJournal.open(join(root, ".bflow/state/cli/commands"));
    const request = JSON.parse(JSON.stringify({ runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", developerId: "developer-1",
      base: "HEAD", ownedPaths: ["src/math/average.ts"], forbiddenPaths: [],
      specDigest: (await import("../../src/high-level/journal.js")).requestDigest(JSON.parse(readFileSync(specPath, "utf8"))) }));
    const begin = await journal.begin({ key: `task.implement:${RUN_ID}:${TASK_ID}:attempt-1`, command: "task.implement", request,
      identity: newCommandIdentity(), retrySafe: false, resume: false, now: () => new Date().toISOString() });
    if (begin.kind !== "execute") throw new Error("expected execute");
    await begin.attempt.progress([{ id: "prepare-worktree", status: "blocked", message: "in progress" }]);
    const dir = join(root, ".bflow/state/cli/commands");
    const lock = readdirSync(dir).find(name => name.endsWith(".lock"))!;
    writeFileSync(join(dir, lock), JSON.stringify({ pid: 2 ** 22 + 4242, host: hostname(), token: "dead", acquiredAt: new Date().toISOString() }));

    const unknown = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(unknown.exitCode).toBe(7);
    expect(unknown.result.status).toBe("unknown");
    expect(unknown.result.error?.code).toBe("unknown_delivery");
    expect(port.calls).toEqual([]);

    const resumed = await bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath, "--resume");
    expect(resumed.exitCode).toBe(0);
    expect(output(resumed).steps.map(s => s.id)).toContain("resume");
    expect(port.calls).toEqual(["prepare:implement"]);
  });

  it("serializes concurrent invocations of the same task and allows distinct tasks", async () => {
    const { root, specPath, git: port, svc } = await preparedRepository();
    port.prepareDelayMs = 300;
    const results = await Promise.all([1, 2, 3].map(() => bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath)));
    const codes = results.map(r => r.exitCode).sort();
    expect(codes[0]).toBe(0);
    expect(codes.filter(code => code === 6).length + codes.filter(code => code === 0).length).toBe(3);
    for (const conflict of results.filter(r => r.exitCode === 6))
      expect(conflict.result.error).toMatchObject({ code: "conflict", details: { reason: "busy" } });
    expect(port.calls.filter(call => call === "prepare:implement")).toHaveLength(1);
    const attempts = await Promise.all(["attempt-2", "attempt-3"].map(attempt =>
      bflow(root, svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath, "--attempt", attempt)));
    expect(attempts.map(r => r.exitCode)).toEqual([0, 0]);
  });

  it.skipIf(!hasFlock)("creates a real task worktree through the P18 Git engine", async () => {
    const root = createRepository();
    const spec = await approvedSpecification(root);
    const specPath = writeJson(tempDir("bflow-hl-in-"), "spec.json", spec);
    const envelope = await bflow(root, await services(), "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", specPath);
    expect(envelope.exitCode).toBe(0);
    expect(existsSync(output(envelope).data.worktreePath)).toBe(true);
    expect(git(root, "branch", "--list", output(envelope).data.branchName)).toContain(output(envelope).data.branchName);
  });
});

describe("bflow verify", () => {
  async function setup(gates?: IndependentGate[]) {
    const root = createRepository();
    const store = await openStore(root);
    const spec = await approvedSpecification(root, store);
    const strategy = resolver.resolve(spec);
    const input = verificationPlanInput(spec, strategy);
    const dir = tempDir("bflow-hl-verify-");
    const planPath = writeJson(dir, "plan.json", input);
    const change = await storedChangeSet(store);
    store.close();
    const changePath = writeJson(dir, "change.json", change);
    const runners = gates ?? input.checks.map(check => new IndependentGate(check.id));
    return { root, planPath, changePath, runners, svc: await services({ gates: runners }) };
  }

  it("runs every planned check and returns a passed VerificationResult with evidence", async () => {
    const { root, planPath, changePath, runners, svc } = await setup();
    const envelope = await bflow(root, svc, "verify", TASK_ID, "--run", RUN_ID, "--plan", planPath, "--change-set", changePath);
    expect(envelope.exitCode, JSON.stringify(output(envelope).data?.verification?.findings ?? envelope.result.error)).toBe(0);
    expect(output(envelope).outcome).toBe("passed");
    expect(output(envelope).data.verification.status).toBe("passed");
    expect(envelope.result.artifacts.length).toBeGreaterThan(0);
    expect(runners.every(r => r.calls.length === 1)).toBe(true);
    expect(CommandExecutionResultSchema.safeParse(envelope.result).success).toBe(true);
    // The same change replays its receipt instead of re-running the checks.
    const again = await bflow(root, svc, "verify", TASK_ID, "--run", RUN_ID, "--plan", planPath, "--change-set", changePath);
    expect(output(again).replayed).toBe(true);
    expect(runners.every(r => r.calls.length === 1)).toBe(true);
  });

  it("reports a failing check as not passed with rework required", async () => {
    const { root, planPath, changePath, runners, svc } = await setup();
    runners[0]!.mode = "failed";
    const envelope = await bflow(root, svc, "verify", TASK_ID, "--run", RUN_ID, "--plan", planPath, "--change-set", changePath);
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).data.verification.status).toBe("failed");
    expect(output(envelope).data.cycle.status).toBe("rework_required");
  });

  it("is blocked, never passed, without independent runners", async () => {
    const { root, planPath, changePath } = await setup();
    const envelope = await bflow(root, await services({ gates: [] }), "verify", TASK_ID, "--run", RUN_ID, "--plan", planPath, "--change-set", changePath);
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).data.verification.status).toBe("blocked");
  });

  it("returns not found for a task without a plan or prepared worktree", async () => {
    const { root, planPath, svc } = await setup();
    expect((await bflow(root, svc, "verify", "other-task", "--run", RUN_ID, "--plan", planPath)).exitCode).toBe(4);
    const missingChange = await bflow(root, svc, "verify", TASK_ID, "--run", RUN_ID, "--plan", planPath);
    expect(missingChange.exitCode).toBe(4);
    expect(output(missingChange).steps.at(-1)).toMatchObject({ id: "collect-change-set", status: "failed" });
  });
});

describe("bflow git prepare", () => {
  async function implemented() {
    const ctx = await preparedRepository();
    await bflow(ctx.root, ctx.svc, "task", "implement", TASK_ID, "--run", RUN_ID, "--spec", ctx.specPath);
    const task = [...ctx.git.tasks.values()][0]!;
    git(ctx.root, "worktree", "add", "-q", "--detach", join(ctx.root, ".bflow/state/wt"));
    task.worktreePath = join(ctx.root, ".bflow/state/wt");
    writeFileSync(join(task.worktreePath, "src/math/average.ts"), "export const average = (xs: number[]) => xs.length ? 1 : 0;\n");
    git(task.worktreePath, "commit", "-qam", "fix");
    const store = await openStore(ctx.root);
    ctx.git.changeSet = await storedChangeSet(store);
    store.close();
    return ctx;
  }

  it("requires --yes before collecting submissions or creating the integration branch", async () => {
    const { root, svc, git: port } = await implemented();
    const envelope = await bflow(root, svc, "git", "prepare", RUN_ID);
    expect(envelope.exitCode).toBe(5);
    expect(envelope.result.status).toBe("waiting_user");
    expect(output(envelope).outcome).toBe("approval_required");
    expect(output(envelope).data.tasks[0]).toMatchObject({ taskId: TASK_ID, clean: true, commitCount: 1, ready: true });
    expect(port.calls).toEqual(["prepare:implement"]);
  });

  it("prepares the integration branch and requests workflow-level verification", async () => {
    const { root, svc, git: port } = await implemented();
    const envelope = await bflow(root, svc, "git", "prepare", RUN_ID, "--yes");
    expect(envelope.exitCode).toBe(0);
    expect(output(envelope).outcome).toBe("integration_prepared");
    expect(output(envelope).data.workflowVerification).toMatchObject({ required: true, requestIds: ["git-msg-1"] });
    expect(output(envelope).data.integration.branchName).toMatch(/^integration\/bflow\//);
    expect(port.calls).toEqual(["prepare:implement", expect.stringMatching(/^collect:/), "integrate:integration-1"]);
    const again = await bflow(root, svc, "git", "prepare", RUN_ID, "--yes");
    expect(output(again).replayed).toBe(true);
    expect(port.calls.filter(c => c.startsWith("integrate:"))).toHaveLength(1);
  });

  it("detects merge conflicts as not ready", async () => {
    const { root, svc, git: port } = await implemented();
    port.conflict = true;
    const envelope = await bflow(root, svc, "git", "prepare", RUN_ID, "--yes");
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).outcome).toBe("conflict_detected");
    expect(output(envelope).data.integration.conflict).toMatchObject({ paths: ["src/math/average.ts"] });
  });

  it("rejects uncommitted worktrees and runs without prepared tasks", async () => {
    const { root, svc, git: port } = await implemented();
    writeFileSync(join([...port.tasks.values()][0]!.worktreePath, "src/math/average.ts"), "dirty\n");
    const dirty = await bflow(root, svc, "git", "prepare", RUN_ID, "--yes");
    expect(dirty.exitCode).toBe(3);
    expect(dirty.result.error?.details).toMatchObject({ reason: "worktree_not_ready" });
    expect((await bflow(root, svc, "git", "prepare", "run-unknown")).exitCode).toBe(4);
  });
});

describe("bflow tool status", () => {
  it("reports present and missing tools with remediation and readiness exit codes", async () => {
    const bin = tempDir("bflow-hl-bin-");
    for (const name of ["node", "pnpm", "git", "herdr"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    const base = await (await services()).machine.platform();
    const platform = { ...base, pathEntries: [bin], homeDir: tempDir("bflow-hl-home-"),
      paths: { ...base.paths, managedBin: join(bin, "managed") } };
    const ready = await services({ platform, runnerVersions: { node: "v22.20.0", pnpm: "12.5.1", git: "git version 2.50.1", herdr: "herdr 0.9.5" } });
    const ok = await bflow(process.cwd(), ready, "tool", "status", "--tool", "git", "--tool", "node");
    expect(ok.exitCode).toBe(0);
    expect(output(ok).data.tools.map((t: { toolId: string }) => t.toolId)).toEqual(["node", "git"]);
    const old = await services({ platform, runnerVersions: { node: "v18.0.0", pnpm: "12.5.1", git: "git version 2.50.1", herdr: "herdr 0.9.5" } });
    const notReady = await bflow(process.cwd(), old, "tool", "status");
    expect(notReady.exitCode).toBe(3);
    expect(output(notReady).data.blocking).toEqual(["node"]);
    const node = output(notReady).data.tools.find((t: { toolId: string }) => t.toolId === "node");
    expect(node).toMatchObject({ status: "version_mismatch", healthy: false });
    expect(node.remediation).toBeTruthy();
    expect((await bflow(process.cwd(), ready, "tool", "status", "--tool", "docker")).exitCode).toBe(4);
  });
});

describe("bflow mcp status", () => {
  async function platformWithConfig(config: unknown) {
    const base = await (await services()).machine.platform();
    const configDir = tempDir("bflow-hl-xdg-");
    if (config !== undefined) writeFileSync(join(configDir, "mcp.json"), JSON.stringify(config));
    return { ...base, paths: { ...base.paths, config: configDir } };
  }
  const service = (machineId: string) => ({
    schemaVersion: 3, serviceId: "docs", revision: 1, scope: { kind: "machine", machineId },
    tool: { schemaVersion: 3, toolId: "docs", kind: "native_remote_mcp", version: "1.0.0", operations: ["search"],
      resource: { sharing: "concurrent", maxConcurrency: 4 }, required: false },
    connection: { kind: "native_remote_mcp", endpoint: "https://mcp.example.com/mcp", ownership: "external" },
    authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 1000, restartLimit: 1
  });

  it("is not ready without a configured Gateway", async () => {
    const envelope = await bflow(process.cwd(), await services({ platform: await platformWithConfig(undefined) }), "mcp", "status");
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).data.gateway).toMatchObject({ configured: false, reachable: false });
    expect(output(envelope).data.config.state).toBe("absent");
  });

  it("combines Gateway backend health with configured services", async () => {
    const base = await (await services()).machine.platform();
    const def = service(base.machineId);
    expect((await import("@bflow/contracts")).MCPServiceDefinitionSchema.safeParse(def).success).toBe(true);
    const platform = await platformWithConfig({ schemaVersion: 3, services: { docs: def }, managedIds: ["docs"] });
    const healthy = await services({ platform, mcpGateway: { status: async () => ({ reachable: true, version: "1",
      backends: [{ serviceId: "docs", state: "healthy" }] }) } });
    const ok = await bflow(process.cwd(), healthy, "mcp", "status");
    expect(ok.exitCode).toBe(0);
    expect(output(ok).data.backends).toEqual([expect.objectContaining({ serviceId: "docs", healthy: true })]);
    expect((await bflow(process.cwd(), healthy, "mcp", "status", "--service", "missing")).exitCode).toBe(4);
    const degraded = await services({ platform, mcpGateway: { status: async () => ({ reachable: true,
      backends: [{ serviceId: "docs", state: "degraded", detail: "slow" }] }) } });
    const notReady = await bflow(process.cwd(), degraded, "mcp", "status");
    expect(notReady.exitCode).toBe(3);
    expect(output(notReady).data.backends[0]).toMatchObject({ state: "degraded", gateway: "slow" });
  });

  it("reports an invalid configuration file as not ready", async () => {
    const envelope = await bflow(process.cwd(), await services({ platform: await platformWithConfig({ schemaVersion: 2 }) }), "mcp", "status");
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).data.config.state).toBe("invalid");
  });
});

describe("bflow skills sync", () => {
  function synchronizer(options: { machineWide?: boolean; failSync?: boolean } = {}) {
    let digest: string | null = null;
    const calls: string[] = [];
    return {
      calls,
      setSynced: () => { digest = "desired-digest"; },
      factory: (providers: readonly string[]) => ({
        async observe() { calls.push("observe"); return { stateDigest: digest, valid: true, diagnostics: [] }; },
        async desired() { return { digest: "desired-digest", summary: `skills for ${providers.join(",")}`,
          targets: providers.map(p => `/skills/${p}`), machineWide: options.machineWide ?? false, repairNeeded: false }; },
        async sync() { calls.push("sync"); if (options.failSync) throw new Error("disk full"); digest = "desired-digest";
          return { ownedPaths: providers.map(p => `/skills/${p}`), diagnostics: [] }; }
      })
    };
  }

  it("fails clearly when no skill manager is integrated", async () => {
    const envelope = await bflow(createRepository(), await services(), "skills", "sync");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.result.error?.details).toMatchObject({ reason: "skills_synchronizer_not_configured" });
  });

  it("syncs, then is idempotent and performs no further writes", async () => {
    const root = createRepository();
    const sync = synchronizer();
    const svc = await services({ skills: sync.factory });
    const dry = await bflow(root, svc, "skills", "sync", "--provider", "claude", "--dry-run");
    expect(output(dry).outcome).toBe("preview");
    expect(sync.calls).not.toContain("sync");
    const first = await bflow(root, svc, "skills", "sync", "--provider", "claude", "--provider", "codex");
    expect(first.exitCode).toBe(0);
    expect(output(first).outcome).toBe("synced");
    expect(output(first).data.ownedPaths).toEqual(["/skills/claude", "/skills/codex"]);
    const second = await bflow(root, svc, "skills", "sync", "--provider", "codex", "--provider", "claude");
    expect(output(second).outcome).toBe("already_synced");
    expect(sync.calls.filter(c => c === "sync")).toHaveLength(1);
  });

  it("requires explicit permission for machine-wide targets", async () => {
    const root = createRepository();
    const sync = synchronizer({ machineWide: true });
    const svc = await services({ skills: sync.factory });
    const blocked = await bflow(root, svc, "skills", "sync");
    expect(blocked.exitCode).toBe(5);
    expect(blocked.result.status).toBe("waiting_user");
    expect(sync.calls).not.toContain("sync");
    expect((await bflow(root, svc, "skills", "sync", "--allow-machine-scope")).exitCode).toBe(0);
  });

  it("reports a sync that does not converge as failed", async () => {
    const root = createRepository();
    const sync = synchronizer({ failSync: true });
    const envelope = await bflow(root, await services({ skills: sync.factory }), "skills", "sync");
    expect(envelope.exitCode).toBe(1);
    expect(envelope.result.error?.details).toMatchObject({ reason: "sync_not_converged" });
  });
});

describe("bflow agent check", () => {
  const health = (status: "ready" | "blocked") => ({
    async checkHealth(request: { environment: { environmentId: string; provider: string; role: string; configFingerprint: string } }) {
      const now = Date.now();
      return { ok: true as const, value: {
        schemaVersion: 3 as const, environmentId: request.environment.environmentId, provider: request.environment.provider as "claude",
        role: request.environment.role as "developer", configFingerprint: request.environment.configFingerprint, stage: "preflight" as const,
        status, checkedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
        checks: ["binary", "version", "authentication", "environment", "mcp", "launch_arguments", "permissions", "skills"].map(check => ({
          check: check as "binary", status: status === "ready" || check !== "authentication" ? "passed" as const : "failed" as const,
          code: `${check}_checked`, message: `${check} checked`,
          ...(status === "blocked" && check === "authentication" ? { remediation: "Run the provider login flow manually" } : {}) }))
      } };
    }
  });

  it("returns ready and not-ready preflight results through the provider port", async () => {
    const root = createRepository();
    const ready = await bflow(root, await services({ providerHealth: health("ready") as never }), "agent", "check", "claude");
    expect(ready.exitCode).toBe(0);
    expect(output(ready).data).toMatchObject({ provider: "claude", status: "ready", stage: "preflight" });
    const blocked = await bflow(root, await services({ providerHealth: health("blocked") as never }), "agent", "check", "codex", "--role", "reviewer");
    expect(blocked.exitCode).toBe(3);
    expect(output(blocked).data.checks.find((c: { check: string }) => c.check === "authentication").remediation).toContain("login");
  });

  it("exercises the real P25 adapter with a missing executable", async () => {
    const root = createRepository();
    const { createDefaultProviderRegistry } = await import("@bflow/agent-providers");
    const registry = createDefaultProviderRegistry({ agy: { executablePath: join(tempDir("bflow-hl-noexe-"), "agy") } });
    const envelope = await bflow(root, await services({ providerHealth: registry }), "agent", "check", "agy");
    expect(envelope.exitCode).toBe(3);
    expect(output(envelope).data.ready).toBe(false);
    expect(output(envelope).data.checks.find((c: { check: string }) => c.check === "binary").status).not.toBe("passed");
  });
});

describe("JSON contract", () => {
  it("every command emits a CommandExecutionResult-valid envelope", async () => {
    const root = createRepository();
    const svc = await services();
    const envelopes = [
      await bflow(root, svc, "repo", "inspect"),
      await bflow(root, svc, "task", "plan", "--spec", writeJson(root, "s.json", draftSpecification())),
      await bflow(root, svc, "task", "implement", "x", "--run", "r", "--spec", "missing.json"),
      await bflow(root, svc, "verify", "x", "--run", "r", "--plan", "missing.json"),
      await bflow(root, svc, "git", "prepare", "r"),
      await bflow(root, svc, "mcp", "status"),
      await bflow(root, svc, "tool", "status", "--tool", "git"),
      await bflow(root, svc, "skills", "sync"),
      await bflow(root, svc, "agent", "check", "claude", "--mode", "workspace_auto")
    ];
    for (const envelope of envelopes) {
      expect(CommandExecutionResultSchema.safeParse(envelope.result).success).toBe(true);
      expect(envelope.result.commandId).toMatch(/^cmd-/);
      expect(envelope.result.correlationId).toMatch(/^corr-/);
      expect(envelope.ok).toBe(envelope.exitCode === 0);
    }
    expect(new Set(envelopes.map(e => e.command)).size).toBe(9);
  }, 60_000);
});

describe("compiled bflow binary", () => {
  const bin = join(import.meta.dirname, "../../dist/bin.js");
  const run = (cwd: string, ...argv: string[]) => spawnSync(process.execPath, [bin, ...argv], { cwd, encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });

  it("returns reliable process exit codes and a parseable JSON envelope on stdout", () => {
    const usage = run(process.cwd(), "task", "implement", "t1", "--json");
    expect(usage.status).toBe(2);
    expect(HighLevelEnvelopeSchema.parse(JSON.parse(usage.stdout)).exitCode).toBe(2);
    const outside = run(tempDir("bflow-hl-bin-cwd-"), "repo", "inspect", "--json");
    expect(outside.status).toBe(4);
    expect(JSON.parse(outside.stdout).result.error.code).toBe("not_found");
    const root = createRepository();
    const inspect = run(root, "--json", "repo", "inspect", "--correlation-id", "corr-bin");
    expect(inspect.status).toBe(0);
    expect(JSON.parse(inspect.stdout).result.correlationId).toBe("corr-bin");
    const human = run(root, "repo", "inspect");
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("bflow repo inspect: inspected");
  });
});
