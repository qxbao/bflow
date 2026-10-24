import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationRequestSchema, PaneBindingSchema } from "@bflow/contracts";
import { AssignmentSurvey, assignmentsForBinding } from "../../src/agentic/assignment-survey.js";
import { draft } from "../../../specification/test/fixtures.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(role: "coordinator" | "architect" | "planner" | "specifier" = "architect") {
  const root = await mkdtemp(join(tmpdir(), "bflow-assignment-survey-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  await mkdir(join(root, "packages/example/src"), { recursive: true });
  await writeFile(join(root, "packages/example/src/behavior.ts"), "export function existingBehavior() { return 'previous result'; }\n");
  git("add", "."); git("commit", "-m", "baseline");
  const at = "2031-01-01T00:00:00.000Z", revision = git("rev-parse", "HEAD");
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding", sessionId: "session", role,
    agentId: "architect", paneId: "pane", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root,
    isolationMode: "dedicated_pane", readOnlyWorkspace: true, permanent: true, transportState: "working", boundAt: at,
    session: { source: "herdr:claude", kind: "id", value: "native-session" } });
  const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake", correlationId: "corr",
    runId: "run-1", sessionId: "conversation", requestedBy: "conversation", targetRole: "coordinator", title: "Change behavior",
    objective: "Preserve existing behavior while changing the output", specificationId: "spec-1", sddLevel: "lightweight",
    acceptanceCriteria: draft().acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: at, idempotencyKey: "intake",
    metadata: { affectedPaths: ["packages/example/src"] } });
  const outbound = { status: "accepted", taskId: "specialist-task", message: { schema_version: 2, message_id: "assignment", correlation_id: "corr",
    run_id: "run-1", sender: { role: role === "coordinator" ? "conversation" : "coordinator" }, recipient: { role, agent_id: binding.agentId, pane_id: binding.paneId }, type: "delegation.request",
    payload: { ...delegation, requestedBy: role === "coordinator" ? "conversation" : "coordinator", targetRole: role, objective: "Inspect existingBehavior downstream dependencies" }, artifact_references: [], occurred_at: at, idempotency_key: "assignment" },
    handle: { executionId: "execution", requestId: "request", attemptId: "attempt", runId: "run-1", taskId: "specialist-task", idempotencyKey: "assignment",
      target: { transport: "herdr", agentId: binding.agentId, paneId: binding.paneId, workspaceId: binding.workspaceId, tabId: binding.tabId, session: binding.session },
      correlation: { token: "request", provenance: "orchestrator", verified: false }, acceptedAt: at } };
  const run = { runId: "run-1", delegation, tasks: [], baseRevision: revision };
  return { root, git, revision, binding, outbound, run };
}

describe("Host assignment repository survey", () => {
  it.each(["coordinator", "architect", "planner", "specifier"] as const)("delivers the exact admitted task to %s with revision and source provenance", async role => {
    const f = await fixture(role), before = JSON.stringify(f.run);
    const result = await new AssignmentSurvey(f.root).prepare(f.binding, assignmentsForBinding([f.outbound], f.binding), [f.run], []);
    expect(result).toMatchObject({ status: "prepared", assignmentMessageId: "assignment", runId: "run-1", taskId: "specialist-task",
      context: { repositoryIdentity: { sourceRevision: f.revision } }, gitnexus: { status: "unverified", authorizedActions: [] } });
    const context = (result as any).context;
    expect(context.formattedPromptContext).toContain("Inspect existingBehavior downstream dependencies");
    expect(context.formattedPromptContext).toContain("packages/example/src/behavior.ts");
    expect(context.formattedPromptContext).toContain("previous result");
    expect(context.baselineFiles).toBeUndefined();
    expect(JSON.stringify(f.run)).toBe(before);
  });

  it("rejects reused pane/native sessions, other roles and another worktree before selecting an assignment", async () => {
    const f = await fixture();
    const clone = (changes: object) => ({ ...f.outbound, handle: { ...f.outbound.handle, target: { ...f.outbound.handle.target, ...changes } } });
    expect(assignmentsForBinding([clone({ agentId: "another" }), clone({ session: { source: "herdr:claude", kind: "id", value: "old" } }),
      clone({ worktreePath: "/another/worktree" }), { ...f.outbound, message: { ...f.outbound.message, recipient: { role: "specifier" } } }], f.binding)).toEqual([]);
  });

  it("refreshes fingerprint drift without changing accepted state, and never calls a missing index current", async () => {
    const f = await fixture(), service = new AssignmentSurvey(f.root), before = JSON.stringify(f.run);
    await service.prepare(f.binding, [f.outbound], [f.run], []);
    await writeFile(join(f.root, "packages/example/src/behavior.ts"), "export function existingBehavior() { return 'new result'; }\n");
    const result = await service.prepare(f.binding, [f.outbound], [f.run], [{ toolId: "gitnexus", status: "available" }]);
    expect(result).toMatchObject({ freshness: { state: "refreshed_after_drift" }, gitnexus: { status: "unverified" } });
    expect((result as any).context.formattedPromptContext).toContain("new result");
    expect(JSON.stringify(f.run)).toBe(before);
  });

  it("omits broad surveys when intake scope is unknown, and omits released assignments", async () => {
    const f = await fixture();
    expect(await new AssignmentSurvey(f.root).prepare(f.binding, [f.outbound], [{ ...f.run, delegation: { ...f.run.delegation, metadata: {} } }], []))
      .toMatchObject({ status: "limited" });
    expect(await new AssignmentSurvey(f.root).prepare(f.binding, [{ ...f.outbound, status: "released" }], [f.run], []))
      .toMatchObject({ status: "unavailable" });
  });
});
