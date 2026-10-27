import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { PaneBindingSchema, SpecificationSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { classifyChange } from "../../../specification/src/classification.js";
import { draft } from "../../../specification/test/fixtures.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import recordedLogsFlow from "./fixtures/assess-logs-flow.json";
import { assessmentFailureSummary } from "../../src/agentic/assessment-input.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-assess-boundary-"))); roots.push(root);
  // assess is read-only: its only dependency is the real classification policy.
  const bindings = ["architect", "planner"].map(role => PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`,
    sessionId: "session-1", role, paneGroup: "coordination", agentId: `${role}-agent`, workspaceId: "workspace", tabId: "tab",
    paneId: `pane-${role}`, provider: "test", agentKind: "test", cwd: root, isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    transportState: "idle", boundAt: "2026-10-21T10:00:00.000Z" }));
  const ports = { policies: { classifyChange }, roleCapabilities: { architect: ["repository.read"], planner: ["repository.read"] },
    panes: { getRoleBinding: async (role: string) => ({ ok: true, value: bindings.find(binding => binding.role === role) ?? null }) }
  } as unknown as AgenticRuntimePorts;
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: root });
  const assess = vi.spyOn(runtime, "assess");
  return { root, ports, runtime, tools: new CoordinatorTools(runtime), assess };
}
const principal = { role: "coordinator" as const };

describe("assess tool Specification ingress", () => {
  it("diagnoses the recorded contract-valid Logs specification before invoking Runtime", async () => {
    const f = await fixture();
    expect(SpecificationSchema.safeParse(recordedLogsFlow.specification).success).toBe(true);
    const error = await f.tools.invoke("assess", recordedLogsFlow, principal).catch(error => error);
    expect(error).toBeInstanceOf(ZodError);
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["specification", "metadata", "sdd"], message: expect.stringContaining("planning_reference") })
    ]));
    expect(f.assess).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { sdd: null }, { sdd: {} }, { sdd: { assessment: [] } }])(
    "validates P15 assessment presence for direct Runtime callers (%j)", async metadata => {
      const f = await fixture();
      const error = await f.runtime.assess({ ...recordedLogsFlow.specification, metadata }).catch(error => error);
      expect(error).toBeInstanceOf(ZodError);
      expect(error.issues[0].path[0]).toBe("metadata");
      expect(error.message).toContain("planning_reference");
    });

  it("keeps P15 field errors under the tool specification path without inventing impact defaults", async () => {
    const f = await fixture();
    const specification = { ...recordedLogsFlow.specification, metadata: { sdd: { assessment: { kind: "feature" } } } };
    const error = await f.tools.invoke("assess", { specification }, principal).catch(error => error);
    expect(error).toBeInstanceOf(ZodError);
    expect(error.issues.map((issue: { path: string[] }) => issue.path.join(".")))
      .toContain("specification.metadata.sdd.assessment.behaviorChange");
  });

  it("logs a known input location and remediation without received values or arbitrary keys", async () => {
    const f = await fixture();
    const error = await f.tools.invoke("assess", recordedLogsFlow, principal).catch(error => error);
    expect(assessmentFailureSummary(error)).toBe("specification.metadata.sdd: invalid input; read planning_reference");
    const unsafe = new ZodError([{ code: "custom", path: ["specification", "metadata", "private-value"], message: "received secret-value" }]);
    expect(assessmentFailureSummary(unsafe)).toBe("specification.metadata: invalid input; read planning_reference");
    expect(assessmentFailureSummary(new Error("secret-value"))).toBe("P15 assess failed; inspect tool error");
  });

  it("reassesses the recorded requirement with explicit impact while preserving every delegated criterion", async () => {
    const f = await fixture();
    // Exercise Runtime's actual dist-loaded P15 adapter, not just the direct classification test dependency.
    execFileSync("git", ["init", "-b", "main"], { cwd: f.root, stdio: "pipe" });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Test",
      "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture"], { cwd: f.root, stdio: "pipe" });
    const artifacts = await openFilesystemArtifactStore({ root: join(f.root, "artifacts"), storeId: "assess" });
    if (!artifacts.ok) throw new Error(artifacts.error.message);
    try {
      f.ports.policies = await loadAgenticPolicies({ repositoryPath: f.root, artifactStore: artifacts.value, gates: [],
        loadSpecification: async () => { throw new Error("assess must not load an accepted specification"); }, authorizeApprover: () => false });
      const filesBefore = await readdir(f.root);
      // The recorded first call spans three owners; keep that scope for a conservative assessment.
      const specification = { ...recordedLogsFlow.specification, metadata: { sdd: { assessment: {
        kind: "feature", behaviorChange: true, modules: ["runtime", "pane-manager", "cli"],
        securityImpact: false, publicApiImpact: false, dataSchemaImpact: false, architectureImpact: false,
        migrationRequired: false, risk: "medium", unresolvedQuestions: []
      } } } };
      const before = structuredClone(specification);
      await expect(f.tools.invoke("assess", { specification }, principal)).resolves.toMatchObject({
        complexity: "complex", level: "full", riskLevel: "high", humanApprovalRequired: true,
        clarificationRequired: false, suggestedRoles: ["architect", "planner"]
      });
      expect(specification).toEqual(before);
      // assess never proposes a workflow, writes a journal, accepts criteria, or dispatches work.
      await expect(readdir(f.root)).resolves.toEqual(filesBefore);
    } finally { artifacts.value.close(); }
  });

  it("assesses a complete Specification with the actual classification policy", async () => {
    const f = await fixture(), spec = draft("api");
    await expect(f.tools.invoke("assess", { specification: spec }, principal)).resolves.toMatchObject({
      complexity: "complex", level: "full", humanApprovalRequired: true, clarificationRequired: false,
      suggestedRoles: ["architect", "planner"], availableCapabilities: { architect: ["repository.read"] },
      fastPath: { eligible: false, blockers: expect.arrayContaining(["not_trivial", "full_sdd"]) }
    });
    expect(f.assess).toHaveBeenCalledTimes(1);
    expect(f.assess).toHaveBeenCalledWith(spec);
    expect(spec.acceptanceCriteria[0]!.status).toBe("pending");
  });

  it("assess returns fastPath preview without definition-only blockers", async () => {
    const f = await fixture();
    const trivialSpec = draft("documentation");
    const trivialResult = await f.tools.invoke("assess", { specification: trivialSpec }, principal) as Record<string, unknown>;
    expect(trivialResult.fastPath).toEqual({
      eligible: true,
      blockers: []
    });

    const complexSpec = draft("api");
    const complexResult = await f.tools.invoke("assess", { specification: complexSpec }, principal) as Record<string, unknown>;
    const fastPath = complexResult.fastPath as { eligible: boolean; blockers: string[] };
    expect(fastPath.eligible).toBe(false);
    expect(fastPath.blockers).not.toContain("multi_task");
    expect(fastPath.blockers).not.toContain("task_approval");
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
