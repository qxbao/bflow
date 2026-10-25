import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaneBindingSchema,
  RoleMessageSchema,
  TddDecisionSchema,
  TestStrategySchema,
  WorkflowDefinitionSchema,
  type AgentRole,
  type PaneBinding
} from "@bflow/contracts";
import { SpecificationDocumentSchema } from "../../../specification/src/index.js";
import { AssessmentSchema } from "../../../test-strategy/src/index.js";
import { AssessmentSpecificationSchema } from "../../src/agentic/assessment-input.js";
import { RepositoryReadInputSchema, repositoryRead } from "../../src/agentic/repository-read.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { handleTaskLogTool } from "../../src/agentic/task-log-tools.js";
import { availableTools } from "../../src/agentic/host.js";
import {
  AssignmentContextInputSchema,
  InspectInputSchema,
  PlanningReferenceInputSchema,
  ReadProjectPolicyInputSchema,
  buildRoleBriefing,
  compactAssignmentContext,
  planningReferenceView,
  readProjectPolicy,
  summarizeInspectRun,
  summarizeInspectState
} from "../../src/agentic/mcp-output-views.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bflow-mcp-output-trim-"));
  tempDirs.push(dir);
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "packages", "sub"), { recursive: true });
  await mkdir(join(dir, ".github"), { recursive: true });
  await writeFile(
    join(dir, "src", "sample.ts"),
    [
      "import { readFile } from 'node:fs/promises';",
      "",
      "export interface SampleConfig {",
      "  readonly name: string;",
      "  readonly limit: number;",
      "}",
      "",
      "export async function loadSample(path: string): Promise<string> {",
      "  const raw = await readFile(path, 'utf8');",
      "  return raw.trim();",
      "}",
      "",
      "export class SampleRunner {",
      "  run(): boolean {",
      "    return true;",
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(dir, "AGENTS.md"),
    [
      "# Root Agent Policy",
      "",
      "Root introductory rules.",
      "",
      "## Stable Boundary",
      "",
      "Do not modify shared contracts without approval.",
      "",
      "## Verification Policy",
      "",
      "Always run tests before claiming completion."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(dir, "CLAUDE.md"),
    [
      "# Root Claude Instructions",
      "",
      "## Tool Discipline",
      "",
      "Prefer compact views."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(dir, ".github", "copilot-instructions.md"),
    "# Copilot Instructions\n\nFollow repository rules.\n",
    "utf8"
  );
  await writeFile(
    join(dir, "packages", "sub", "AGENTS.override.md"),
    [
      "# Subpackage Override Policy",
      "",
      "## Local Ownership",
      "",
      "Only edit files under packages/sub."
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(dir, ".env"), "SECRET_TOKEN=super-secret-value\n", "utf8");
  await execFileAsync("git", ["add", "src/sample.ts", "AGENTS.md", "CLAUDE.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function makeBinding(role: AgentRole, paneId = `pane-${role}`, worktreePath?: string): PaneBinding {
  return PaneBindingSchema.parse({
    schemaVersion: 2,
    bindingId: `bind-${role}`,
    sessionId: "session-1",
    role,
    paneId,
    tabId: "tab-1",
    workspaceId: "ws-1",
    agentId: `agent-${role}`,
    agentKind: "claude",
    provider: "claude",
    cwd: worktreePath ?? "/tmp/repo",
    isolationMode: "dedicated_pane",
    readOnlyWorkspace: role !== "developer",
    permanent: role !== "developer",
    transportState: "idle",
    boundAt: "2026-10-26T00:00:00.000Z",
    ...(worktreePath ? { worktreePath } : {}),
    session: { source: "herdr:claude", kind: "id", value: `sess-${role}` }
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("D5.1 planning_reference compact & schema_only views", () => {
  const sampleRunners = {
    mode: "automatic" as const,
    status: "detected" as const,
    profiles: [{ id: "vitest-unit", command: "pnpm test", method: "unit_test", levels: ["unit"] }]
  };
  const sampleSandbox = { status: "ready" as const };
  const sampleBehavioralCommands = [
    { id: "cmd-1", command: "pnpm test", method: "unit_test", levels: ["unit"], reporter: "node_tap" }
  ];

  it("validates planning_reference input strictly and rejects unknown keys or invalid enums", () => {
    expect(PlanningReferenceInputSchema.parse({ section: "specification" })).toEqual({ section: "specification" });
    expect(
      PlanningReferenceInputSchema.parse({ section: "all", view: "compact", includeRunners: false })
    ).toEqual({ section: "all", view: "compact", includeRunners: false });
    expect(() => PlanningReferenceInputSchema.parse({ section: "unknown" })).toThrow();
    expect(() => PlanningReferenceInputSchema.parse({ section: "specification", view: "invalid" })).toThrow();
    expect(() => PlanningReferenceInputSchema.parse({ section: "specification", extra: true })).toThrow();
  });

  it("returns compact and schema_only views under 6 KB for section='all' with runners included once", async () => {
    const compactAll = await planningReferenceView(
      { section: "all", view: "compact" },
      {
        runnerInfo: sampleRunners,
        verificationSandbox: sampleSandbox,
        behavioralCommands: sampleBehavioralCommands
      }
    );
    const serialized = JSON.stringify(compactAll);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(6000);
    expect(compactAll).toMatchObject({
      section: "all",
      view: "compact",
      mode: "automatic",
      status: "detected",
      verificationSandbox: sampleSandbox,
      behavioralCommands: sampleBehavioralCommands
    });
    const sections = (compactAll as Record<string, any>).sections;
    expect(sections.specification.schema.requiredFields).toContain("acceptanceCriteria");
    expect(sections.specification.schema.superRefineRules.length).toBeGreaterThan(0);
    expect(sections.specification.skeleton).toBeDefined();
    expect(() => AssessmentSpecificationSchema.parse(sections.specification.skeleton)).not.toThrow();
    expect(() => SpecificationDocumentSchema.parse(sections.specification.skeleton)).not.toThrow();
    expect(() =>
      AssessmentSchema.parse(sections.specification.skeleton.metadata.conditionalTdd)
    ).not.toThrow();
    expect(sections.specification.skeleton.status).toBe("draft");

    expect(sections.test_strategy.schema.requiredFields).toContain("criterionMappings");
    expect(sections.test_strategy.skeleton).toBeDefined();
    expect(() => AssessmentSchema.parse(sections.test_strategy.skeleton.conditionalTdd)).not.toThrow();
    expect(() => TestStrategySchema.parse(sections.test_strategy.skeleton.strategy)).not.toThrow();
    expect(() => TddDecisionSchema.parse(sections.test_strategy.skeleton.strategy.tddDecision)).not.toThrow();

    expect(sections.workflow.schema.requiredFields).toContain("tasks");
    expect(sections.workflow.skeleton).toBeDefined();
    expect(() => WorkflowDefinitionSchema.parse(sections.workflow.skeleton)).not.toThrow();
    expect(sections.workflow.skeleton.qualityGates).toEqual([]);
    expect(sections.workflow.skeleton.tasks[0].role).toBe("developer");
    expect(sections.workflow.skeleton.tasks[0].qualityGates).toEqual([]);
    expect(sections.workflow.skeleton.tasks[0].metadata.ownedPaths).toEqual(
      sections.specification.skeleton.affectedPaths
    );

    const schemaOnly = await planningReferenceView(
      { section: "specification", view: "schema_only", includeRunners: false },
      {
        runnerInfo: sampleRunners,
        verificationSandbox: sampleSandbox,
        behavioralCommands: sampleBehavioralCommands
      }
    );
    expect((schemaOnly as Record<string, any>).skeleton).toBeUndefined();
    expect((schemaOnly as Record<string, any>).profiles).toBeUndefined();
    expect((schemaOnly as Record<string, any>).verificationSandbox).toBeUndefined();
    expect((schemaOnly as Record<string, any>).schema.requiredFields).toContain("specId");
  });

  it("preserves exact default full references when view is omitted", async () => {
    const fullSpec = await planningReferenceView(
      { section: "specification" },
      {
        runnerInfo: sampleRunners,
        verificationSandbox: sampleSandbox,
        behavioralCommands: sampleBehavioralCommands
      }
    );
    const refs = (fullSpec as Record<string, any>).references;
    expect(Array.isArray(refs)).toBe(true);
    expect(refs).toHaveLength(3);
    expect(refs[0].source).toContain("docs.spec.json");
    expect(refs[0].content).toContain("specId");
    expect((fullSpec as Record<string, any>).verificationSandbox).toEqual(sampleSandbox);
  });
});

describe("D5.2 inspect summary/status/tasks/blockers views and scoped cursor", () => {
  const sampleRun = {
    runId: "run-1",
    status: "implementing",
    cancelled: false,
    coreCreated: true,
    maxIterations: 3,
    baseRevision: "abc1234",
    integrationKey: "int-1",
    supersededBy: undefined,
    error: undefined,
    pendingAction: { actionId: "act-1", kind: "capability_preflight", summary: "Needs check" },
    lastWorkflowRejection: { code: "schema_invalid", phase: "specification", message: "Invalid field" },
    conflictResolution: undefined,
    approvalKind: "design",
    approval: { requestId: "app-1", runId: "run-1", status: "approved" },
    decision: { decisionId: "dec-1", requestId: "app-1", status: "approved" },
    userDecisions: [{ decisionId: "ud-1", taskId: "task-1", status: "answered" }],
    supersededApprovals: [{ approval: { requestId: "app-0" }, supersededAt: "2026-10-25T00:00:00.000Z" }],
    workflowCycle: { cycleId: "wf-cyc-1", iteration: 1, maxIterations: 3, status: "running" },
    workflowChange: { commitHash: "abc1234", changedFiles: ["packages/runtime/src/agentic/host.ts"] },
    workflowVerificationPending: true,
    delegation: {
      delegationId: "del-1",
      messageId: "msg-del-1",
      sessionId: "sess-1",
      runId: "run-1",
      correlationId: "corr-1",
      title: "Implement feature X",
      objective: "Add compact MCP output views",
      kind: "feature",
      sddLevel: "full",
      priority: "normal",
      specificationId: "spec-1",
      requestedAt: "2026-10-26T00:00:00.000Z",
      metadata: { affectedPaths: ["packages/runtime/src/agentic/host.ts"], extraLargeField: "x".repeat(2000) }
    },
    definition: {
      schemaVersion: 2,
      id: "wf-1",
      name: "Workflow 1",
      tasks: [{ id: "task-1", name: "Task 1", role: "developer", dependencies: [] }]
    },
    workflowSpec: {
      approvalId: "app-1",
      decisionStatus: "approved",
      tddMode: "required",
      targetCommands: ["pnpm test"],
      specification: {
        specId: "spec-1",
        runId: "run-1",
        version: 1,
        title: "Feature X Spec",
        level: "full",
        status: "approved",
        summary: "Detailed summary",
        affectedPaths: ["packages/runtime/src/agentic/host.ts"],
        acceptanceCriteria: [
          { id: "ac-1", description: "Works", status: "verified", verificationMethod: "unit_test" }
        ],
        technicalDesign: { overview: "huge".repeat(1000) }
      }
    },
    tasks: [
      {
        taskId: "task-1",
        outboundIds: ["msg-1", "msg-2"],
        verificationPending: false,
        writerReleased: false,
        worktrees: { developerWorktreePath: "/tmp/wt-1", branchName: "bflow/task-1" },
        reworkResolutions: [{ findingId: "f-1", disposition: "addressed" }],
        cycle: { cycleId: "cyc-1", iteration: 1, maxIterations: 3, status: "running" },
        result: { status: "succeeded", executionId: "exec-1" },
        changeSet: { commitHash: "def5678", changedFiles: ["packages/runtime/src/agentic/host.ts"] },
        spec: {
          request: {
            requestId: "req-1",
            runId: "run-1",
            taskId: "task-1",
            attemptId: "att-1",
            role: "developer",
            context: { hugeDuplicateEnvelope: "y".repeat(4000) }
          },
          decision: { mode: "required", requiresFailingTestFirst: true },
          strategy: {
            strategyId: "strat-1",
            mode: "required",
            rationale: "Core logic",
            requiredVerificationMethods: ["unit_test"],
            targetCommands: ["pnpm test"],
            criteriaMappings: [{ criterionId: "ac-1", verificationMethods: ["unit_test"], rationale: "z".repeat(1000) }]
          }
        }
      }
    ]
  };

  it("validates inspect input strictly", () => {
    expect(InspectInputSchema.parse({})).toEqual({});
    expect(InspectInputSchema.parse({ runId: "run-1", view: "summary", taskId: "task-1" })).toEqual({
      runId: "run-1",
      view: "summary",
      taskId: "task-1"
    });
    expect(() => InspectInputSchema.parse({ view: "unknown" })).toThrow();
    expect(() => InspectInputSchema.parse({ runId: "run-1", unknownKey: 1 })).toThrow();
  });

  it("produces summary view with all required fields while omitting full spec/envelope bloat, and supports cursor unchanged detection", () => {
    const summary = summarizeInspectRun(sampleRun, { runId: "run-1", view: "summary" }) as Record<string, any>;
    expect(summary.runId).toBe("run-1");
    expect(summary.status).toBe("implementing");
    expect(summary.baseRevision).toBe("abc1234");
    expect(summary.pendingAction).toEqual(sampleRun.pendingAction);
    expect(summary.lastWorkflowRejection).toEqual(sampleRun.lastWorkflowRejection);
    expect(summary.approval).toEqual(sampleRun.approval);
    expect(summary.decision).toEqual(sampleRun.decision);
    expect(summary.userDecisions).toEqual(sampleRun.userDecisions);
    expect(summary.supersededApprovals).toEqual(sampleRun.supersededApprovals);
    expect(summary.workflowCycle).toEqual(sampleRun.workflowCycle);
    expect(summary.workflowChange).toEqual(sampleRun.workflowChange);
    expect(summary.workflowVerificationPending).toBe(true);
    expect(summary.delegation).toMatchObject({
      delegationId: "del-1",
      messageId: "msg-del-1",
      requestedAt: "2026-10-26T00:00:00.000Z",
      sessionId: "sess-1",
      runId: "run-1"
    });
    expect(summary.workflowSpec).toMatchObject({
      specificationId: "spec-1",
      title: "Feature X Spec",
      level: "full",
      status: "approved",
      approvalId: "app-1",
      decisionStatus: "approved",
      tddMode: "required",
      targetCommands: ["pnpm test"],
      criteriaIds: ["ac-1"],
      taskCount: 1
    });
    expect(summary.workflowSpec.specification).toBeUndefined();
    expect(summary.tasks).toHaveLength(1);
    expect(summary.tasks[0].taskId).toBe("task-1");
    expect(summary.tasks[0].outboundIds).toEqual(["msg-1", "msg-2"]);
    expect(summary.tasks[0].reworkResolutions).toEqual(sampleRun.tasks[0]!.reworkResolutions);
    expect(summary.tasks[0].spec.request.context).toBeUndefined();
    expect(typeof summary.cursor).toBe("string");

    // Calling again with same cursor returns unchanged: true
    const second = summarizeInspectRun(sampleRun, {
      runId: "run-1",
      view: "summary",
      cursor: summary.cursor
    }) as Record<string, any>;
    expect(second).toEqual({
      runId: "run-1",
      status: "implementing",
      unchanged: true,
      cursor: summary.cursor
    });

    // Rejects cursor from a different view or runId or malformed cursor
    expect(() =>
      summarizeInspectRun(sampleRun, { runId: "run-1", view: "status", cursor: summary.cursor })
    ).toThrow(/cursor/i);
    expect(() =>
      summarizeInspectRun({ ...sampleRun, runId: "run-2" }, { runId: "run-2", view: "summary", cursor: summary.cursor })
    ).toThrow(/cursor/i);
    expect(() =>
      summarizeInspectRun(sampleRun, { runId: "run-1", view: "summary", cursor: "malformed-cursor" })
    ).toThrow(/cursor/i);
  });

  it("supports status, tasks, blockers views and taskId filtering on global and single-run state", () => {
    const statusView = summarizeInspectRun(sampleRun, { runId: "run-1", view: "status" }) as Record<string, any>;
    expect(statusView.runId).toBe("run-1");
    expect(statusView.taskCount).toBe(1);
    expect(statusView.tasks).toBeUndefined();

    const blockersView = summarizeInspectRun(sampleRun, { runId: "run-1", view: "blockers" }) as Record<string, any>;
    expect(blockersView.pendingAction).toEqual(sampleRun.pendingAction);
    expect(blockersView.lastWorkflowRejection).toEqual(sampleRun.lastWorkflowRejection);
    expect(blockersView.workflowCycle).toEqual(sampleRun.workflowCycle);
    expect(blockersView.workflowChange).toEqual(sampleRun.workflowChange);
    expect(blockersView.workflowVerificationPending).toBe(true);
    expect(blockersView.supersededApprovals).toEqual(sampleRun.supersededApprovals);

    expect(() =>
      summarizeInspectRun(sampleRun, { runId: "run-1", view: "tasks", taskId: "non-existent" })
    ).toThrow(/Unknown taskId/);

    const globalSummary = summarizeInspectState(
      { runs: [sampleRun], outbound: [{ status: "accepted", taskId: "task-1" }], inbox: [] },
      { view: "summary" }
    ) as Record<string, any>;
    expect(globalSummary.runs).toHaveLength(1);
    expect(typeof globalSummary.cursor).toBe("string");
    const globalUnchanged = summarizeInspectState(
      { runs: [sampleRun], outbound: [{ status: "accepted", taskId: "task-1" }], inbox: [] },
      { view: "summary", cursor: globalSummary.cursor }
    );
    expect(globalUnchanged).toEqual({
      unchanged: true,
      cursor: globalSummary.cursor,
      runCount: 1
    });
  });
});

describe("D5.3 repository_read stat, outline, and line-range views", () => {
  it("supports view='stat', view='outline', and startLine/endLine while preserving default read and security boundaries", async () => {
    const repo = await makeTempRepo();

    // Default read unchanged
    const defaultRead = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts"
    })) as Record<string, any>;
    expect(defaultRead.op).toBe("read");
    expect(defaultRead.path).toBe("src/sample.ts");
    expect(defaultRead.content).toContain("export interface SampleConfig");
    expect(defaultRead.view).toBeUndefined();

    // Stat view
    const statView = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts",
      view: "stat"
    })) as Record<string, any>;
    expect(statView).toMatchObject({
      op: "read",
      view: "stat",
      path: "src/sample.ts",
      totalBytes: defaultRead.bytes,
      lineCount: 17,
      truncated: false
    });
    expect(statView.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(statView.content).toBeUndefined();

    // Outline view on TypeScript file
    const outlineTs = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts",
      view: "outline"
    })) as Record<string, any>;
    expect(outlineTs.view).toBe("outline");
    expect(outlineTs.sha256).toBe(statView.sha256);
    expect(outlineTs.outline.map((item: any) => item.text)).toEqual([
      "export interface SampleConfig {",
      "export async function loadSample(path: string): Promise<string> {",
      "export class SampleRunner {"
    ]);

    // Outline view on Markdown file
    const outlineMd = (await repositoryRead(repo, {
      op: "read",
      path: "AGENTS.md",
      view: "outline"
    })) as Record<string, any>;
    expect(outlineMd.outline.map((item: any) => item.text)).toEqual([
      "# Root Agent Policy",
      "## Stable Boundary",
      "## Verification Policy"
    ]);

    // Line range read
    const lineSlice = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts",
      startLine: 3,
      endLine: 6
    })) as Record<string, any>;
    expect(lineSlice.startLine).toBe(3);
    expect(lineSlice.endLine).toBe(6);
    expect(lineSlice.nextStartLine).toBe(7);
    expect(lineSlice.content.split("\n")).toEqual([
      "export interface SampleConfig {",
      "  readonly name: string;",
      "  readonly limit: number;",
      "}"
    ]);

    // view="full" alias behaves identically to view="content"
    const fullView = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts",
      view: "full"
    })) as Record<string, any>;
    expect(fullView).toEqual(defaultRead);

    // Line-range read truncated by byte limit adjusts endLine and nextStartLine accurately
    const truncatedSlice = (await repositoryRead(repo, {
      op: "read",
      path: "src/sample.ts",
      startLine: 3,
      endLine: 6,
      limit: 31
    })) as Record<string, any>;
    expect(truncatedSlice.startLine).toBe(3);
    expect(truncatedSlice.endLine).toBe(3);
    expect(truncatedSlice.nextStartLine).toBe(4);
    expect(truncatedSlice.truncated).toBe(true);

    // CRLF file byteOffset and nextOffset accuracy
    const crlfContent = ["export const first = 1;", "export function second() {", "  return first;", "}"].join("\r\n") + "\r\n";
    await writeFile(join(repo, "src", "crlf.ts"), crlfContent, "utf8");
    const crlfOutline = (await repositoryRead(repo, {
      op: "read",
      path: "src/crlf.ts",
      view: "outline"
    })) as Record<string, any>;
    expect(crlfOutline.outline).toEqual([
      { line: 1, byteOffset: 0, text: "export const first = 1;" },
      { line: 2, byteOffset: Buffer.byteLength("export const first = 1;\r\n", "utf8"), text: "export function second() {" }
    ]);
    const crlfLine1 = (await repositoryRead(repo, {
      op: "read",
      path: "src/crlf.ts",
      startLine: 1,
      endLine: 1
    })) as Record<string, any>;
    expect(crlfLine1.offset).toBe(0);
    expect(crlfLine1.nextOffset).toBe(Buffer.byteLength("export const first = 1;\r\n", "utf8"));
    const crlfFromNextOffset = (await repositoryRead(repo, {
      op: "read",
      path: "src/crlf.ts",
      offset: crlfLine1.nextOffset
    })) as Record<string, any>;
    expect(crlfFromNextOffset.content.startsWith("export function second() {")).toBe(true);

    // Validation & security checks
    expect(() =>
      RepositoryReadInputSchema.parse({ op: "list", view: "stat" })
    ).toThrow();
    expect(() =>
      RepositoryReadInputSchema.parse({ op: "read", path: "src/sample.ts", startLine: 10, endLine: 5 })
    ).toThrow();
    await expect(
      repositoryRead(repo, { op: "read", path: ".env", view: "stat" })
    ).rejects.toThrow(/sensitive/i);

    await symlink(join(repo, "src", "sample.ts"), join(repo, "src", "link.ts"));
    await expect(
      repositoryRead(repo, { op: "read", path: "src/link.ts", view: "outline" })
    ).rejects.toThrow();
  });
});

