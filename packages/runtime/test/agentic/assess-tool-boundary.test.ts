import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { classifyChange } from "../../../specification/src/classification.js";
import { draft } from "../../../specification/test/fixtures.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bflow-assess-boundary-")); roots.push(root);
  // assess is read-only: its only dependency is the real classification policy.
  const ports = { policies: { classifyChange }, roleCapabilities: { architect: ["repository.read"] } } as unknown as AgenticRuntimePorts;
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: root });
  const assess = vi.spyOn(runtime, "assess");
  return { tools: new CoordinatorTools(runtime), assess };
}
const principal = { role: "coordinator" as const };

describe("assess tool Specification ingress", () => {
  it("assesses a complete Specification with the actual classification policy", async () => {
    const f = await fixture(), spec = draft("api");
    await expect(f.tools.invoke("assess", { specification: spec }, principal)).resolves.toMatchObject({
      complexity: "complex", level: "full", humanApprovalRequired: true, clarificationRequired: false,
      suggestedRoles: ["architect", "planner"], availableCapabilities: { architect: ["repository.read"] }
    });
    expect(f.assess).toHaveBeenCalledTimes(1);
    expect(f.assess).toHaveBeenCalledWith(spec);
    expect(spec.acceptanceCriteria[0]!.status).toBe("pending");
  });

  it("reports every missing field of the recorded 2026-10-21 08:44:12 assess shape at the tool boundary", async () => {
    const f = await fixture(), valid = draft("api");
    // Same omissions as the live Coordinator call; retain all three nested criteria.
    const specification = { specId: valid.specId, runId: valid.runId, level: "full", title: valid.title,
      summary: valid.summary, affectedPaths: valid.affectedPaths, metadata: valid.metadata,
      acceptanceCriteria: ["unit_test", "integration_test", "manual_review"].map((verificationMethod, index) => ({
        id: `ac-${index + 1}`, description: "Preserve accepted criterion", verificationMethod
      })) };
    const error = await f.tools.invoke("assess", { specification }, principal).catch(error => error);
    expect(error).toBeInstanceOf(ZodError);
    const expected = ["schemaVersion", "sessionId", "problemStatement", "scope", "status", "createdBy", "createdAt", "updatedAt"];
    for (let index = 0; index < 3; index++) for (const field of ["category", "required", "status", "evidenceArtifactIds"])
      expected.push(`acceptanceCriteria.${index}.${field}`);
    expect(error.issues.map((issue: { path: (string | number)[] }) => issue.path.join(".")).sort())
      .toEqual(expected.map(path => `specification.${path}`).sort());
    expect(f.assess).not.toHaveBeenCalled();
  });

  it("distinguishes missing tool argument from missing contract fields and rejects unknown arguments", async () => {
    const f = await fixture();
    for (const input of [{}, { specification: draft(), unexpected: true }]) {
      const error = await f.tools.invoke("assess", input, principal).catch(error => error);
      expect(error).toBeInstanceOf(ZodError);
      expect(error.issues[0]).toMatchObject("specification" in input
        ? { code: "unrecognized_keys", keys: ["unexpected"], path: [] }
        : { code: "invalid_type", path: ["specification"] });
    }
    expect(f.assess).not.toHaveBeenCalled();
  });
});
