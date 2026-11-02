import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  ApprovalDecisionSchema,
  RoleMessageSchema,
  type PaneBinding,
  type QualityGateResult
} from "@bflow/contracts";
import { fixture as p19Fixture, cleanups as p19Cleanups, git as p19Git } from "../helpers/agentic-integration-fixture.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { validateTestIntegrityEvidence } from "../../src/agentic/host-test-integrity.js";
import { reworkVerificationVerdicts } from "../../src/agentic/rework-causality.js";
import { VerificationEngine } from "../../../verification/src/engine.js";
import { createVerificationPlan } from "../../../verification/src/model.js";

const localCleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of localCleanups.splice(0).reverse()) await fn();
  for (const fn of p19Cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
});

describe("Flow 07 — Round 4 Verification, Rework & Git Delivery Hardening", () => {
  it("rework exceeding max iterations escalates to user with actionable workflow_blocked notice, pendingAction, and options", async () => {
    // A failing Reviewer with a single allowed iteration exhausts the verification loop on the first failed cycle.
    const f = await p19Fixture({ failReview: true });
    const runId = "run-1";
    await f.runtime.proposeWorkflow(runId, f.spec, f.def, 1);
    await f.runtime.tick();
    await f.evidence("implement");
    await f.submit("implement", "implemented code\n");
    await f.runtime.tick();
    await f.runtime.tick();

    // Verify task verification failed
    const runAfterTick = (await f.runtime.inspect(runId)) as any;
    const task = runAfterTick.tasks.find((t: any) => t.taskId === "implement");
    expect(task.cycle.status).toBe("escalated");
    expect(task.cycle.escalation.reason).toContain("exhausted");

    // Attack check: Run must be escalated WITH an actionable pendingAction and conversation notice
    expect(runAfterTick.status).toBe("escalated");
    expect(runAfterTick.pendingAction).toBeDefined();
    expect(runAfterTick.pendingAction.kind).toBe("resume_coordinator");
    expect(runAfterTick.pendingAction.recovery).toBe("manual");
    expect(runAfterTick.pendingAction.state).toBe("pending");

    const outMsgs = ((await f.runtime.inspect()) as any).outbound.map((o: any) => o.message);
    const progressNotice = outMsgs.find(
      (m: any) => m.type === "conversation.progress" && m.payload?.kind === "workflow_blocked"
    );
    expect(progressNotice).toBeDefined();
    expect(progressNotice.payload.options).toEqual(
      expect.arrayContaining([expect.stringMatching(/Review.*findings|updated specification|Cancel/i)])
    );

    // Coordinator must receive a wake task.status
    const coordNotice = outMsgs.find(
      (m: any) => m.recipient?.role === "coordinator" && m.type === "task.status" && m.payload?.kind === "workflow_blocked"
    );
    expect(coordNotice).toBeDefined();
  });

  it("merge conflict escalation creates actionable pendingAction and notifies user with conflict resolution options", async () => {
    const f = await p19Fixture({ parallel: true, conflict: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.evidence("implement");
    await f.evidence("other");
    await f.submit("implement", "first branch\n");
    await f.submit("other", "second branch\n");
    await f.runtime.tick();
    await f.runtime.tick();

    // Exhaust resolver attempts by failing them
    await f.runtime.transaction(async (state, save, _core, outbox) => {
      const run = state.runs.find(r => r.runId === "run-1")!;
      expect(run.conflictResolution).toBeDefined();
      // Both allowed resolver attempts failed (exhausted)
      run.conflictResolution!.attempts = [
        { messageId: "m1", taskId: "t1", attemptId: "a1", agentName: "d1", status: "failed", reason: "fail 1" },
        { messageId: "m2", taskId: "t2", attemptId: "a2", agentName: "d2", status: "failed", reason: "fail 2" }
      ];
      await save();
    });

    await f.runtime.tick();

    const run = (await f.runtime.inspect("run-1")) as any;
    expect(run.status).toBe("escalated");
    expect(run.pendingAction).toBeDefined();
    expect(run.pendingAction.kind).toBe("resume_coordinator");
    expect(run.pendingAction.recovery).toBe("manual");

    const outMsgs = ((await f.runtime.inspect()) as any).outbound.map((o: any) => o.message);
    const progressNotice = outMsgs.find(
      (m: any) => m.type === "conversation.progress" && m.payload?.kind === "workflow_blocked" && m.payload?.headline?.includes("conflict")
    );
    expect(progressNotice).toBeDefined();
    expect(progressNotice.payload.options).toEqual(
      expect.arrayContaining([expect.stringMatching(/manually.*worktree|Cancel/i)])
    );
  });

  it("integration on dirty main repository emits actionable blocker and pauses rather than spinning with 'No action needed'", async () => {
    const f = await p19Fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.evidence("implement");
    await f.submit("implement", "valid implementation\n");
    await f.runtime.tick();

    // Make the main repository dirty before integrate() is called
    await writeFile(join(f.repository, "untracked-dirty.txt"), "dirty main repo content\n");

    await f.runtime.tick();

    const run = (await f.runtime.inspect("run-1")) as any;
    // Should NOT say "No action needed: Runtime retries this run on the next scheduling step"
    const outMsgs = ((await f.runtime.inspect()) as any).outbound.map((o: any) => o.message);
    const notice = outMsgs.find(
      (m: any) => m.type === "conversation.progress" && m.payload?.kind === "workflow_blocked" && m.payload?.reason?.includes("uncommitted changes")
    );
    expect(notice).toBeDefined();
    expect(notice.payload.options).not.toContain("No action needed: Runtime retries this run on the next scheduling step");
    expect(notice.payload.options).toEqual(
      expect.arrayContaining([expect.stringMatching(/Commit or stash.*main repository|Cancel/i)])
    );
    expect(run.status).toBe("escalated");
    expect(run.pendingAction?.kind).toBe("resume_coordinator");
  });

  it("workflow-level verification triggers cleanly when run.workflowChange is already present and run.status is implementing", async () => {
    const f = await p19Fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.evidence("implement");
    await f.submit("implement", "clean implement\n");
    await f.runtime.tick();

    // Now all tasks succeeded and task cycle passed.
    // Let's set up the state where run.workflowChange exists, run.status is "implementing",
    // and run.workflowVerificationPending is false (e.g. recovered or after task approval)
    await f.runtime.transaction(async (state, save) => {
      const run = state.runs.find(r => r.runId === "run-1")!;
      // Simulate that workflowChange was captured, but run.status reset to "implementing"
      run.status = "implementing";
      run.workflowVerificationPending = false;
      delete run.workflowCycle;
      delete run.approval; delete run.approvalKind; delete run.decision; delete run.pendingAction;
      await save();
    });

    // Call tick() - it must trigger workflow-level verification!
    await f.runtime.tick();

    const run = (await f.runtime.inspect("run-1")) as any;
    // The tick starts workflow-level verification for the already captured integrated change and settles it in the same pass.
    expect(run.workflowVerificationPending).toBe(false);
    expect(run.workflowCycle).toBeDefined();
    expect(run.workflowCycle.status).toBe("passed");
    expect(run.status).toBe("awaiting_approval");
    expect(run.approvalKind).toBe("delivery");
  });

  it("validates test-integrity evidence and rework finding verdicts with mixed-case Git commit hashes", async () => {
    const f = await p19Fixture({ intake: false });
    const head = p19Git(f.repository, "rev-parse", "HEAD");
    const upperHead = head.toUpperCase();

    // validateTestIntegrityEvidence should accept uppercase or lowercase hash without throwing mismatch
    const report = {
      baseRevision: head,
      candidateRevision: head,
      findings: [
        {
          id: "int-1",
          ruleId: "oracle_weakening",
          classification: "suspicion" as const,
          category: "test" as const,
          message: "test weakening",
          evidenceLocations: [{ revision: head, path: "guide.md", line: 1, excerpt: "initial" }]
        }
      ]
    };

    const verdicts = [
      {
        findingId: "int-1",
        verdict: "equivalent" as const,
        reason: "verified refactor",
        evidence: [{ revision: upperHead, path: "guide.md", line: 1, excerpt: "initial" }]
      }
    ];

    // This should not throw revision mismatch
    await expect(validateTestIntegrityEvidence(f.repository, report, verdicts)).resolves.not.toThrow();
  });
});