describe("D5.4 assignment_context compact/active_only and surveyView modes", () => {
  const sampleMessage = RoleMessageSchema.parse({
    schema_version: 2,
    message_id: "msg-active",
    correlation_id: "corr-1",
    causation_id: "cause-1",
    run_id: "run-1",
    sender: { role: "coordinator", agent_id: "agent-coordinator", pane_id: "pane-coordinator" },
    recipient: { role: "developer", agent_id: "agent-developer", pane_id: "pane-developer" },
    type: "task.assignment",
    payload: {
      taskId: "task-1",
      reworkContext: {
        reworkGeneration: 1,
        findings: [{ findingId: "finding-1", severity: "error", message: "Fix bug" }]
      },
      specification: { specId: "spec-1", hugeDuplicate: "a".repeat(3000) },
      artifacts: [{ artifactId: "art-1" }],
      testStrategy: {
        mode: "required",
        rationale: "TDD",
        metadata: { hugeMeta: "b".repeat(2000) }
      }
    },
    artifact_references: [],
    occurred_at: "2026-10-26T00:00:00.000Z",
    idempotency_key: "idem-1"
  });

  const fullReply = {
    repositorySurvey: {
      status: "ready",
      assignmentMessageId: "msg-active",
      runId: "run-1",
      taskId: "task-1",
      scopeSource: "task_owned_paths",
      expectedBaseRevision: "abc1234",
      freshness: { valid: true, reason: "fresh" },
      gitnexus: { status: "ready" },
      authority: "supplementary_read_context_only",
      context: {
        repositoryIdentity: { rootPath: "/tmp/wt", gitCommitHash: "abc1234", branch: "bflow/task-1", isDirty: false },
        role: "developer",
        taskId: "task-1",
        runId: "run-1",
        specId: "spec-1",
        contextHash: "hash-ctx-1",
        fileFingerprints: { "src/sample.ts": "0".repeat(64) },
        specVersion: 1,
        specFingerprint: "f".repeat(64),
        totalBytes: 1200,
        includedFiles: ["src/sample.ts"],
        excludedFileCount: 2,
        preparedAt: "2026-10-26T00:00:00.000Z",
        adrSummaries: [{ id: "0001", title: "Contract Hardening", path: "docs/adr/0001.md" }],
        adrFingerprints: { "docs/adr/0001.md": "1".repeat(64) },
        artifactReferences: [],
        formattedPromptContext: "### Repository Survey\n" + "line\n".repeat(500)
      }
    },
    policyEvidence: [{ phase: "red", accepted: true }],
    policyEvidenceNote: "Stored Runtime phase receipts.",
    toolActions: [{ actionId: "routine_command", toolId: "rtk" }],
    toolActionsNote: "Scoped tool actions.",
    assignments: [
      {
        status: "released",
        taskId: "task-old",
        attemptId: "att-0",
        handle: { requestId: "req-0" },
        lease: { leaseId: "lease-0", fencingToken: 1 },
        envelopeDigest: "dig-0",
        message: { ...sampleMessage, message_id: "msg-old", payload: { taskId: "task-old" } }
      },
      {
        status: "accepted",
        taskId: "task-1",
        attemptId: "att-1",
        handle: { requestId: "req-1" },
        lease: { leaseId: "lease-1", fencingToken: 2 },
        envelopeDigest: "dig-1",
        message: sampleMessage
      }
    ],
    runs: [
      {
        runId: "run-1",
        status: "implementing",
        cancelled: false,
        coreCreated: true,
        baseRevision: "abc1234",
        integrationKey: "int-1",
        maxIterations: 3,
        lastWorkflowRejection: { code: "missing_test_mapping", reason: "Add test mapping" },
        approval: { requestId: "app-1", status: "approved" },
        decision: { decisionId: "dec-1", status: "approved" },
        userDecisions: [{ decisionId: "ud-1", status: "answered" }],
        workflowCycle: { cycleId: "wf-c-1", iteration: 1, maxIterations: 3, status: "running" },
        workflowChange: { commitHash: "abc1234", changedFiles: ["src/sample.ts"] },
        workflowVerificationPending: false,
        delegation: {
          delegationId: "del-1",
          messageId: "msg-del-1",
          correlationId: "corr-1",
          sessionId: "sess-1",
          runId: "run-1",
          title: "Feature",
          objective: "Build it",
          sddLevel: "full",
          specificationId: "spec-1",
          requestedAt: "2026-10-26T00:00:00.000Z",
          idempotencyKey: "idem-del-1",
          metadata: { affectedPaths: ["src/sample.ts"] }
        },
        workflowSpec: {
          specification: {
            specId: "spec-1",
            title: "Feature Spec",
            level: "full",
            summary: "Summary",
            affectedPaths: ["src/sample.ts"],
            acceptanceCriteria: [
              { id: "ac-1", description: "Pass", status: "pending", verificationMethod: "unit_test" }
            ]
          }
        },
        tasks: [
          {
            taskId: "task-1",
            writerReleased: false,
            worktrees: { developerWorktreePath: "/tmp/wt" },
            reworkResolutions: [{ findingId: "finding-1", disposition: "addressed" }],
            cycle: { cycleId: "c-1", iteration: 1, maxIterations: 3, status: "running" },
            spec: {
              request: {
                requestId: "req-1",
                runId: "run-1",
                taskId: "task-1",
                attemptId: "att-1",
                role: "developer",
                context: sampleMessage
              },
              decision: { mode: "required" },
              strategy: {
                mode: "required",
                rationale: "TDD",
                tddDecision: { mode: "required", requiresFailingTestFirst: true },
                requiredTestLevels: ["unit"],
                requiredVerificationMethods: ["unit_test"],
                targetCommands: ["pnpm test"],
                criterionMappings: [
                  { criterionId: "ac-1", requiredMethods: ["unit_test"], testNames: ["suite passes"] }
                ]
              }
            }
          }
        ]
      }
    ]
  };

  it("validates assignment_context parameters while allowing and ignoring paths", () => {
    expect(AssignmentContextInputSchema.parse({ paths: ["/untrusted"] })).toEqual({ paths: ["/untrusted"] });
    expect(
      AssignmentContextInputSchema.parse({ view: "compact", surveyView: "summary", includeReleased: false })
    ).toEqual({ view: "compact", surveyView: "summary", includeReleased: false });
    expect(() => AssignmentContextInputSchema.parse({ view: "invalid" })).toThrow();
    expect(() => AssignmentContextInputSchema.parse({ extraField: 123 })).toThrow();
  });

  it("trims duplicate payloads, released assignments, and formattedPromptContext in compact mode while preserving envelope IDs, lease, reworkContext, policyEvidence, and toolActions", () => {
    const compact = compactAssignmentContext(fullReply, {
      view: "compact",
      surveyView: "summary",
      includeReleased: false
    }) as Record<string, any>;

    expect(compact.assignments).toHaveLength(1);
    const active = compact.assignments[0];
    expect(active.status).toBe("accepted");
    expect(active.lease).toEqual({ leaseId: "lease-1", fencingToken: 2 });
    expect(active.message.message_id).toBe("msg-active");
    expect(active.message.correlation_id).toBe("corr-1");
    expect(active.message.causation_id).toBe("cause-1");
    expect(active.message.payload.reworkContext).toEqual({
      reworkGeneration: 1,
      findings: [{ findingId: "finding-1", severity: "error", message: "Fix bug" }]
    });
    expect(active.message.payload.specification).toBeUndefined();
    expect(active.message.payload.testStrategy.metadata).toBeUndefined();

    expect(compact.repositorySurvey.context.formattedPromptContext).toBeUndefined();
    expect(compact.repositorySurvey.context.contextHash).toBe("hash-ctx-1");
    expect(compact.repositorySurvey.freshness).toEqual({ valid: true, reason: "fresh" });
    expect(compact.repositorySurvey.gitnexus).toEqual({ status: "ready" });
    expect(compact.policyEvidence).toEqual(fullReply.policyEvidence);
    expect(compact.toolActions).toEqual(fullReply.toolActions);
    expect(compact.runs[0].delegation).toMatchObject({
      delegationId: "del-1",
      messageId: "msg-del-1",
      correlationId: "corr-1",
      sessionId: "sess-1",
      requestedAt: "2026-10-26T00:00:00.000Z"
    });
    expect(compact.runs[0].lastWorkflowRejection).toEqual(fullReply.runs[0]!.lastWorkflowRejection);
    expect(compact.runs[0].approval).toEqual(fullReply.runs[0]!.approval);
    expect(compact.runs[0].decision).toEqual(fullReply.runs[0]!.decision);
    expect(compact.runs[0].userDecisions).toEqual(fullReply.runs[0]!.userDecisions);
    expect(compact.runs[0].workflowCycle).toEqual(fullReply.runs[0]!.workflowCycle);
    expect(compact.runs[0].tasks[0].spec.request.context).toBeUndefined();
    expect(compact.runs[0].tasks[0].spec.request.requestId).toBe("req-1");
    expect(compact.runs[0].tasks[0].spec.strategy).toMatchObject({
      mode: "required",
      tddDecision: { mode: "required", requiresFailingTestFirst: true },
      requiredTestLevels: ["unit"],
      requiredVerificationMethods: ["unit_test"],
      targetCommands: ["pnpm test"],
      criterionMappings: [
        { criterionId: "ac-1", requiredMethods: ["unit_test"], testNames: ["suite passes"] }
      ]
    });
    expect(compact.runs[0].tasks[0].reworkResolutions).toEqual([
      { findingId: "finding-1", disposition: "addressed" }
    ]);

    const anchorsOnly = compactAssignmentContext(fullReply, {
      view: "compact",
      surveyView: "anchors_only"
    }) as Record<string, any>;
    expect(anchorsOnly.repositorySurvey).toMatchObject({
      status: "ready",
      assignmentMessageId: "msg-active",
      runId: "run-1",
      taskId: "task-1",
      scopeSource: "task_owned_paths",
      expectedBaseRevision: "abc1234",
      freshness: { valid: true, reason: "fresh" },
      gitnexus: { status: "ready" },
      authority: "supplementary_read_context_only",
      contextHash: "hash-ctx-1",
      includedFiles: ["src/sample.ts"],
      fileFingerprints: { "src/sample.ts": "0".repeat(64) }
    });
    expect(anchorsOnly.repositorySurvey.context).toBeUndefined();
  });
});

