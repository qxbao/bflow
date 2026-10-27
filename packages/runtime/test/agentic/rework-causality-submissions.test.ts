import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentResultSchema, QualityFindingSchema } from "@bflow/contracts";
import { ReworkResolutionDossierSchema } from "../../src/agentic/rework-causality.js";
import { cleanups, git, createReworkFixture } from "../helpers/rework-causality-fixture.js";

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("Rework root-cause explanation & independent verification through Runtime/host", () => {
  it("rejects rework submissions with missing finding explanations or wrong revision/generation evidence without silently closing findings", async () => {
    const f = await createReworkFixture();
    await f.recordAlternativeEvidence("implement");

    // Cycle 1 fails review with 2 findings
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "Two defects found",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "defect_alpha",
          message: "Alpha defect in guide.md",
          location: "guide.md:1"
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "defect_beta",
          message: "Beta defect in guide.md",
          location: "guide.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
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
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [alphaFinding, betaFinding] = devStatus.reworkContext.findings;
    const staleCheckWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    await writeFile(join(rework.handle.target.worktreePath, "guide.md"), "v2 fixed\n");
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "v2 fix"
    })) as any;

    // 1. Omitting findingResolutions entirely must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        undefined,
        "succeeded"
      )
    ).rejects.toThrow(/missing required root-cause findingResolutions/);

    // 2. Explaining only 1 of 2 assigned findings must be rejected (missing betaFinding)
    const makeValidEntry = (finding: any, overrides: Record<string, unknown> = {}) => ({
      findingId: finding.findingId,
      disposition: "addressed",
      rootCause: `Root cause for ${finding.code} in guide.md`,
      sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
      repairSummary: `Fixed ${finding.code} in guide.md`,
      discriminatingCheck: {
        kind: "manual_review",
        target: "guide.md:1",
        beforeOutcome: `Failed ${finding.code}`,
        afterOutcome: `Passed ${finding.code}`
      },
      evidence: {
        sourceRevision: committed.head,
        reworkGeneration: 1,
        summary: `Verified at ${committed.head}`
      },
      ...overrides
    });

    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [makeValidEntry(alphaFinding)],
        "succeeded"
      )
    ).rejects.toThrow(new RegExp(`Missing findingId\\(s\\): ${betaFinding.findingId}`));

    // 3. Evidence with wrong sourceRevision (failedRevision instead of committed HEAD) must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              sourceRevision: devStatus.reworkContext.failedRevision,
              reworkGeneration: 1,
              summary: "Stale revision evidence"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/evidence\.sourceRevision .* must match the current worktree HEAD/);

    // 4. Evidence referencing a stored check_work artifact recorded at the stale (pre-commit) revision must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              artifactRef: staleCheckWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Artifact recorded before commit"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/check_work artifact recorded at revision/);

    // 5. Evidence with wrong reworkGeneration must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              sourceRevision: committed.head,
              reworkGeneration: 99,
              summary: "Wrong generation"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/evidence\.reworkGeneration \(99\) must match active reworkGeneration \(1\)/);

    // 6. Direct receiveHerdr of an implementation.submitted message without findingResolutions marks inbox rejected and does not advance task
    await expect(
      f.runtime.receiveHerdr(
        f.envelope(
          "implementation.submitted",
          AgentResultSchema.parse({
            requestId: rework.handle.requestId,
            attemptId: rework.handle.attemptId,
            runId: "run-1",
            taskId: "implement",
            executionId: rework.handle.executionId,
            status: "succeeded",
            verification: {
              status: "verified",
              evidence: "Missing rework explanation",
              correlation: rework.handle.correlation
            },
            artifactProposals: [],
            retryable: false,
            startedAt: rework.handle.acceptedAt,
            completedAt: new Date().toISOString()
          }),
          {
            message_id: "bad-rework-submit-1",
            idempotency_key: "bad-rework-submit-1",
            causation_id: rework.outbound.message.message_id,
            sender: {
              role: "developer",
              agent_id: rework.handle.target.agentId,
              pane_id: rework.handle.target.paneId
            }
          }
        )
      )
    ).rejects.toThrow(/missing required root-cause findingResolutions/);

    const stateAfterReject = await f.inspectState();
    const rejectedInbox = stateAfterReject.inbox.find(
      (item: any) => item.message.message_id === "bad-rework-submit-1"
    );
    expect(rejectedInbox?.status).toBe("rejected");
    const runAfterReject = await f.inspectRun();
    expect(runAfterReject.tasks[0].reworkResolutions ?? []).toHaveLength(0);
  }, 120_000);

  it("supports disputed findings with reproduction evidence and reason, and blocked rework findings via the existing blocker escalation flow", async () => {
    const f = await createReworkFixture();
    await f.recordAlternativeEvidence("implement");

    // Cycle 1 fails with one real defect in guide.md and one non-reproducible finding in notes.md
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "guide v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "One real defect and one suspected issue",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "guide_typo",
          message: "guide.md is missing section header",
          location: "guide.md:1"
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "phantom_race",
          message: "Suspected race condition in notes.md line 1",
          location: "notes.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
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
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [guideFinding, disputedFinding] = devStatus.reworkContext.findings;

    // Modify ONLY guide.md (notes.md is untouched because disputedFinding could not be reproduced)
    await writeFile(join(rework.handle.target.worktreePath, "guide.md"), "# Section Header\nguide v2\n");
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "fix guide.md and dispute phantom_race with reproduction evidence"
    })) as any;
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    // Disputed finding WITHOUT disputeReason must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          {
            findingId: guideFinding.findingId,
            disposition: "addressed",
            rootCause: "guide.md omitted markdown heading on line 1",
            sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 2 }],
            repairSummary: "Added # Section Header to guide.md",
            discriminatingCheck: {
              kind: "manual_review",
              target: "guide.md:1",
              beforeOutcome: "No header on line 1",
              afterOutcome: "# Section Header present on line 1"
            },
            evidence: {
              artifactRef: checkWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Verified guide.md header"
            }
          },
          {
            findingId: disputedFinding.findingId,
            disposition: "disputed",
            rootCause: "notes.md is static markdown and has no concurrent state mutation",
            sourceLocations: [{ path: "notes.md", startLine: 1, endLine: 2 }],
            repairSummary: "No change to notes.md; retained reproduction check output",
            discriminatingCheck: {
              kind: "unit_test",
              target: "unit-check",
              beforeOutcome: "unit-check exits 0 against unmodified notes.md",
              afterOutcome: "unit-check exits 0 with deterministic output"
            },
            evidence: {
              artifactRef: checkWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Reproduction run in check_work shows zero failure on notes.md"
            }
          }
        ],
        "succeeded"
      )
    ).rejects.toThrow(/disputeReason is required/);

    // Now supply valid disputeReason and evidence for the disputed finding
    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      [
        {
          findingId: guideFinding.findingId,
          disposition: "addressed",
          rootCause: "guide.md omitted markdown heading on line 1",
          sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 2 }],
          repairSummary: "Added # Section Header to guide.md",
          discriminatingCheck: {
            kind: "manual_review",
            target: "guide.md:1",
            beforeOutcome: "No header on line 1",
            afterOutcome: "# Section Header present on line 1"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Verified guide.md header"
          }
        },
        {
          findingId: disputedFinding.findingId,
          disposition: "disputed",
          disputeReason:
            "Finding cannot be reproduced: notes.md is a static document and unit-check passes deterministically",
          rootCause: "notes.md is static markdown and has no concurrent state mutation",
          sourceLocations: [{ path: "notes.md", startLine: 1, endLine: 2 }],
          repairSummary: "No change to notes.md; preserved reproduction evidence and rationale",
          discriminatingCheck: {
            kind: "unit_test",
            target: "unit-check",
            beforeOutcome: "unit-check exits 0 against unmodified notes.md",
            afterOutcome: "unit-check exits 0 with deterministic output"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Reproduction run in check_work shows zero failure on notes.md"
          }
        }
      ],
      "succeeded"
    );

    expect(dossier).toBeDefined();
    expect(dossier!.findingResolutions[1]!.disposition).toBe("disputed");
    expect(dossier!.findingResolutions[1]!.disputeReason).toContain("cannot be reproduced");

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: rework.handle.requestId,
          attemptId: rework.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: rework.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Rework with disputed finding",
            correlation: rework.handle.correlation
          },
          output: { reworkResolution: dossier } as any,
          artifactProposals: [],
          retryable: false,
          startedAt: rework.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: rework.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: rework.handle.target.agentId,
            pane_id: rework.handle.target.paneId
          }
        }
      )
    );

    f.setReviewerHandler(inspected => {
      const resolutions = (inspected.reworkResolution as any).findingResolutions;
      expect(resolutions[1].disposition).toBe("disputed");
      expect(resolutions[1].disputeReason).toContain("cannot be reproduced");
      return {
        summary: "Confirmed guide.md fix and accepted disputed notes.md finding based on reproduction evidence",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: guideFinding.findingId,
            verdict: "confirmed",
            summary: "Header added"
          },
          {
            findingId: disputedFinding.findingId,
            verdict: "confirmed",
            summary: "Reproduction evidence confirms notes.md has no race condition"
          }
        ]
      };
    });

    await f.runtime.tick();
    const afterVerify = await f.inspectRun();
    expect(afterVerify.tasks[0].cycle.status).toBe("passed");
    expect(afterVerify.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe(
      "verified_closed"
    );
  }, 120_000);

  it("keeps findings open when Developer claims 'addressed' but independent Reviewer rejects the explanation, and escalates when maxIterations is exhausted", async () => {
    // Configure maxIterations = 2 so cycle 1 failure + cycle 2 Reviewer rejection exhausts the iteration budget
    const f = await createReworkFixture({ maxIterations: 2 });
    await f.recordAlternativeEvidence("implement");

    // Cycle 1: Initial implementation fails review
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "buggy v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "Calculation invariant broken in guide.md",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "broken_invariant",
          message: "guide.md still uses buggy formula",
          location: "guide.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
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
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    // Cycle 2 (reworkGeneration = 1): Developer submits all required fields claiming `disposition: "addressed"`,
    // but only makes a superficial edit that does not actually fix the defect.
    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [assignedFinding] = devStatus.reworkContext.findings;

    await writeFile(
      join(rework.handle.target.worktreePath, "guide.md"),
      "superficial v2 (still buggy)\n"
    );
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "claim fixed"
    })) as any;
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      [
        {
          findingId: assignedFinding.findingId,
          disposition: "addressed",
          rootCause: "Claimed root cause: wording on line 1 was outdated",
          sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
          repairSummary: "Updated line 1 text to superficial v2",
          discriminatingCheck: {
            kind: "manual_review",
            target: "guide.md:1",
            beforeOutcome: "Had buggy v1",
            afterOutcome: "Has superficial v2"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Developer self-reported check"
          }
        }
      ],
      "succeeded"
    );

    expect(dossier!.verificationOutcome.status).toBe("pending_independent_verification");

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: rework.handle.requestId,
          attemptId: rework.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: rework.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Superficial rework submission",
            correlation: rework.handle.correlation
          },
          output: { reworkResolution: dossier } as any,
          artifactProposals: [],
          retryable: false,
          startedAt: rework.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: rework.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: rework.handle.target.agentId,
            pane_id: rework.handle.target.paneId
          }
        }
      )
    );

    // Independent Reviewer inspects the Developer's reworkResolution and REJECTS it!
    // Notice we set criteriaPassed: true to prove that rejecting a findingVerdict alone fails the review gate!
    f.setReviewerHandler(inspected => {
      expect(inspected.reworkResolution).toBeDefined();
      return {
        summary: "Developer superficial edit did not fix the broken_invariant root cause",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: assignedFinding.findingId,
            verdict: "rejected",
            summary: "guide.md line 1 still contains the buggy formula; root cause was not addressed"
          }
        ]
      };
    });

    await f.runtime.tick();

    const afterExhaustion = await f.inspectRun();
    // Because maxIterations = 2 is now exhausted (2 failed verification cycles), the cycle and run escalate
    expect(afterExhaustion.tasks[0].cycle.status).toBe("escalated");
    expect(afterExhaustion.tasks[0].cycle.history).toHaveLength(2);
    expect(afterExhaustion.status).toBe("escalated");
    expect(afterExhaustion.error).toContain("Verification iteration limit exhausted");

    // The rework dossier must NOT mark the finding closed; it records exhausted_failed with the finding still open
    const finalDossier = ReworkResolutionDossierSchema.parse(
      afterExhaustion.tasks[0].reworkResolutions[0]
    );
    expect(finalDossier.verificationOutcome.status).toBe("exhausted_failed");
    expect(finalDossier.verificationOutcome.closedFindingIds).toEqual([]);
    expect(finalDossier.verificationOutcome.openFindingIds).toEqual([assignedFinding.findingId]);
    expect(finalDossier.verificationOutcome.findingVerdicts[0]).toMatchObject({
      findingId: assignedFinding.findingId,
      verdict: "rejected"
    });
  }, 120_000);
});
