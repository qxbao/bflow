import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, git, phaseTestName, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

// AgenticJournal persists changes under POSIX flock; these integration cases exercise that boundary.
describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("connected independent policy phases", () => {
  it.each(["node_tap", "vitest_json"] as const)("%s follows real Red/Green/Refactor through QA, borrowed notices, gates and human delivery", async reporter => {
    const f = await connectedPhaseFixture(reporter);
    expect((await f.dossier()).strategy.tddDecision.mode).toBe("required");
    await expect(f.edit(f.sourcePath)).rejects.toThrow("Red evidence");
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).rejects.toThrow("Red evidence");
    await expect(f.edit("guide.md")).rejects.toThrow("outside the accepted task ownership");
    await f.addTests(); const redRevision = f.currentHead();
    const red = await f.measure("red"); expect(red.status).toBe("failed");
    expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await expect(f.edit(f.testPath)).rejects.toThrow("frozen");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n");
    await writeFile(join(f.developer.worktreePath!, f.testPath), f.testSource + "// mixed test change\n");
    await expect(f.commit("mixed source and frozen tests")).rejects.toThrow("frozen");
    expect(f.currentHead()).toBe(redRevision); expect(git(f.developer.worktreePath!, "diff", "--cached", "--name-only")).toBe("");
    await writeFile(join(f.developer.worktreePath!, f.testPath), f.testSource);
    const greenCommit = await f.commit("Green: double the input") as any;
    expect(greenCommit).toMatchObject({ committed: true });
    expect(git(f.developer.worktreePath!, "show", "--format=", "--name-only", greenCommit.head)).toBe(f.sourcePath);
    const feedback = await f.development.check(f.developer, { runId: "run-1", taskId: "implement" }) as any;
    expect(feedback.independentAcceptanceEvidence).toBe(false); expect(feedback.measurements[0].failed).toBe(0);
    expect((await f.dossier()).strategy.metadata.tddEvidence).toHaveLength(1);
    const green = await f.measure("green"); expect(green.status).toBe("passed");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "const double=x=>2*x; module.exports=double;\n"); await f.commit("Refactor: name the doubling operation");
    const refactor = await f.measure("refactor"); expect(refactor.status).toBe("passed");
    for (const receipt of [red, green, refactor]) {
      expect(await f.receipts.authenticateEvidence(receipt)).toBe(true);
      expect((receipt.metadata!.conditionalTdd as any).testRevision).toBe(redRevision);
      expect((receipt.metadata!.conditionalTdd as any).testNames).toEqual([phaseTestName]);
      expect(unwrap(await f.ports.artifactStore.resolve(receipt.evidenceArtifacts[0]!.artifactId))).toEqual(receipt.evidenceArtifacts[0]);
    }
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
    const developerTurns = f.transport.sentRequests.filter(request => request.role === "developer");
    expect(developerTurns).toHaveLength(4); expect(new Set(developerTurns.map(request => request.target.paneId))).toEqual(new Set([f.developer.paneId]));
    await f.submit("implement", null); await f.tickWithReviews(); await f.tickWithReviews();
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status).toBe("passed"); expect(run.workflowCycle.status).toBe("passed");
    expect(run.workflowCycle.history[0].metadata.integrationCommitHash).toBe(run.workflowChange.headCommitHash);
    expect(f.calls.map(context => (context.input as any).scope)).toEqual(["task", "workflow"]);
    expect((f.calls[0]!.input as any).sourceRevision).toBe(f.currentHead());
    expect((f.calls[1]!.input as any).sourceRevision).toBe(run.workflowChange.headCommitHash);
    expect(run.status).toBe("awaiting_approval"); expect(run.approvalKind).toBe("delivery");
    await f.approve(); expect((await f.inspect()).status).toBe("completed");
    expect(unwrap(await f.ports.runStore.get("run-1"))!.snapshot.status).toBe("succeeded");
    expect(git(f.repository, "branch", "--show-current")).toBe("main");
  }, 120_000);
});