describe("D5.5 read_task_log incremental cursor and compact view", () => {
  it("returns incremental entries after cursor within exact runId/taskId scope and rejects cross-scope cursors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-task-log-trim-"));
    tempDirs.push(dir);
    const log = TaskActivityLog.open(join(dir, "task-activity.jsonl"));
    await log.record({
      kind: "progress",
      role: "developer",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "att-1",
      artifacts: ["artifact://sha256/abc"],
      action: "first step"
    });
    await log.record({ kind: "progress", role: "developer", runId: "run-2", taskId: "task-2", action: "other run step" });
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "second step" });

    const state = {
      runs: [{ runId: "run-1", status: "implementing", tasks: [{ taskId: "task-1" }] }],
      outbound: [
        {
          status: "accepted",
          taskId: "task-1",
          attemptId: "att-1",
          handle: {
            target: {
              paneId: "pane-developer",
              agentId: "agent-developer",
              session: { source: "herdr:claude", kind: "id", value: "sess-developer" }
            }
          },
          message: { type: "task.assignment", run_id: "run-1", payload: { taskId: "task-1" } }
        }
      ]
    };

    const devBinding = makeBinding("developer");

    // Default call preserves exact backward-compatible keys (no nextCursor unless cursor/view requested)
    const defaultRes = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1" }
    )) as Record<string, any>;
    expect(defaultRes.entries.map((e: any) => e.action)).toEqual(["first step", "second step"]);
    expect(defaultRes.nextCursor).toBeUndefined();

    // Compact view returns nextCursor, truncated, hasMore, and preserves id, attemptId, artifacts
    const page1 = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact" }
    )) as Record<string, any>;
    expect(page1.entries).toHaveLength(2);
    expect(typeof page1.entries[0].id).toBe("string");
    expect(page1.entries[0].attemptId).toBe("att-1");
    expect(page1.entries[0].artifacts).toEqual(["artifact://sha256/abc"]);
    // Omit runId and taskId when caller filtered by both
    expect(page1.entries[0].runId).toBeUndefined();
    expect(page1.entries[0].taskId).toBeUndefined();
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.hasMore).toBe(false);
    expect(page1.truncated).toBe(false);

    // Coordinator reading run-wide without taskId filter retains taskId in compact entries
    const coordBinding = makeBinding("coordinator");
    const coordCompact = (await handleTaskLogTool(
      { role: "coordinator", binding: coordBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", view: "compact" }
    )) as Record<string, any>;
    expect(coordCompact.entries[0].taskId).toBe("task-1");
    expect(coordCompact.entries[0].runId).toBeUndefined();

    // No new entries -> empty delta with same nextCursor
    const emptyDelta = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact", cursor: page1.nextCursor }
    )) as Record<string, any>;
    expect(emptyDelta.entries).toEqual([]);
    expect(emptyDelta.nextCursor).toBe(page1.nextCursor);
    expect(emptyDelta.hasMore).toBe(false);

    // Record 4 new steps on run-1/task-1 and paginate forward with lines: 2 without skipping any entry
    await log.record({ kind: "progress", role: "developer", runId: "run-2", taskId: "task-2", action: "other run 2" });
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "third step" });
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "fourth step" });
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "fifth step" });

    const deltaPage1 = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact", cursor: page1.nextCursor, lines: 2 }
    )) as Record<string, any>;
    expect(deltaPage1.entries.map((e: any) => e.action)).toEqual(["third step", "fourth step"]);
    expect(deltaPage1.hasMore).toBe(true);
    expect(deltaPage1.truncated).toBe(true);

    const deltaPage2 = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact", cursor: deltaPage1.nextCursor, lines: 2 }
    )) as Record<string, any>;
    expect(deltaPage2.entries.map((e: any) => e.action)).toEqual(["fifth step"]);
    expect(deltaPage2.hasMore).toBe(false);
    expect(deltaPage2.truncated).toBe(false);

    // Rejects non-integer / coerced bounds and cross-scope cursors
    await expect(
      handleTaskLogTool(
        { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
        "read_task_log",
        { runId: "run-1", taskId: "task-1", lines: true as any }
      )
    ).rejects.toThrow("bounds");
    await expect(
      handleTaskLogTool(
        { role: "coordinator", binding: coordBinding, activityLog: log, inspect: async () => state },
        "read_task_log",
        { runId: "run-1", taskId: "task-1", cursor: page1.nextCursor }
      )
    ).rejects.toThrow(/cursor/i);
  });
});

