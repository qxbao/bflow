import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaneBindingSchema,
  RoleMessageSchema,
  type AgentRole,
  type PaneBinding
} from "@bflow/contracts";
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
    expect(sections.test_strategy.schema.requiredFields).toContain("criteriaMappings");
    expect(sections.test_strategy.skeleton).toBeDefined();
    expect(sections.workflow.schema.requiredFields).toContain("tasks");
    expect(sections.workflow.skeleton).toBeDefined();

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
    delegation: {
      requestId: "del-1",
      sessionId: "sess-1",
      runId: "run-1",
      correlationId: "corr-1",
      title: "Implement feature X",
      objective: "Add compact MCP output views",
      kind: "feature",
      sddLevel: "full",
      priority: "normal",
      specificationId: "spec-1",
      createdAt: "2026-10-26T00:00:00.000Z",
      metadata: { affectedPaths: ["packages/runtime/src/agentic/host.ts"], extraLargeField: "x".repeat(2000) }
    },
    workflowSpec: {
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
      },
      definition: {
        id: "wf-1",
        name: "Workflow 1",
        version: 1,
        tasks: [{ id: "task-1", name: "Task 1", agentRole: "developer", dependencies: [] }]
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
    expect(summary.workflowSpec).toMatchObject({
      specificationId: "spec-1",
      title: "Feature X Spec",
      level: "full",
      status: "approved",
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
    expect(lineSlice.content.split("\n")).toEqual([
      "export interface SampleConfig {",
      "  readonly name: string;",
      "  readonly limit: number;",
      "}"
    ]);

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
      context: {
        formattedPromptContext: "### Repository Survey\n" + "line\n".repeat(500),
        survey: {
          surveyId: "surv-1",
          runId: "run-1",
          taskId: "task-1",
          role: "developer",
          headRevision: "abc1234",
          worktreePath: "/tmp/wt",
          anchors: [{ path: "src/sample.ts", sha256: "0".repeat(64), reason: "owned" }],
          omittedScope: [],
          uncertainties: ["none"],
          limits: { maxFiles: 20 }
        }
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
        baseRevision: "abc1234",
        maxIterations: 3,
        delegation: {
          runId: "run-1",
          title: "Feature",
          objective: "Build it",
          sddLevel: "full",
          specificationId: "spec-1",
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
                requiredVerificationMethods: ["unit_test"],
                targetCommands: ["pnpm test"]
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
    expect(compact.repositorySurvey.context.survey.surveyId).toBe("surv-1");
    expect(compact.policyEvidence).toEqual(fullReply.policyEvidence);
    expect(compact.toolActions).toEqual(fullReply.toolActions);
    expect(compact.runs[0].tasks[0].spec.request.context).toBeUndefined();
    expect(compact.runs[0].tasks[0].spec.request.requestId).toBe("req-1");
    expect(compact.runs[0].tasks[0].reworkResolutions).toEqual([
      { findingId: "finding-1", disposition: "addressed" }
    ]);

    const anchorsOnly = compactAssignmentContext(fullReply, {
      view: "compact",
      surveyView: "anchors_only"
    }) as Record<string, any>;
    expect(anchorsOnly.repositorySurvey.anchors).toEqual([
      { path: "src/sample.ts", sha256: "0".repeat(64), reason: "owned" }
    ]);
    expect(anchorsOnly.repositorySurvey.context).toBeUndefined();
  });
});

describe("D5.5 read_task_log incremental cursor and compact view", () => {
  it("returns incremental entries after cursor within exact runId/taskId scope and rejects cross-scope cursors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-task-log-trim-"));
    tempDirs.push(dir);
    const log = TaskActivityLog.open(join(dir, "task-activity.jsonl"));
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "first step" });
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

    // Compact view returns nextCursor and compact entries
    const page1 = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact" }
    )) as Record<string, any>;
    expect(page1.entries).toHaveLength(2);
    expect(page1.entries[0].id).toBeUndefined();
    expect(page1.entries[0].runId).toBeUndefined();
    expect(typeof page1.nextCursor).toBe("string");

    // No new entries -> empty delta with same nextCursor
    const emptyDelta = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact", cursor: page1.nextCursor }
    )) as Record<string, any>;
    expect(emptyDelta.entries).toEqual([]);
    expect(emptyDelta.nextCursor).toBe(page1.nextCursor);

    // Add a new step on run-1/task-1 and another on run-2/task-2
    await log.record({ kind: "progress", role: "developer", runId: "run-2", taskId: "task-2", action: "other run 2" });
    await log.record({ kind: "progress", role: "developer", runId: "run-1", taskId: "task-1", action: "third step" });

    const delta = (await handleTaskLogTool(
      { role: "developer", binding: devBinding, activityLog: log, inspect: async () => state },
      "read_task_log",
      { runId: "run-1", taskId: "task-1", view: "compact", cursor: page1.nextCursor }
    )) as Record<string, any>;
    expect(delta.entries.map((e: any) => e.action)).toEqual(["third step"]);
    expect(delta.nextCursor).not.toBe(page1.nextCursor);

    // Rejects cursor from another role or runId/taskId scope
    const coordBinding = makeBinding("coordinator");
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
    await rm(join(repo, "packages", "sub", "AGENTS.override.md"));
    await symlink(join(repo, ".env"), join(repo, "packages", "sub", "AGENTS.override.md"));
    await expect(readProjectPolicy(repo, { filePath: "packages/sub" })).rejects.toThrow();

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

    const developerBrief = buildRoleBriefing("developer", "codex");
    expect(developerBrief).toContain("read_project_policy");
    expect(developerBrief).toContain("assignment_context");
    expect(developerBrief).toContain("read_task_log");
  });
});
