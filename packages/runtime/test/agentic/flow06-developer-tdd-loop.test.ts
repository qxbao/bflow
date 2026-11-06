import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { ArtifactWriteOptionsSchema, type PaneBinding, type Specification } from "@bflow/contracts";
import { prepareDependencyBaseWorktree } from "../../src/agentic/dependency-base.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { unmeasuredPolicyPhaseRequests } from "../../src/agentic/phase-recovery.js";
import { PolicyReviewPageInputSchema } from "../../src/agentic/policy-review-pages.js";
import { loadAgenticPolicies } from "../../src/agentic/ports.js";
import { automaticTestPaths, resolveTaskCommands, TestRunnerSource } from "../../src/agentic/task-commands.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { handleTaskLogTool } from "../../src/agentic/task-log-tools.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { createNativeAdapters } from "../../src/agentic/runner-adapters/native.js";
import { cleanups, fixture, git } from "../helpers/agentic-integration-fixture.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const tempRoots: string[] = [];

afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* ignore cleanup races under heavy parallel load */ }
  }
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("Flow 06 — Developer TDD Red/Green handshake, polyglot paths, rework & handover hardening", () => {
  it("Vector 1A: renews Developer writer lease on repairable Red rejection, blocks same-revision retry, accepts repaired commit rev2, and completes Red -> Authorize -> Green -> Refactor -> Submit", async () => {
    const f = await fixture({ tdd: true });
    f.spec.traceabilityTaskIds = ["implement"];
    f.def.tasks = [f.def.tasks[0]!];
    f.def.dependencies = [];
    f.ports.roleCapabilities.qa = ["verification", "testing", "repository.read"];
    f.ports.preflightRoleCapabilities = async () => {};

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    let state = (await f.runtime.inspect()) as any;
    const assignment = state.outbound.find((out: any) => out.message.type === "task.assignment");
    expect(assignment?.status).toBe("accepted");
    const devBinding = f.panes.bindings.find(item => item.paneId === assignment.handle.target.paneId)!;
    const worktreePath = assignment.handle.target.worktreePath as string;

    // Developer commits initial defective Red test at rev1.
    await writeFile(join(worktreePath, "guide.md"), "defective-red-attempt\n");
    git(worktreePath, "add", "guide.md");
    git(worktreePath, "commit", "-m", "red attempt 1");
    const rev1 = git(worktreePath, "rev-parse", "HEAD");

    const queued1 = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", rev1)) as any;
    expect(queued1.queued).toBe(true);
    await f.runtime.flushOutbound();

    state = (await f.runtime.inspect()) as any;
    const req1 = state.outbound.find((out: any) => out.message.message_id === queued1.messageId);
    const qaBinding = f.panes.bindings.find(item => item.paneId === req1.handle.target.paneId)!;
    const leaseBefore = state.outbound.find((out: any) => out.message.message_id === assignment.message.message_id).lease;

    // QA records a repairable Red failure (e.g., syntax error or passing test instead of failing assertion).
    const failureBytes = Buffer.from(JSON.stringify({ runId: "run-1", taskId: "implement",
      attemptId: req1.message.payload.implementationAttemptId, sourceRevision: rev1, phase: "red",
      observation: { revision: rev1 }, criteria: [{ criterionId: f.spec.acceptanceCriteria[0]!.id, passed: false,
        summary: "Failed mapped test without a missing-behavior assertion" }], accepted: false }));
    const failureArtifactId = `flow06-red-failure-${rev1.slice(0, 12)}`;
    const failureEvidence = (await f.ports.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId: failureArtifactId, runId: "run-1",
      taskId: "implement", kind: "test-result", mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(failureBytes).digest("hex") }, sizeBytes: failureBytes.length },
      idempotencyKey: failureArtifactId }), content: (async function* () { yield failureBytes; })() }));
    if (!failureEvidence.ok) throw new Error(`Could not store mapped Red failure evidence: ${failureEvidence.error.message}`);
    const failureReply = (await f.runtime.recordPhaseFailure(
      qaBinding,
      queued1.messageId,
      "Red test exited 0 without failing assertion",
      true,
      failureEvidence.value
    )) as any;
    expect(failureReply.status).toBe("implementing");

    await f.runtime.flushOutbound();
    state = (await f.runtime.inspect()) as any;
    const assignmentAfter = state.outbound.find((out: any) => out.message.message_id === assignment.message.message_id);
    // Writer lease must be renewed in Registry & journal before phase-notice delivery.
    expect(assignmentAfter.lease.version).toBeGreaterThan(leaseBefore.version);

    const failNotice = state.outbound.find(
      (out: any) =>
        out.message.type === "task.status" &&
        out.message.payload?.kind === "policy_phase_outcome" &&
        out.message.payload?.outcomeId === queued1.messageId
    );
    expect(failNotice).toMatchObject({
      status: "accepted",
      parentAssignmentId: assignment.message.message_id,
      message: {
        recipient: { role: "developer", agent_id: devBinding.agentId, pane_id: devBinding.paneId },
        payload: { phase: "red", status: "failed" }
      }
    });

    // Retrying Red on the identical failed revision rev1 must be refused, and implementation remains locked.
    await expect(f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", rev1)).rejects.toThrow(
      /commit a repair/i
    );
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).rejects.toThrow(/Red/i);

    // Developer commits repaired Red test at rev2 and re-requests Red verification.
    await writeFile(join(worktreePath, "guide.md"), "repaired-red-attempt\n");
    git(worktreePath, "add", "guide.md");
    git(worktreePath, "commit", "-m", "red attempt 2");
    const rev2 = git(worktreePath, "rev-parse", "HEAD");
    expect(rev2).not.toBe(rev1);

    const queued2 = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", rev2)) as any;
    expect(queued2.queued).toBe(true);
    expect(queued2.messageId).not.toBe(queued1.messageId);

    // Complete Red -> Authorize -> Green -> Refactor -> Submit.
    await f.evidence("implement", "red");
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).resolves.toMatchObject({
      authorized: true
    });
    await f.evidence("implement", "green");
    await f.evidence("implement", "refactor");
    await f.submit("implement", "final-green-implementation\n");
    await f.runtime.tick();
    await f.runtime.tick();
    if ((await f.inspect()).status === "awaiting_approval") {
      await f.approve();
    }

    expect((await f.inspect()).tasks.find((t: any) => t.taskId === "implement").cycle.status).toBe("passed");
    expect((await f.inspect()).status).toBe("completed");
  }, 180_000);

  it("Vector 1B: wakes Coordinator and notifies Conversation on silent QA lease expiry / unmeasured phase request (including Rework Attempt 2+)", async () => {
    const f = await fixture({ tdd: true });
    f.spec.traceabilityTaskIds = ["implement"];
    f.def.tasks = [f.def.tasks[0]!];
    f.def.dependencies = [];
    f.ports.roleCapabilities.qa = ["verification", "testing", "repository.read"];
    f.ports.preflightRoleCapabilities = async () => {};

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    let state = (await f.runtime.inspect()) as any;
    const assignment = state.outbound.find((out: any) => out.message.type === "task.assignment");
    const devBinding = f.panes.bindings.find(item => item.paneId === assignment.handle.target.paneId)!;
    const worktreePath = assignment.handle.target.worktreePath as string;
    const rev1 = git(worktreePath, "rev-parse", "HEAD");

    const queued = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", rev1)) as any;
    await f.runtime.flushOutbound();

    // Simulate silent QA lease expiry in Registry + outbox release (without specialistTurnStopped or recordPhaseFailure).
    state = (await f.runtime.inspect()) as any;
    const qaOut = state.outbound.find((out: any) => out.message.message_id === queued.messageId);
    const released = await f.ports.registry.releaseLease({
      leaseId: qaOut.lease.leaseId,
      fencingToken: qaOut.lease.fencingToken,
      expectedVersion: qaOut.lease.version,
      releasedAt: new Date().toISOString(),
      idempotencyKey: `silent-expiry-${qaOut.lease.leaseId}`
    });
    expect(released.ok).toBe(true);
    const journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.runtimeOptions.repositoryPath);
    await journal.exclusive(async (journalState, save) => {
      const target = journalState.outbound.find(item => item.message.message_id === queued.messageId)!;
      target.status = "released";
      await save();
    });

    // Scheduler tick runs recoverPhaseFailures -> must set coordinator_continuation AND wake Coordinator + notify Conversation.
    await f.runtime.tick();
    const blockedRun = await f.inspect();
    expect(blockedRun.status).toBe("implementing");
    expect(blockedRun.pendingAction).toMatchObject({
      kind: "coordinator_continuation",
      owner: "coordinator",
      sourceMessageId: queued.messageId,
      state: "pending"
    });

    state = (await f.runtime.inspect()) as any;
    const coordWake = state.outbound.find(
      (out: any) =>
        out.message.recipient.role === "coordinator" &&
        out.message.payload?.kind === "unmeasured_policy_phase" &&
        out.message.causation_id === queued.messageId
    );
    expect(coordWake).toBeDefined();
    expect(coordWake.message.payload.actionId).toBe(blockedRun.pendingAction.actionId);

    const convBlocked = state.outbound.find(
      (out: any) =>
        out.message.recipient.role === "conversation" &&
        out.message.type === "conversation.progress" &&
        out.message.payload?.kind === "workflow_blocked" &&
        out.message.payload?.actionId === blockedRun.pendingAction.actionId
    );
    expect(convBlocked).toBeDefined();

    // Coordinator calls resume_run (even passing actionId: null via CoordinatorTools) -> Developer receives retry notice and re-requests Red on same rev1.
    const tools = new CoordinatorTools(f.runtime);
    await tools.invoke("resume_run", { runId: "run-1", actionId: null }, { role: "coordinator" });
    await f.runtime.flushOutbound();

    state = (await f.runtime.inspect()) as any;
    const retryNotice = state.outbound.find(
      (out: any) =>
        out.message.type === "task.status" &&
        out.message.payload?.kind === "policy_phase_outcome" &&
        out.message.payload?.phase === "red" &&
        out.message.payload?.status === "retry"
    );
    expect(retryNotice).toBeDefined();

    const retried = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", rev1)) as any;
    expect(retried.queued).toBe(true);
    expect(retried.messageId).not.toBe(queued.messageId);

    // Also verify unmeasuredPolicyPhaseRequests recognizes active Rework Attempt 2+ while ignoring retired Attempt 1.
    const syntheticState: any = {
      inbox: [],
      outbound: [
        {
          status: "released",
          taskId: "implement",
          attemptId: "attempt-1",
          handle: { attemptId: "attempt-1" },
          message: { run_id: "run-rework", message_id: "assign-1", type: "task.assignment", payload: {} }
        },
        {
          status: "released",
          message: {
            run_id: "run-rework",
            message_id: "phase-attempt-1",
            type: "verification.requested",
            occurred_at: "2026-10-31T00:00:01.000Z",
            payload: { kind: "conditional_evidence", taskId: "implement", phase: "red", implementationAttemptId: "attempt-1" }
          }
        },
        {
          status: "accepted",
          taskId: "implement",
          attemptId: "attempt-2",
          handle: { attemptId: "attempt-2" },
          message: { run_id: "run-rework", message_id: "assign-2", type: "task.assignment", payload: {} }
        },
        {
          status: "released",
          message: {
            run_id: "run-rework",
            message_id: "phase-attempt-2",
            type: "verification.requested",
            occurred_at: "2026-10-31T00:00:02.000Z",
            payload: { kind: "conditional_evidence", taskId: "implement", phase: "red", implementationAttemptId: "attempt-2" }
          }
        }
      ],
      runs: [
        {
          runId: "run-rework",
          tasks: [
            {
              taskId: "implement",
              verificationPending: false,
              cycle: { status: "rework_required", history: [{ verificationId: "v-1" }] },
              spec: { strategy: { tddDecision: { mode: "required" }, metadata: { tddEvidence: [] } } }
            }
          ]
        }
      ]
    };
    const reworkOrphans = unmeasuredPolicyPhaseRequests(syntheticState, syntheticState.runs[0]);
    expect(reworkOrphans.map(item => item.message.message_id)).toEqual(["phase-attempt-2"]);
  }, 180_000);

  it("Vector 1C & 3B: preserves frozen Red tests & pre-task base originalRevision on Rework Attempt 2+, authorizes implementation without a new Red failure, and isolates task handovers across rework generations & sibling tasks", async () => {
    const f = await fixture({ tdd: true, failReview: true, parallel: true });
    // Ensure panes carry native session tokens so taskHandover authenticates pane session ownership.
    const origAllocate = f.panes.allocateDeveloper.bind(f.panes);
    f.panes.allocateDeveloper = async req => {
      const res = await origAllocate(req);
      if (res.ok && !res.value.session) {
        res.value.session = { source: "test", kind: "id", value: `session-${req.agentName}` };
      }
      return res;
    };

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    const baseRevision = (await f.inspect()).baseRevision as string;
    let state = (await f.runtime.inspect()) as any;
    const attempt1Assign = state.outbound.find((out: any) => out.taskId === "implement" && out.message.type === "task.assignment");
    const siblingAssign = state.outbound.find((out: any) => out.taskId === "other" && out.message.type === "task.assignment");
    const dev1Binding = f.panes.bindings.find(item => item.paneId === attempt1Assign.handle.target.paneId)!;
    const siblingBinding = f.panes.bindings.find(item => item.paneId === siblingAssign.handle.target.paneId)!;
    const attempt1Worktree = attempt1Assign.handle.target.worktreePath as string;

    // Attempt 1 completes Red/Green/Refactor and proposes a task handover.
    await f.evidence("implement", "red");
    await f.evidence("implement", "green");
    await f.evidence("implement", "refactor");

    await writeFile(join(attempt1Worktree, "guide.md"), "attempt-1-candidate\n");
    git(attempt1Worktree, "add", "guide.md");
    git(attempt1Worktree, "commit", "-m", "attempt 1 implementation");

    const h1Before = (await f.runtime.taskHandover(dev1Binding, { runId: "run-1", taskId: "implement" })) as any;
    expect(h1Before.binding.reworkGeneration).toBe(0);
    const proposed1 = (await f.runtime.taskHandover(dev1Binding, {
      runId: "run-1",
      taskId: "implement",
      proposal: {
        schemaVersion: 1,
        binding: h1Before.binding,
        content: {
          nextAction: "Verify initial guide.md implementation",
          decisions: ["Used concise guide layout"],
          disprovedHypotheses: [],
          untestedAngles: [],
          references: []
        }
      }
    })) as any;
    expect(proposed1.handover.status).toBe("accepted");

    // Sibling task Developer pane ("other") cannot read or overwrite "implement"'s handover.
    await expect(f.runtime.taskHandover(siblingBinding, { runId: "run-1", taskId: "implement" })).resolves.toMatchObject({
      handover: { status: "absent", code: "handover_assignment_unavailable" }
    });
    await expect(
      f.runtime.taskHandover(siblingBinding, {
        runId: "run-1",
        taskId: "implement",
        proposal: {
          schemaVersion: 1,
          binding: h1Before.binding,
          content: { nextAction: "Cross-task spoof", decisions: [], disprovedHypotheses: [], untestedAngles: [], references: [] }
        }
      })
    ).rejects.toThrow(/assignment/i);

    // Submit Attempt 1 -> Reviewer fails -> task enters rework_required and dispatches Attempt 2.
    await f.submit("implement", null);
    await f.runtime.tick();
    await f.runtime.tick();

    const afterAttempt1 = await f.inspect();
    const implTask = afterAttempt1.tasks.find((t: any) => t.taskId === "implement");
    expect(implTask.cycle.status).toBe("rework_required");
    expect(implTask.worktrees).toHaveLength(2);
    expect(implTask.worktrees[0].baseCommitHash).toBe(baseRevision);
    expect(implTask.worktrees[1].baseCommitHash).not.toBe(baseRevision);

    state = (await f.runtime.inspect()) as any;
    const attempt2Assign = [...state.outbound]
      .reverse()
      .find((out: any) => out.taskId === "implement" && out.message.type === "task.assignment");
    expect(attempt2Assign.attemptId).not.toBe(attempt1Assign.attemptId);
    const dev2Binding = f.panes.bindings.find(item => item.paneId === attempt2Assign.handle.target.paneId)!;

    // Attempt 2: stale generation-0 handover is withheld with handover_generation_mismatch.
    const h2Before = (await f.runtime.taskHandover(dev2Binding, { runId: "run-1", taskId: "implement" })) as any;
    expect(h2Before.binding.reworkGeneration).toBe(1);
    expect(h2Before.handover).toMatchObject({
      status: "withheld",
      code: "handover_generation_mismatch"
    });

    // Attempt 2: authorize_implementation succeeds immediately without a new failing Red commit!
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).resolves.toMatchObject({
      authorized: true
    });

    // Wire HostDevelopment with a TestRunnerSource whose profile snapshot exists ONLY at baseRevision (worktrees[0].baseCommitHash).
    const runnerSource = new TestRunnerSource([], f.repository);
    const fakeProfile: RunnerProfile = {
      id: "unit",
      command: "test-regression",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      method: "integration_test",
      levels: ["integration", "regression"],
      reporter: "node_tap",
      timeoutMs: 5_000,
      checkoutDependencyRoots: [],
      dependencySource: f.repository,
      definitionBlobs: {},
      source: "detected"
    };
    (runnerSource as any).snapshots.set(baseRevision, [fakeProfile]);
    expect(runnerSource.profilesForRevision(implTask.worktrees[1].baseCommitHash)).toEqual([]);
    expect(runnerSource.profilesForRevision(implTask.worktrees[0].baseCommitHash)).toEqual([fakeProfile]);

    // Give Attempt 2 a configured Red test file ("guide.test.md") alongside "guide.md" to verify post-Red freeze vs production edits on Attempt 2.
    const devHost = new HostDevelopment(() => f.runtime, [
      {
        id: "owner-reg",
        command: "test-regression",
        executable: process.execPath,
        args: ["--test"],
        method: "integration_test",
        levels: ["integration", "regression"],
        testNames: ["ac-1: The requested outcome is independently verifiable"],
        testPaths: ["guide.test.md"],
        timeoutMs: 5_000
      }
    ]);
    const journal = new AgenticJournal(f.runtimeOptions.journalDirectory, f.runtimeOptions.repositoryPath);
    await journal.exclusive(async (journalState, save) => {
      const defTask = journalState.runs[0]!.definition!.tasks.find(t => t.id === "implement")!;
      (defTask as any).metadata = { ...defTask.metadata, ownedPaths: ["guide.md", "guide.test.md", "rework.spec.ts"] };
      await save();
    });

    // Frozen Red testPaths remain locked on Rework Attempt 2, while production source AND a brand-new post-Red regression test are writable!
    await expect(
      devHost.writeWorkspaceFile(dev2Binding, { path: "guide.test.md", content: "tamper\n", expectedSha256: null })
    ).rejects.toThrow(/frozen/i);

    const existingGuide = (await devHost.readWorkspaceFile(dev2Binding, { path: "guide.md" })) as any;
    await expect(
      devHost.writeWorkspaceFile(dev2Binding, {
        path: "guide.md",
        content: "attempt-2-repaired\n",
        expectedSha256: existingGuide.sha256
      })
    ).resolves.toMatchObject({ written: true });
    await expect(
      devHost.writeWorkspaceFile(dev2Binding, {
        path: "rework.spec.ts",
        content: "// brand-new regression test added in rework attempt 2\n",
        expectedSha256: null
      })
    ).resolves.toMatchObject({ written: true, created: true });

    const status2 = (await devHost.status(dev2Binding, {})) as any;
    const commit2 = (await devHost.commit(dev2Binding, {
      expectedHead: status2.head,
      message: "fix review finding on attempt 2"
    })) as any;
    expect(commit2.committed).toBe(true);

    // Attempt 2 proposes updated handover at reworkGeneration=1 and new HEAD revision, then reads it back cleanly.
    const h2Ready = (await f.runtime.taskHandover(dev2Binding, { runId: "run-1", taskId: "implement" })) as any;
    expect(h2Ready.binding).toMatchObject({ revision: commit2.head, reworkGeneration: 1 });
    const proposed2 = (await f.runtime.taskHandover(dev2Binding, {
      runId: "run-1",
      taskId: "implement",
      proposal: {
        schemaVersion: 1,
        binding: h2Ready.binding,
        content: {
          nextAction: "Submit Attempt 2 root-cause fix for review finding",
          decisions: ["Repaired guide.md and added rework.spec.ts"],
          disprovedHypotheses: [],
          untestedAngles: [],
          references: []
        }
      }
    })) as any;
    expect(proposed2.handover.status).toBe("accepted");
    const h2ReadBack = (await f.runtime.taskHandover(dev2Binding, { runId: "run-1", taskId: "implement" })) as any;
    expect(h2ReadBack.handover).toMatchObject({
      status: "selected",
      envelope: {
        binding: { reworkGeneration: 1, revision: commit2.head },
        content: { nextAction: "Submit Attempt 2 root-cause fix for review finding" }
      }
    });
  }, 180_000);

  it("Vector 1D (Polyglot Rust & Red-Phase Fixtures/Definitions): binds Rust integration & unit test paths without freezing src/lib.rs, allows Red fixtures/helpers, and blocks pre-Red definitionBlobs tampering", async () => {
    // 1. Rust polyglot automaticTestPaths & resolveTaskCommands
    const rustSandbox = await realpath(await mkdtemp(join(tmpdir(), "bflow-rust-paths-")));
    tempRoots.push(rustSandbox);
    const rustRepo = join(rustSandbox, "repo");
    const fakeToolchain = join(rustSandbox, "toolchain");
    await mkdir(rustRepo, { recursive: true });
    await mkdir(join(fakeToolchain, "bin"), { recursive: true });
    await mkdir(join(fakeToolchain, "lib"), { recursive: true });
    for (const binName of ["cargo", "rustc", "cc"]) {
      const binPath = join(fakeToolchain, "bin", binName);
      await writeFile(binPath, "#!/bin/sh\nexit 0\n");
      await chmod(binPath, 0o755);
    }
    await writeFile(join(rustRepo, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(rustRepo, "Cargo.lock"), "# lock\n");

    const adapters = createNativeAdapters({
      platform: "linux",
      home: rustSandbox,
      environment: { PATH: join(fakeToolchain, "bin") },
      findExecutable: async name => (["cargo", "rustc", "cc"].includes(name) ? join(fakeToolchain, "bin", name) : undefined),
      probe: async (file, args) => {
        if (file.endsWith("cargo") && args[0] === "--version") return "cargo 1.82.0";
        if (file.endsWith("rustc") && args[0] === "--version") return "rustc 1.82.0";
        if (file.endsWith("rustc") && args[0] === "-vV") return "rustc 1.82.0\nhost: x86_64-unknown-linux-gnu\n";
        return "";
      }
    });
    const detected = await adapters.find(item => item.id === "rust")!.detect({ root: rustRepo, files: ["Cargo.toml", "Cargo.lock"] });
    expect(detected.runners).toHaveLength(1);
    const rustAdapter = detected.runners[0]!;

    const makeProfile = (id: string, command: string, method: "unit_test" | "integration_test"): RunnerProfile => ({
      id,
      command,
      executable: rustAdapter.executable,
      args: [],
      method,
      levels: method === "integration_test" ? ["integration", "regression"] : ["unit", "regression"],
      reporter: "node_tap",
      timeoutMs: 30_000,
      adapter: rustAdapter,
      checkoutDependencyRoots: [],
      dependencySource: rustRepo,
      definitionBlobs: { "Cargo.toml": "a".repeat(40), "Cargo.lock": "b".repeat(40) },
      source: "detected"
    });
    const rustUnitProfile = makeProfile("rust-unit", "auto:unit", "unit_test");
    const rustIntProfile = makeProfile("rust-int", "auto:integration", "integration_test");

    const baseRustSpec = (affectedPaths: string[], method: "unit_test" | "integration_test"): Specification =>
      ({
        affectedPaths,
        acceptanceCriteria: [{ id: "ac-1", description: "Rust math works", verificationMethod: method, required: true, status: "pending" }]
      }) as unknown as Specification;

    // Cargo integration test ("src/lib.rs" + "tests/math.rs") -> selects ONLY ["tests/math.rs"] and binds cleanly!
    const intSpec = baseRustSpec(["src/lib.rs", "tests/math.rs"], "integration_test");
    expect(automaticTestPaths(rustIntProfile, intSpec)).toEqual(["tests/math.rs"]);
    const boundInt = resolveTaskCommands({
      owner: [],
      profiles: [rustUnitProfile, rustIntProfile],
      specification: intSpec,
      strategy: {
        targetCommands: ["auto:integration"],
        criterionMappings: [{ criterionId: "ac-1", testNames: ["adds_two"] }]
      } as any
    });
    expect(boundInt).toHaveLength(1);
    expect(boundInt[0]!.testPaths).toEqual(["tests/math.rs"]);
    expect(rustAdapter.bind(boundInt[0]!, "/tmp/out").args).toContain("--test");

    // Dedicated Rust unit test module ("src/lib.rs" + "src/tests.rs") -> selects ONLY ["src/tests.rs"] so src/lib.rs isn't frozen!
    const unitModuleSpec = baseRustSpec(["src/lib.rs", "src/tests.rs"], "unit_test");
    expect(automaticTestPaths(rustUnitProfile, unitModuleSpec)).toEqual(["src/tests.rs"]);

    // Inline single-file Rust unit test ("src/lib.rs") -> preserves ["src/lib.rs"].
    const inlineSpec = baseRustSpec(["src/lib.rs"], "unit_test");
    expect(automaticTestPaths(rustUnitProfile, inlineSpec)).toEqual(["src/lib.rs"]);

    // 2. HostDevelopment Red-phase fixtures/helpers vs definitionBlobs vs required/recommended/not_applicable guards
    const ws = await realpath(await mkdtemp(join(tmpdir(), "bflow-red-fixtures-")));
    tempRoots.push(ws);
    git(ws, "init", "-b", "main");
    git(ws, "config", "user.name", "Test");
    git(ws, "config", "user.email", "test@example.test");
    for (const dir of [
      "src/__fixtures__",
      "test/__fixtures__",
      "test/helpers",
      "tests/common",
      "pkg/testdata"
    ]) {
      await mkdir(join(ws, dir), { recursive: true });
    }
    await writeFile(join(ws, "package.json"), '{"name":"demo"}\n');
    await writeFile(join(ws, "src/math.ts"), "export const add = () => 0;\n");
    git(ws, "add", ".");
    git(ws, "commit", "-m", "baseline");
    const baseCommit = git(ws, "rev-parse", "HEAD");

    const pane: PaneBinding = {
      schemaVersion: 2,
      bindingId: "b-dev",
      sessionId: "s-1",
      role: "developer",
      paneGroup: "developer_worktree",
      agentId: "dev-1",
      workspaceId: "w-1",
      tabId: "t-1",
      paneId: "p-1",
      provider: "herdr",
      agentKind: "codex",
      cwd: ws,
      worktreePath: ws,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: false,
      permanent: false,
      transportState: "idle",
      boundAt: "2026-10-31T00:00:00.000Z"
    };

    let mode: "required" | "recommended" | "not_applicable" = "required";
    const tddEvidence: unknown[] = [];
    const fakeRuntime = {
      inspect: async () => ({
        outbound: [
          {
            status: "accepted",
            message: {
              schema_version: 2,
              message_id: "m-1",
              correlation_id: "c-1",
              run_id: "run-1",
              sender: { role: "coordinator" },
              recipient: { role: "developer", agent_id: "dev-1", pane_id: "p-1" },
              type: "task.assignment",
              payload: {},
              artifact_references: [],
              occurred_at: "2026-10-31T00:00:00.000Z",
              idempotency_key: "m-1"
            },
            handle: {
              executionId: "e-1",
              requestId: "r-1",
              attemptId: "a-1",
              runId: "run-1",
              taskId: "task-1",
              idempotencyKey: "m-1",
              target: { transport: "herdr", agentId: "dev-1", workspaceId: "w-1", tabId: "t-1", paneId: "p-1", worktreePath: ws },
              correlation: { token: "r-1", provenance: "orchestrator", verified: false },
              acceptedAt: "2026-10-31T00:00:00.000Z"
            }
          }
        ]
      }),
      withDeveloperWorkspace: async (_b: unknown, _r: string, _t: string, cb: (...args: any[]) => Promise<unknown>) =>
        cb(
          {
            worktrees: [{ baseCommitHash: baseCommit, branchName: "main" }],
            spec: {
              specification: { acceptanceCriteria: [] },
              strategy: {
                tddDecision: { mode },
                targetCommands: ["unit"],
                criterionMappings: [],
                metadata: { tddEvidence }
              }
            }
          },
          { metadata: { ownedPaths: ["src", "test", "tests", "pkg", "package.json"], forbiddenPaths: [] } }
        ),
      ports: {
        policies: {
          assertReadyToImplement: (strategy: any) => {
            if (strategy.tddDecision.mode === "required" && !strategy.metadata.tddEvidence.length) {
              throw new Error("Red evidence is required before implementation");
            }
          }
        }
      }
    };

    // Pass an already-parsed command list wrapped in a TestRunnerSource so definitionBlobs can be attached cleanly.
    const runnerSource = new TestRunnerSource([
      {
        id: "unit",
        command: "unit",
        executable: process.execPath,
        args: ["--test"],
        method: "unit_test",
        levels: ["unit"],
        testNames: ["adds"],
        testPaths: ["test/math.test.ts"],
        timeoutMs: 1_000,
        definitionBlobs: { "package.json": "c".repeat(40) }
      } as any
    ]);
    const hostDev = new HostDevelopment(() => fakeRuntime as never, runnerSource);

    // In recommended / not_applicable modes, implementation edits are permitted immediately without Red.
    for (const nonRequired of ["recommended", "not_applicable"] as const) {
      mode = nonRequired;
      const cur = (await hostDev.readWorkspaceFile(pane, { path: "src/math.ts" })) as any;
      await expect(
        hostDev.writeWorkspaceFile(pane, { path: "src/math.ts", content: `// ${nonRequired}\n`, expectedSha256: cur.sha256 })
      ).resolves.toMatchObject({ written: true });
    }

    // Restore src/math.ts to clean committed baseline before testing mode === "required" before Red.
    await writeFile(join(ws, "src/math.ts"), "export const add = () => 0;\n");
    mode = "required";
    const curMath = (await hostDev.readWorkspaceFile(pane, { path: "src/math.ts" })) as any;
    const curPkg = (await hostDev.readWorkspaceFile(pane, { path: "package.json" })) as any;

    // Production files, lookalike test/ınput.ts, AND definitionBlobs (package.json) MUST be blocked before Red!
    await expect(
      hostDev.writeWorkspaceFile(pane, { path: "src/math.ts", content: "export const add = () => 2;\n", expectedSha256: curMath.sha256 })
    ).rejects.toThrow(/Red evidence is required/);
    await expect(
      hostDev.writeWorkspaceFile(pane, { path: "test/ınput.ts", content: "sneaky\n", expectedSha256: null })
    ).rejects.toThrow(/Red evidence is required/);
    await expect(
      hostDev.writeWorkspaceFile(pane, { path: "package.json", content: '{"scripts":{"test":"true"}}\n', expectedSha256: curPkg.sha256 })
    ).rejects.toThrow(/Red evidence is required/);

    // Configured testPaths AND polyglot Red fixtures/helpers/companion test files ARE permitted before Red!
    for (const allowedBeforeRed of [
      "test/math.test.ts",
      "test/__fixtures__/sample.json",
      "src/__fixtures__/input.json",
      "test/helpers/mock.ts",
      "tests/common/mod.rs",
      "pkg/testdata/case.json",
      "test/extra.spec.tsx",
      "pkg/extra_test.go",
      "tests/test_extra.py"
    ]) {
      await expect(
        hostDev.writeWorkspaceFile(pane, { path: allowedBeforeRed, content: `// ${allowedBeforeRed}\n`, expectedSha256: null })
      ).resolves.toMatchObject({ written: true, created: true });
    }

    const headBeforeRed = git(ws, "rev-parse", "HEAD");
    const redCommit = (await hostDev.commit(pane, { expectedHead: headBeforeRed, message: "commit red tests and fixtures" })) as any;
    expect(redCommit.committed).toBe(true);

    // Record Red receipt pinned to redCommit.head -> Red tests, definitionBlobs, AND Red-committed fixtures are now frozen!
    tddEvidence.push({ metadata: { conditionalTdd: { phase: "red", sourceRevision: redCommit.head } } });

    const fixtureRead = (await hostDev.readWorkspaceFile(pane, { path: "test/__fixtures__/sample.json" })) as any;
    await expect(
      hostDev.writeWorkspaceFile(pane, {
        path: "test/__fixtures__/sample.json",
        content: '{"cheated":true}\n',
        expectedSha256: fixtureRead.sha256
      })
    ).rejects.toThrow(/frozen/i);
    await expect(
      hostDev.writeWorkspaceFile(pane, {
        path: "package.json",
        content: '{"name":"tampered"}\n',
        expectedSha256: curPkg.sha256
      })
    ).rejects.toThrow(/frozen/i);

    // Production source AND brand-new post-Red supplemental regression test files are allowed!
    await expect(
      hostDev.writeWorkspaceFile(pane, { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b;\n", expectedSha256: curMath.sha256 })
    ).resolves.toMatchObject({ written: true });
    await expect(
      hostDev.writeWorkspaceFile(pane, { path: "test/post-red-regression.spec.ts", content: "// added in rework\n", expectedSha256: null })
    ).resolves.toMatchObject({ written: true, created: true });
  });

  it("Vector 2: diffs dependent task-2 against its dependency-base commit so upstream task-1 files are importable without false-positive ownedPaths scope failures", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-dep-scope-")));
    tempRoots.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "test"), { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.test");
    await writeFile(join(repo, "src/a.ts"), "export const a = 0;\n");
    await writeFile(join(repo, "src/b.ts"), "export const b = 0;\n");
    await writeFile(join(repo, "test/.gitkeep"), "");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "baseline");
    const baseRevision = git(repo, "rev-parse", "HEAD");

    const artifactRes = await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "dep-test" });
    if (!artifactRes.ok) throw new Error(artifactRes.error.message);
    cleanups.push(async () => artifactRes.value.close());
    const policies = await loadAgenticPolicies({ repositoryPath: repo, artifactStore: artifactRes.value });
    const gitPolicy = policies.git;

    // Task 1 modifies src/a.ts (owned by task-1, NOT owned by task-2).
    const tree1 = await gitPolicy.prepareTask({
      runId: "run-dep",
      taskId: "task-1",
      attemptId: "att-1",
      baseRevision,
      ownedPaths: ["src/a.ts"],
      forbiddenPaths: [],
      developerId: "dev-1"
    });
    await writeFile(join(tree1.worktreePath, "src/a.ts"), "export const a = 21;\n");
    git(tree1.worktreePath, "add", "src/a.ts");
    git(tree1.worktreePath, "commit", "-m", "task-1 implements src/a.ts");
    const change1 = (await gitPolicy.collectTask(tree1.key)) as any;
    expect(change1.filesChanged.map((f: any) => f.path)).toEqual(["src/a.ts"]);

    // Task 2 depends on task-1 and owns ONLY ["src/b.ts", "test/b.test.ts"].
    const { tree: tree2 } = await prepareDependencyBaseWorktree(
      gitPolicy,
      {
        runId: "run-dep",
        taskId: "task-2",
        attemptId: "att-2",
        ownedPaths: ["src/b.ts", "test/b.test.ts"],
        forbiddenPaths: [],
        developerId: "dev-2"
      },
      {
        runBaseRevision: baseRevision,
        priorHead: undefined,
        dependencyHeads: [change1.headCommitHash]
      }
    );

    // Task 2 sees task-1's updated src/a.ts on disk, cannot edit src/a.ts, and commits src/b.ts + test/b.test.ts cleanly.
    expect(await readFile(join(tree2.worktreePath, "src/a.ts"), "utf8")).toBe("export const a = 21;\n");

    const pane2: PaneBinding = {
      schemaVersion: 2,
      bindingId: "b-2",
      sessionId: "s-dep",
      role: "developer",
      paneGroup: "developer_worktree",
      agentId: "dev-2",
      workspaceId: "w-1",
      tabId: "t-1",
      paneId: "p-2",
      provider: "herdr",
      agentKind: "claude",
      cwd: tree2.worktreePath,
      worktreePath: tree2.worktreePath,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: false,
      permanent: false,
      transportState: "idle",
      boundAt: "2026-10-31T00:00:00.000Z"
    };
    const depRuntime = {
      inspect: async () => ({
        outbound: [
          {
            status: "accepted",
            message: {
              schema_version: 2,
              message_id: "m-2",
              correlation_id: "c-dep",
              run_id: "run-dep",
              sender: { role: "coordinator" },
              recipient: { role: "developer", agent_id: "dev-2", pane_id: "p-2" },
              type: "task.assignment",
              payload: {},
              artifact_references: [],
              occurred_at: "2026-10-31T00:00:00.000Z",
              idempotency_key: "m-2"
            },
            handle: {
              executionId: "e-2",
              requestId: "r-2",
              attemptId: "att-2",
              runId: "run-dep",
              taskId: "task-2",
              idempotencyKey: "m-2",
              target: {
                transport: "herdr",
                agentId: "dev-2",
                workspaceId: "w-1",
                tabId: "t-1",
                paneId: "p-2",
                worktreePath: tree2.worktreePath
              },
              correlation: { token: "r-2", provenance: "orchestrator", verified: false },
              acceptedAt: "2026-10-31T00:00:00.000Z"
            }
          }
        ]
      }),
      withDeveloperWorkspace: async (_b: unknown, _r: string, _t: string, cb: (...args: any[]) => Promise<unknown>) =>
        cb(
          {
            worktrees: [tree2],
            spec: {
              specification: { acceptanceCriteria: [] },
              strategy: { tddDecision: { mode: "recommended" }, targetCommands: [], criterionMappings: [], metadata: {} }
            }
          },
          { metadata: { ownedPaths: ["src/b.ts", "test/b.test.ts"], forbiddenPaths: [] } }
        ),
      ports: { policies: { assertReadyToImplement: () => {} } }
    };
    const dev2Host = new HostDevelopment(() => depRuntime as never, []);

    await expect(
      dev2Host.writeWorkspaceFile(pane2, { path: "src/a.ts", content: "tamper\n", expectedSha256: sha256("export const a = 21;\n") })
    ).rejects.toThrow(/outside the accepted task ownership/);

    const priorB = (await dev2Host.readWorkspaceFile(pane2, { path: "src/b.ts" })) as any;
    await dev2Host.writeWorkspaceFile(pane2, {
      path: "src/b.ts",
      content: 'import { a } from "./a.js";\nexport const b = a * 2;\n',
      expectedSha256: priorB.sha256
    });
    await dev2Host.writeWorkspaceFile(pane2, {
      path: "test/b.test.ts",
      content: 'import { b } from "../src/b.js";\nif (b !== 42) throw new Error("bad");\n',
      expectedSha256: null
    });
    const commitRes = (await dev2Host.commit(pane2, {
      expectedHead: tree2.baseCommitHash,
      message: "task-2 uses task-1 export within its own scope"
    })) as any;
    expect(commitRes.committed).toBe(true);

    const change2 = (await gitPolicy.collectTask(tree2.key)) as any;
    expect(change2.filesChanged.map((file: any) => file.path).sort()).toEqual(["src/b.ts", "test/b.test.ts"]);
  });

  it("Vector 3A: accepts null and empty-string optional parameters across HostDevelopment, handleTaskLogTool, PolicyReviewPageInputSchema, and CoordinatorTools", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-null-params-")));
    tempRoots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.test");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/item.ts"), "v1\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "init");
    const head = git(root, "rev-parse", "HEAD");

    const devPane: PaneBinding = {
      schemaVersion: 2,
      bindingId: "b-null",
      sessionId: "s-null",
      role: "developer",
      paneGroup: "developer_worktree",
      agentId: "dev-null",
      workspaceId: "w-1",
      tabId: "t-1",
      paneId: "p-null",
      provider: "codex",
      agentKind: "codex",
      cwd: root,
      worktreePath: root,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: false,
      permanent: false,
      session: { source: "codex", kind: "id", value: "sess-dev" },
      transportState: "working",
      boundAt: "2026-10-31T00:00:00.000Z"
    };

    const mockRuntime = {
      inspect: async () => ({
        runs: [{ runId: "run-1", status: "implementing", tasks: [{ taskId: "task-1" }] }],
        outbound: [
          {
            status: "accepted",
            taskId: "task-1",
            attemptId: "att-1",
            message: {
              schema_version: 2,
              message_id: "m-null",
              correlation_id: "c-null",
              run_id: "run-1",
              sender: { role: "coordinator" },
              recipient: { role: "developer", agent_id: "dev-null", pane_id: "p-null" },
              type: "task.assignment",
              payload: {},
              artifact_references: [],
              occurred_at: "2026-10-31T00:00:00.000Z",
              idempotency_key: "m-null"
            },
            handle: {
              executionId: "e-null",
              requestId: "r-null",
              attemptId: "att-1",
              runId: "run-1",
              taskId: "task-1",
              idempotencyKey: "m-null",
              target: {
                transport: "herdr",
                agentId: "dev-null",
                workspaceId: "w-1",
                tabId: "t-1",
                paneId: "p-null",
                worktreePath: root,
                session: devPane.session
              },
              correlation: { token: "r-null", provenance: "orchestrator", verified: false },
              acceptedAt: "2026-10-31T00:00:00.000Z"
            }
          }
        ]
      }),
      taskHandover: async () => ({ available: false, reason: "none" }),
      readPolicyFailureContext: async (_binding: PaneBinding, runId: string, taskId: string, attemptId: string) =>
        ({ runId, taskId, attemptId, actionable: false, failures: [] }),
      withDeveloperWorkspace: async (_b: unknown, _r: string, _t: string, cb: (...args: any[]) => Promise<unknown>) =>
        cb(
          {
            worktrees: [{ baseCommitHash: head, branchName: "main" }],
            spec: {
              specification: { acceptanceCriteria: [] },
              strategy: { tddDecision: { mode: "recommended" }, targetCommands: [], criterionMappings: [], metadata: {} }
            }
          },
          { metadata: { ownedPaths: ["src"], forbiddenPaths: [] } }
        ),
      reportProgress: async (runId: string, headline: string, questions: string[]) => ({ runId, headline, questions }),
      proposeWorkflow: async (runId: string, _spec: unknown, _def: unknown, maxIterations: number) => ({ runId, maxIterations }),
      ports: { roleProfiles: [], policies: { assertReadyToImplement: () => {} } }
    };

    const devHost = new HostDevelopment(() => mockRuntime as never, []);

    // HostDevelopment tools with null & empty-string runId/taskId
    const readRes = (await devHost.readWorkspaceFile(devPane, { path: "src/item.ts", runId: null, taskId: null })) as any;
    expect(readRes).toMatchObject({ exists: true, content: "v1\n" });
    await expect(
      devHost.writeWorkspaceFile(devPane, {
        path: "src/item.ts",
        content: "v2\n",
        expectedSha256: readRes.sha256,
        runId: "",
        taskId: null
      })
    ).resolves.toMatchObject({ written: true });
    // Blind write omitting expectedSha256 is still strictly rejected!
    await expect(devHost.writeWorkspaceFile(devPane, { path: "src/item.ts", content: "v3\n" })).rejects.toThrow();
    await expect(devHost.status(devPane, { runId: null, taskId: "" })).resolves.toMatchObject({ runId: "run-1", taskId: "task-1" });
    await expect(
      devHost.commit(devPane, { expectedHead: head, message: "null optional ids", runId: null, taskId: null })
    ).resolves.toMatchObject({ committed: true });

    // Task log tools with null & empty-string optional filters
    const activityLog = TaskActivityLog.open(join(root, "activity.jsonl"));
    await expect(
      handleTaskLogTool(
        { role: "developer", binding: devPane, activityLog, inspect: mockRuntime.inspect },
        "read_task_log",
        { runId: "run-1", taskId: "task-1", lines: null, maxBytes: null, cursor: null, view: "" }
      )
    ).resolves.toMatchObject({ entries: [] });
    const coordPane: PaneBinding = { ...devPane, role: "coordinator", agentId: "coord", paneId: "p-coord" };
    await expect(
      handleTaskLogTool(
        { role: "coordinator", binding: coordPane, activityLog, inspect: mockRuntime.inspect },
        "log_task_step",
        { runId: "run-1", taskId: null, action: "Coordinator run-level step" }
      )
    ).resolves.toMatchObject({ recorded: true });

    // PolicyReviewPageInputSchema with null & empty-string optionals
    expect(
      PolicyReviewPageInputSchema.parse({
        runId: "run-1",
        taskId: "task-1",
        phase: "green",
        view: null,
        cursor: "",
        offset: null
      })
    ).toEqual({ runId: "run-1", taskId: "task-1", phase: "green" });

    // CoordinatorTools with null & empty-string optionals
    const coordTools = new CoordinatorTools(mockRuntime as never);
    await expect(
      coordTools.invoke("inspect", { runId: null, taskId: null, view: null, cursor: "" }, { role: "coordinator" })
    ).resolves.toMatchObject({ runs: [{ runId: "run-1" }] });
    await expect(
      coordTools.invoke("report_progress", { runId: "run-1", headline: "Working", questions: null }, { role: "coordinator" })
    ).resolves.toEqual({ runId: "run-1", headline: "Working", questions: [] });
    await expect(
      coordTools.invoke(
        "propose_workflow",
        { runId: "run-1", specification: {}, definition: {}, maxIterations: "" },
        { role: "coordinator" }
      )
    ).resolves.toEqual({ runId: "run-1", maxIterations: 3 });
  });
});