describe("D4 read_project_policy hierarchical policy discovery, views, and knownDigests", () => {
  it("exposes read_project_policy to all non-conversation roles and denies conversation", () => {
    expect(availableTools("conversation").some(t => t.name === "read_project_policy")).toBe(false);
    for (const role of [
      "coordinator",
      "specifier",
      "architect",
      "planner",
      "developer",
      "reviewer",
      "qa",
      "tester",
      "security"
    ] as const) {
      const tool = availableTools(role).find(t => t.name === "read_project_policy");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false
      });
    }
  });

  it("discovers root and nested policy files in deterministic order and supports full, toc, section, digests, and knownDigests", async () => {
    const repo = await makeTempRepo();

    // Root discovery
    const fullRoot = await readProjectPolicy(repo, {});
    expect(fullRoot.documents.map(d => d.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".github/copilot-instructions.md"
    ]);
    expect(fullRoot.documents[0]!.content).toContain("## Stable Boundary");

    // Nested directory discovery includes root + nested override
    const nestedToc = await readProjectPolicy(repo, {
      filePath: "packages/sub/index.ts",
      view: "toc"
    });
    expect(nestedToc.documents.map(d => d.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".github/copilot-instructions.md",
      "packages/sub/AGENTS.override.md"
    ]);
    expect(nestedToc.documents[0]!.content).toBeUndefined();
    expect(nestedToc.documents[0]!.headings?.map(h => h.text)).toEqual([
      "Root Agent Policy",
      "Stable Boundary",
      "Verification Policy"
    ]);

    // Section view extracts only the matching heading section
    const sectionRes = await readProjectPolicy(repo, {
      filePath: "packages/sub",
      view: "section",
      heading: "Stable Boundary"
    });
    const agentsDoc = sectionRes.documents.find(d => d.path === "AGENTS.md")!;
    expect(agentsDoc.section).toContain("## Stable Boundary");
    expect(agentsDoc.section).toContain("Do not modify shared contracts");
    expect(agentsDoc.section).not.toContain("## Verification Policy");

    // Digests view & knownDigests deduplication
    const digestsRes = await readProjectPolicy(repo, { view: "digests" });
    const knownDigests = Object.fromEntries(digestsRes.documents.map(d => [d.path, d.sha256]));
    const deduped = await readProjectPolicy(repo, { view: "full", knownDigests });
    for (const doc of deduped.documents) {
      expect(doc.unchanged).toBe(true);
      expect(doc.content).toBeUndefined();
    }

    // Security: rejects traversal and symlinks
    await expect(readProjectPolicy(repo, { filePath: "../outside" })).rejects.toThrow(/escapes|relative/i);
    await expect(readProjectPolicy(repo, { filePath: "packages/../../outside" })).rejects.toThrow(/escapes|relative/i);
    await expect(readProjectPolicy(repo, { filePath: "packages\\sub" })).rejects.toThrow(/escapes|relative/i);
    await rm(join(repo, "packages", "sub", "AGENTS.override.md"));
    await symlink(join(repo, ".env"), join(repo, "packages", "sub", "AGENTS.override.md"));
    await expect(readProjectPolicy(repo, { filePath: "packages/sub" })).rejects.toThrow();

    // Enforces maxTotalBytes on view='section' and multi-byte UTF-8 safe truncation without U+FFFD
    await writeFile(
      join(repo, "AGENTS.md"),
      "# Root\n\n## Unicode Section\n\n" + "Tiếng Việt chuẩn xác ".repeat(80) + "\n",
      "utf8"
    );
    const boundedSection = await readProjectPolicy(
      repo,
      { view: "section", heading: "Unicode Section" },
      { maxTotalBytes: 200 }
    );
    expect(boundedSection.truncated).toBe(true);
    expect(boundedSection.totalBytes).toBeLessThanOrEqual(200);
    expect(boundedSection.documents[0]!.section).not.toContain("\uFFFD");

    // Validation: view='section' requires heading
    expect(() => ReadProjectPolicyInputSchema.parse({ view: "section" })).toThrow(/heading/i);
  });
});

describe("D4 role briefing and tool discovery discipline", () => {
  it("builds role-scoped briefing with compact view guidance and anti-ALL_TOOLS instructions", () => {
    const coordinatorBrief = buildRoleBriefing("coordinator", "claude");
    expect(coordinatorBrief).toContain("ALL_TOOLS");
    expect(coordinatorBrief).toContain("JSON.parse(res.content[0].text)");
    expect(coordinatorBrief).toContain("planning_reference");
    expect(coordinatorBrief).toContain("read_project_policy");
    expect(coordinatorBrief).toContain("assignment_context");
    expect(coordinatorBrief).toContain("mcp__bflow__propose_workflow");
    expect(coordinatorBrief).toContain("mcp__bflow__tick");

    const developerBrief = buildRoleBriefing("developer", "codex");
    expect(developerBrief).toContain("read_project_policy");
    expect(developerBrief).toContain("assignment_context");
    expect(developerBrief).toContain("read_task_log");
  });
});
