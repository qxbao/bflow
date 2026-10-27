import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentResultSchema, QualityFindingSchema } from "@bflow/contracts";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { ReworkResolutionDossierSchema } from "../../src/agentic/rework-causality.js";
import { draft } from "../../../specification/test/fixtures.js";
import { cleanups, git, createReworkFixture } from "../helpers/rework-causality-fixture.js";

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("Rework root-cause explanation & independent verification through Runtime/host", () => {
  it.each([undefined, "partial", "absent", "durable"] as const)("enforces independent finding coverage through Runtime/host (legacy verdicts: %s)", async legacyVerdicts => {
    const f = await createReworkFixture({legacyVerdicts});
    await f.recordAlternativeEvidence("implement");

    // Initial implementation attempt (cycle 1)
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "draft v1\nline 2\n");
    await writeFile(join(initial.handle.target.worktreePath, "notes.md"), "notes draft v1\nline 2\n");
    git(initial.handle.target.worktreePath, "add", "guide.md", "notes.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "initial implementation");

    const handoverContext = await f.runtime.taskHandover(initial.developerBinding, {}) as any;
    await f.runtime.taskHandover(initial.developerBinding, { proposal: { schemaVersion: 1, binding: handoverContext.binding,
      content: { nextAction: "Check two boundaries", decisions: [], disprovedHypotheses: [], untestedAngles: [], references: [] } } });

    // Reviewer emits TWO distinct error findings that share the exact same `code` ("missing_invariant")
    f.setReviewerHandler(() => ({
      summary: "Two distinct files violate missing_invariant",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "missing_invariant",
          message: "guide.md omits boundary condition A on line 1",
          location: "guide.md:1",
          details: { filePath: "guide.md", line: 1 }
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "missing_invariant",
          message: "notes.md omits rollback invariant B on line 2",
          location: "notes.md:2",
          details: { filePath: "notes.md", line: 2 }
        })
      ]
    }));

    const firstResult = AgentResultSchema.parse({
      requestId: initial.handle.requestId,
      attemptId: initial.handle.attemptId,
      runId: "run-1",
      taskId: "implement",
      executionId: initial.handle.executionId,
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Initial submission",
        correlation: initial.handle.correlation
      },
      artifactProposals: [],
      retryable: false,
      startedAt: initial.handle.acceptedAt,
      completedAt: new Date().toISOString()
    });
    await f.runtime.receiveHerdr(
      f.envelope("implementation.submitted", firstResult, {
        causation_id: initial.outbound.message.message_id,
        sender: {
          role: "developer",
          agent_id: initial.handle.target.agentId,
          pane_id: initial.handle.target.paneId
        }
      })
    );

    // Run verification for cycle 1 -> transitions to rework_required and dispatches rework assignment
    await f.runtime.tick();
    await f.runtime.tick();

    const afterCycle1 = await f.inspectRun();
    expect(afterCycle1.tasks[0].cycle.status).toBe("rework_required");

    // Inspect rework assignment via HostDevelopment.status()
    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    expect(devStatus.resumeContext.handover).toMatchObject({ status: "withheld", code: "handover_generation_mismatch" });
    const retiredContext = await f.runtime.taskHandover(initial.developerBinding, {}) as any;
    expect(retiredContext.authority.reworkContext.reworkGeneration).toBe(1);
    expect(retiredContext.authority.verificationCycle.status).toBe("rework_required");
    expect(devStatus.reworkContext).toBeDefined();
    expect(devStatus.reworkContext.reworkGeneration).toBe(1);
    expect(devStatus.reworkContext.findings).toHaveLength(2);
    const [finding1, finding2] = devStatus.reworkContext.findings;
    expect(finding1.code).toBe("missing_invariant");
    expect(finding2.code).toBe("missing_invariant");
    // Must NOT merge findings with the same code: findingIds must be distinct and preserve their locations
    expect(finding1.findingId).not.toBe(finding2.findingId);
    expect(finding1).toMatchObject({ location: "guide.md:1", filePath: "guide.md", line: 1 });
    expect(finding2).toMatchObject({ location: "notes.md:2", filePath: "notes.md", line: 2 });

    // Developer fixes both files in the worktree and commits via HostDevelopment.commit()
    await writeFile(
      join(rework.handle.target.worktreePath, "guide.md"),
      "boundary condition A enforced\nline 2\n"
    );
    await writeFile(
      join(rework.handle.target.worktreePath, "notes.md"),
      "notes draft v1\nrollback invariant B documented\n"
    );
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "fix both missing_invariant findings"
    })) as any;
    expect(committed.head).not.toBe(devStatus.reworkContext.failedRevision);

    // Developer runs HostDevelopment.check() (`check_work`) to obtain an ArtifactStore reference bound to HEAD + reworkGeneration
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    expect(checkWork.reworkGeneration).toBe(1);
    expect(checkWork.sourceRevision).toBe(committed.head);
    expect(checkWork.evidence.artifactId).toMatch(/^check-work-/);

    const findingResolutions = [
      {
        findingId: finding1.findingId,
        disposition: "addressed",
        rootCause: "guide.md was written from draft template without boundary condition A on line 1",
        sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
        repairSummary: "Added explicit boundary condition A specification on line 1 of guide.md",
        discriminatingCheck: {
          kind: "manual_review",
          target: "guide.md:1",
          beforeOutcome: "guide.md line 1 lacked boundary condition A",
          afterOutcome: "guide.md line 1 states boundary condition A enforced"
        },
        evidence: {
          artifactRef: checkWork.evidence,
          sourceRevision: committed.head,
          reworkGeneration: 1,
          summary: "check_work artifact at repaired HEAD confirms guide.md update"
        }
      },
      {
        findingId: finding2.findingId,
        disposition: "addressed",
        rootCause: "notes.md omitted rollback invariant B on line 2 during initial drafting",
        sourceLocations: ["notes.md:2-2"],
        repairSummary: "Documented rollback invariant B on line 2 of notes.md",
        discriminatingCheck: {
          kind: "manual_review",
          target: "notes.md:2",
          beforeOutcome: "notes.md line 2 only had placeholder text",
          afterOutcome: "notes.md line 2 documents rollback invariant B"
        },
        evidence: {
          artifactRef: checkWork.evidence,
          sourceRevision: committed.head,
          reworkGeneration: 1,
          summary: "check_work artifact at repaired HEAD confirms notes.md update"
        }
      }
    ];

    // Prepare submission through host's prepareReworkSubmission entrypoint
    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      findingResolutions,
      "succeeded"
    );
    expect(dossier).toBeDefined();
    expect(dossier!.findingResolutions[1]!.sourceLocations).toEqual([
      { path: "notes.md", startLine: 2, endLine: 2 }
    ]);
    // Crucial invariant: Developer claiming "addressed" NEVER closes findings before independent verification
    expect(dossier!.verificationOutcome.status).toBe("pending_independent_verification");
    expect(dossier!.verificationOutcome.closedFindingIds).toEqual([]);
    expect(dossier!.verificationOutcome.openFindingIds).toEqual([
      finding1.findingId,
      finding2.findingId
    ]);

    const reworkResult = AgentResultSchema.parse({
      requestId: rework.handle.requestId,
      attemptId: rework.handle.attemptId,
      runId: "run-1",
      taskId: "implement",
      executionId: rework.handle.executionId,
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Rework submission with dossier",
        correlation: rework.handle.correlation
      },
      output: { reworkResolution: dossier } as any,
      artifactProposals: [],
      retryable: false,
      startedAt: rework.handle.acceptedAt,
      completedAt: new Date().toISOString()
    });
    await f.runtime.receiveHerdr(
      f.envelope("implementation.submitted", reworkResult, {
        causation_id: rework.outbound.message.message_id,
        sender: {
          role: "developer",
          agent_id: rework.handle.target.agentId,
          pane_id: rework.handle.target.paneId
        }
      })
    );

    // Before tick() runs independent verification, the stored dossier is still pending_independent_verification
    const beforeVerifyRun = await f.inspectRun();
    expect(beforeVerifyRun.tasks[0].reworkResolutions).toHaveLength(1);
    expect(beforeVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe(
      "pending_independent_verification"
    );

    // Reviewer now inspects the rework dossier via inspect_review and confirms both findings
    f.setReviewerHandler(inspected => {
      expect(inspected.reworkResolution).toBeDefined();
      expect((inspected.reworkResolution as any).findingResolutions).toHaveLength(2);
      return {
        summary: "Independently verified both missing_invariant fixes",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: finding1.findingId,
            verdict: "confirmed",
            summary: "Verified guide.md line 1 fix"
          },
          {
            findingId: finding2.findingId,
            verdict: "confirmed",
            summary: "Verified notes.md line 2 fix"
          }
        ]
      };
    });

    await f.runtime.tick();

    let afterVerifyRun = await f.inspectRun();
    if (legacyVerdicts === "durable") {
      const persisted = JSON.parse(await readFile(join(f.root,"journal","state.json"),"utf8"));
      expect(persisted.pendingVerifications).toHaveLength(1);
      expect(persisted.pendingVerifications[0].outcome.result.status).toBe("passed");
      f.restart();
      await f.runtime.tick();
      afterVerifyRun = await f.inspectRun();
    }
    if (legacyVerdicts) {
      expect(afterVerifyRun.tasks[0].cycle.status).toBe("escalated");
      expect(afterVerifyRun.tasks[0].cycle.history.at(-1).status).toBe("inconclusive");
      expect(afterVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe("escalated_blocked");
      expect(afterVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.closedFindingIds).toEqual([]);
      f.restart();
      const recovered = await f.inspectRun();
      expect(recovered.tasks[0].reworkResolutions[0].verificationOutcome.findingVerdicts).toEqual([]);
      expect(recovered.tasks[0].cycle.status).toBe("escalated");
      const originalGeneration = recovered.tasks[0].reworkResolutions[0].reworkGeneration;
      f.clearLegacyVerdicts();
      await f.runtime.retryVerification("run-1");
      await f.runtime.tick();
      const retried = await f.inspectRun();
      expect(retried.tasks[0].cycle.status).toBe("passed");
      expect(retried.tasks[0].cycle.currentIteration).toBe(1);
      expect(retried.tasks[0].reworkResolutions[0].reworkGeneration).toBe(originalGeneration);
      expect(retried.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe("verified_closed");
      return;
    }
    expect(afterVerifyRun.tasks[0].cycle.status).toBe("passed");
    const settledDossier = ReworkResolutionDossierSchema.parse(
      afterVerifyRun.tasks[0].reworkResolutions[0]
    );
    expect(settledDossier.verificationOutcome.status).toBe("verified_closed");
    expect(settledDossier.verificationOutcome.closedFindingIds).toEqual([
      finding1.findingId,
      finding2.findingId
    ]);
    expect(settledDossier.verificationOutcome.openFindingIds).toEqual([]);
    expect(settledDossier.verificationOutcome.findingVerdicts).toHaveLength(2);
  }, 120_000);
});
