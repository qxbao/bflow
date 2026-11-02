import { afterEach, describe, expect, it } from "vitest";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalDecisionSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, type ApprovalRequest } from "@bflow/contracts";
import * as hostTools from "../src/agentic/host.js";
import { buildAnalysisPack, openWorkflowExtensionRuntimes, type AnalysisDocument } from "../src/index.js";
import { AppCheckBrowserLeases } from "../src/agentic/app-check-lease.js";
import { nativeExtensionFixture } from "./helpers/native-extension.js";
import { createAgenticConversationHost } from "../src/agentic/conversation.js";
import { fixture as implementationFixture, cleanups, unwrap } from "./helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function nativeAnalysisFlow(sharedReviewerSession = false, conversationSessionId = "session-native") {
  const f = await nativeExtensionFixture("analysis"), { engine } = await f.open();
  if (sharedReviewerSession) f.panes.get("reviewer")!.session = structuredClone(f.panes.get("specifier")!.session);
  const pack = buildAnalysisPack({ id: "native-analysis-acceptance", version: "1" });
  const intake = { schemaVersion: 1 as const, requestId: "health-analysis", sessionId: conversationSessionId, title: "Health analysis",
    userStatements: [{ id: "U-1", text: "Specify the health flag and its owner without changing the source." },
      { id: "U-2", text: "Health checks should respond within100 ms at p95 for5 concurrent callers." }],
    deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary", "data_notes"] as const,
    acceptanceCriteria: [{ id: "AAC-1", description: "Traceable health FR/AC and measurable-or-undecided NFRs", required: true }],
    requiredDecisions: [{ id: "D-1", question: "Which team owns the health flag?", blocking: true }],
    surveyPaths: ["src"], documentRoot: "docs/analysis" };
  let document: AnalysisDocument | undefined;
  f.setOutput((request, assignment) => {
    if (request.taskId === "survey") return { observations: [{ path: "src/health.ts", note: "The existing module exposes healthy=true" }] };
    if (request.taskId === "elicitation") return { questions: [] };
    if (request.taskId === "review") return { verdict: "approved", documentDigest: assignment.context.document.digest, findings: [] };
    if (request.taskId !== "specification") throw new Error(`Unexpected native task ${request.taskId}`);
    const observation = assignment.context.observations[0], source = `source:${observation.path}#${observation.sha256}`;
    document = { schemaVersion: 1, title: "Health analysis", scope: {
      inScope: [{ id: "S-1", text: "Health flag and ownership", provenance: { kind: "user", refs: ["intake:U-1"] } }],
      outOfScope: [{ id: "S-2", text: "Changing the application", provenance: { kind: "inference", refs: ["S-1"] } }] },
      functionalRequirements: [
        { id: "FR-1", text: `${assignment.context.decisions["D-1"].answer} owns the health flag`, provenance: { kind: "user", refs: ["decision:D-1"] } },
        { id: "FR-2", text: "The existing healthy flag has value true", provenance: { kind: "source", refs: [source] } }],
      acceptanceCriteria: [
        { id: "AC-1", text: "Owner is recorded", requirementIds: ["FR-1"], given: "the owner decision is accepted", when: "the analysis is published",
          then: "the owner is recorded", oracle: "the named team equals the human decision", provenance: { kind: "inference", refs: ["FR-1"] } },
        { id: "AC-2", text: "Flag value is traced", requirementIds: ["FR-2"], given: "the observed health module", when: "healthy is inspected",
          then: "the value is true", oracle: "the pinned source exports healthy=true", provenance: { kind: "source", refs: [source] } }],
      nfrs: [
        { id: "NFR-1", category: "performance", text: "Health check latency", status: "accepted", metric: "p95 response time", oracle: "HTTP timing report",
          workload: "5 concurrent callers", threshold: "100 ms", provenance: { kind: "user", refs: ["intake:U-2"] } },
        { id: "NFR-2", category: "availability", text: "Availability target", status: "undecided", decisionId: "D-2",
          provenance: { kind: "open_decision", refs: ["decision:D-2"] } }],
      businessFlows: [{ id: "BF-1", text: "Monitor health", requirementIds: ["FR-1", "FR-2"], provenance: { kind: "inference", refs: ["FR-1", "FR-2"] },
        steps: [{ actor: "Owner", action: "Checks the health flag" }, { actor: "System", action: "Returns the existing flag" }] }],
      glossary: [{ id: "G-1", term: "Healthy flag", text: "The boolean exported by the observed module", provenance: { kind: "source", refs: [source] } }],
      notes: [{ id: "N-1", kind: "data", text: "The flag is boolean", provenance: { kind: "source", refs: [source] } }],
      openQuestions: [{ id: "D-2", question: "What availability target should the owner choose?", blocking: false }],
      criteriaCoverage: [{ criterionId: "AAC-1", statementIds: ["FR-1", "FR-2", "AC-1", "AC-2", "NFR-1", "NFR-2", "BF-1"] }] };
    return { document };
  });
  const notices: unknown[] = [];
  const composed = await openWorkflowExtensionRuntimes({ repositoryPath: f.repo, sessionId: conversationSessionId, directory: join(f.root, "host-sdk"),
    engine, runStore: f.runStore, artifactStore: f.artifactStore, native: f.native, authorizeHuman: () => true,
    now: () => new Date().toISOString(), readPack: async () => pack, publishToConversation: async message => { notices.push(message); },
    qa: { tools: {}, grants: [], leases: new AppCheckBrowserLeases(join(f.root, "qa-leases")) } });
  f.setAuthorize((intent, binding) => composed.host.authorizeNative(intent, binding));
  const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "health-ba", messageId: "health-ba-message", correlationId: "health-ba-correlation",
    sessionId: conversationSessionId, runId: "run-native", requestedBy: "conversation", targetRole: "coordinator", title: intake.title, objective: intake.userStatements[0]!.text,
    specificationId: "health-ba-spec", sddLevel: "lightweight", acceptanceCriteria: [{ id: "AAC-1", category: "functional", description: intake.acceptanceCriteria[0]!.description,
      verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "normal",
    requestedAt: new Date().toISOString(), idempotencyKey: "health-ba" });
  await composed.host.admit(delegation);
  await composed.host.start({ kind: "analysis", runId: "run-native", intake: { ...intake, deliverables: [...intake.deliverables] },
    packPin: { id: pack.id, version: pack.version, digest: pack.digest } });
  const decision = (request: ApprovalRequest, answers?: Record<string, string>) => ApprovalDecisionSchema.parse({ schemaVersion: 2,
    approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId, target: request.target, revision: request.revision,
    generation: request.generation, decision: "approved", decidedBy: "user:owner", decidedAt: new Date().toISOString(), feedbackArtifacts: [],
    idempotencyKey: `physical-${request.approvalId}`, metadata: { ...request.metadata, ...(answers ? { answers } : {}) } });
  return { ...f, ...composed, engine, notices, decision, document: () => document! };
}

async function activeAssignment() {
  const f = await nativeExtensionFixture("analysis"), { sdk } = await f.open(); await f.start(sdk);
  f.native.waitResult = async () => { throw new Error("retain accepted task for permission inspection"); };
  await expect(sdk.drive("run-native")).rejects.toThrow("retain accepted task");
  const snapshot = await f.native.snapshot(), out = snapshot.outbound[0]!;
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-architect", sessionId: "session-native", role: "architect",
    agentId: out.handle!.target.agentId, paneId: out.handle!.target.paneId, workspaceId: "w", tabId: "w:t", provider: "codex", agentKind: "codex",
    cwd: f.repo, readOnlyWorkspace: true, permanent: true, isolationMode: "dedicated_pane", transportState: "working",
    boundAt: new Date().toISOString(), session: out.handle!.target.session });
  const select = Reflect.get(hostTools, "selectNativeExtensionScope"), guard = Reflect.get(hostTools, "guardExtensionTool");
  expect(select).toBeTypeOf("function"); expect(guard).toBeTypeOf("function");
  return { ...f, out, binding, select, guard };
}

describe("analysis host assignment permissions", () => {
  it("collects a real trusted Conversation business answer while preserving its original human receipt", async () => {
    const f = await nativeAnalysisFlow(false, "session-1"), implementation = await implementationFixture();
    await f.host.drive("run-native"); const question = (await f.host.pendingApprovals())[0]!;
    const receipts: unknown[] = [];
    const chat = await createAgenticConversationHost({ runtime: implementation.runtime, extensions: f.host,
      manifest: unwrap(await implementation.panes.getManifest()), contextDirectory: join(f.root, "conversation"),
      onHumanDecision: async decision => { receipts.push(decision); } });
    await chat.reconcileApprovals();
    const answer = await chat.handleTrustedApproval({ sessionId: "session-1", messageId: "physical-business-answer",
      content: `${question.approvalId}: D-1: Ops`, provenance: { origin: "user", authenticatedUser: true, userId: "owner",
        paneId: "pane-conversation", channel: "herdr_attach" } }) as any;
    expect(answer?.ok).toBe(true); expect(receipts).toHaveLength(1);
    await f.host.drive("run-native");
    expect((await f.host.pendingApprovals())[0]!.metadata?.approvalScope).toBe("analysis_document");
    expect(f.document().functionalRequirements[0]!.text).toBe("Ops owns the health flag");
    const page = await f.runStore.readEvents("run-native", { limit: 100 }); if (!page.ok) throw new Error(page.error.message);
    expect(page.value.items.filter(event => event.type === "approval.decided").map(event => event.payload)).toEqual(receipts);
    expect((receipts[0] as any).metadata.answers).toBeUndefined();
    expect((receipts[0] as any).reason).toBe("D-1: Ops");
  });

  it("rejects incomplete or conflicting business answers before queuing a human receipt", async () => {
    const f = await nativeAnalysisFlow(); await f.host.drive("run-native"); const question = (await f.host.pendingApprovals())[0]!;
    for (const reason of ["continue", "D-1: Ops\nD-1: Other", "unknown-question: Ops"])
      await expect(f.host.decide({ ...f.decision(question), reason })).rejects.toThrow(/answer|question|business|quyết định|câu hỏi/i);
    expect((await f.host.inspect("run-native") as any).queuedDecisions).toEqual([]);
    expect((await f.host.pendingApprovals()).map(request => request.approvalId)).toEqual([question.approvalId]);
  });
  it("publishes only after four genuine native role bindings and two separate exact human decisions, preserving source and undecided facts", async () => {
    const f = await nativeAnalysisFlow(), before = await readFile(join(f.repo, "src/health.ts"));
    await f.host.drive("run-native");
    const business = (await f.host.pendingApprovals())[0]!;
    expect(business.metadata?.approvalScope).toBe("business_decisions");
    const businessDecision = f.decision(business, { "D-1": "Ops" });
    await f.host.decide(businessDecision); await f.host.drive("run-native");
    const document = (await f.host.pendingApprovals())[0]!;
    expect(document.metadata?.approvalScope).toBe("analysis_document");
    const approval = f.decision(document);
    await f.host.decide(approval); const result = await f.host.drive("run-native") as any;
    expect(result.extensionStatus).toBe("published");
    expect(f.transport.sentRequests.map(request => request.role)).toEqual(["architect", "specifier", "specifier", "reviewer"]);
    const snapshot = await f.engine.getSnapshot("run-native"); if (!snapshot.ok || !snapshot.value) throw new Error("Missing Core run");
    expect(snapshot.value.status).toBe("succeeded");
    expect(snapshot.value.tasks.filter(task => task.agentExecution?.target.transport === "herdr")).toHaveLength(4);
    for (const task of snapshot.value.tasks.filter(task => task.agentExecution?.target.transport === "herdr"))
      expect(task.bindingVerification?.receipt.handle).toEqual(task.agentExecution);
    expect(snapshot.value.tasks.find(task => task.taskId === "publication")!.agentExecution!.target.transport).toBe("runtime-publication");
    expect(await readFile(join(f.repo, "src/health.ts"))).toEqual(before);
    expect(f.document().nfrs.find(item => item.id === "NFR-1")).toMatchObject({ threshold: "100 ms", oracle: "HTTP timing report", workload: "5 concurrent callers" });
    expect(f.document().nfrs.find(item => item.id === "NFR-2")).toMatchObject({ status: "undecided", decisionId: "D-2" });
    expect(f.document().nfrs.find(item => item.id === "NFR-2")!.threshold).toBeUndefined();
    for (const file of result.extension.handoff.files) expect(file.path).toMatch(/^docs\/analysis\//);
    const decisions: unknown[] = []; let cursor: string | undefined;
    do { const page = await f.runStore.readEvents("run-native", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.error.message);
      decisions.push(...page.value.items.filter(event => event.type === "approval.decided").map(event => event.payload)); cursor = page.value.nextCursor;
    } while (cursor);
    expect(decisions).toEqual([businessDecision, approval]);
  });

  it("refuses a Reviewer that shares the author's native session even when agent IDs and signed handles differ", async () => {
    const f = await nativeAnalysisFlow(true); await f.host.drive("run-native");
    await f.host.decide(f.decision((await f.host.pendingApprovals())[0]!, { "D-1": "Ops" }));
    const result = await f.host.drive("run-native") as any;
    expect(result.extensionStatus).toBe("needs_revision");
    expect(result.extension.blockers.join(" ")).toMatch(/independent/i);
    expect(await f.host.pendingApprovals()).toEqual([]);
    expect(result.extension.handoff).toBeUndefined();
  });
  it("uses the current repository for actual bounded reads and rejects traversal/symlinks before exposing other task data", async () => {
    const f = await activeAssignment(), scope = f.select([f.out], [], f.binding);
    const read = Reflect.get(hostTools, "readNativeExtensionRepository"); expect(read).toBeTypeOf("function");
    const authorize = () => f.native.validatePrompt(f.out.message, f.binding);
    const actual = await read(scope, f.repo, { op: "read", path: "src/health.ts" }, authorize);
    expect(actual.content).toBe(await readFile(join(f.repo, "src/health.ts"), "utf8"));
    let deniedAuthorizations = 0;
    await expect(read(scope, f.repo, { op: "read", path: "../other-task/private" }, async () => { deniedAuthorizations++; }))
      .rejects.toThrow(/scope|assignment/i);
    expect(deniedAuthorizations).toBe(0);
    await writeFile(join(f.root, "private"), "another task's private source");
    await symlink(join(f.root, "private"), join(f.repo, "src/escape"));
    await expect(read(scope, f.repo, { op: "read", path: "src/escape" }, authorize)).rejects.toThrow(/symlink|symbolic|outside|link/i);
  });
  it("narrows a permanent role after an earlier broader task and permits only the exact survey paths through bounded MCP reads", async () => {
    const f = await activeAssignment();
    const previous = { ...f.out, message: RoleMessageSchema.parse({ ...f.out.message, message_id: "previous-standard",
      payload: { kind: "standard-specialist" } }), handle: { ...f.out.handle!, executionId: "previous-execution",
      acceptedAt: new Date(Date.parse(f.out.handle!.acceptedAt) - 1000).toISOString() } };
    const scope = f.select([f.out], [previous], f.binding);
    expect(scope).toMatchObject({ state: "active", family: "analysis", runId: "run-native", taskId: "survey", readPaths: ["src"] });
    expect(f.guard(scope, "mcp__bflow__repository_read", { op: "read", path: "src/health.ts" })).toMatchObject({ permitted: true });
    expect(f.guard(scope, "mcp__bflow__repository_read", { op: "list", path: "src" })).toMatchObject({ permitted: true });
    for (const path of ["src-other/secret", "../src/health.ts", "/etc/passwd", "docs/private.md"])
      expect(f.guard(scope, "mcp__bflow__repository_read", { op: "read", path })).toMatchObject({ permitted: false });
    expect(f.guard(scope, "mcp__bflow__repository_read", { op: "git", action: "diff" })).toMatchObject({ permitted: false });
  });

  it("denies native commands, reads, writes, network and previously granted MCP operations before their side effects", async () => {
    const f = await activeAssignment(), scope = f.select([f.out], [], f.binding); let sideEffects = 0;
    for (const tool of ["Read", "Glob", "Grep", "ToolSearch", "Bash", "exec_command", "shell_command", "Write", "Edit", "apply_patch",
      "WebFetch", "mcp__browser__navigate", "mcp__bflow__invoke_tool_action", "mcp__bflow__write_workspace_file", "mcp__bflow__send_role_message"])
      if (f.guard(scope, tool, { command: "cat /etc/passwd", path: "src/health.ts" }).permitted) sideEffects++;
    expect(sideEffects).toBe(0);
    expect(f.guard(scope, "mcp__bflow__assignment_context", {})).toMatchObject({ permitted: true });
    expect(f.guard(scope, "mcp__bflow__submit_extension_output", { messageId: f.out.message.message_id, output: { observations: [] } }))
      .toMatchObject({ permitted: true });
  });

  it("does not restore broad defaults when a native task settles; only a newer accepted ordinary assignment can replace its scope", async () => {
    const f = await activeAssignment(), released = { ...f.out, status: "released" };
    const settled = f.select([released], [], f.binding);
    expect(settled.state).toBe("settled");
    expect(f.guard(settled, "mcp__bflow__repository_read", { op: "read", path: "src/health.ts" })).toMatchObject({ permitted: false });
    expect(f.guard(settled, "Read", { file_path: "src/health.ts" })).toMatchObject({ permitted: false });
    const next = { ...f.out, message: RoleMessageSchema.parse({ ...f.out.message, message_id: "next-standard", payload: { kind: "standard-specialist" } }),
      handle: { ...f.out.handle!, executionId: "next-execution", acceptedAt: new Date(Date.parse(f.out.handle!.acceptedAt) + 1).toISOString() } };
    expect(f.select([released], [next], f.binding)).toBeUndefined();
    // A later ordinary row cannot waive an unresolved native execution.
    expect(f.select([f.out], [next], f.binding).state).toBe("active");
  });

  it("keeps unknown delivery and stale native sessions fail-closed without using a transport status as business success", async () => {
    const f = await activeAssignment(), unknown = { ...f.out, handle: undefined, status: "unknown_delivery" };
    const pending = f.select([unknown], [], f.binding);
    expect(pending.state).toBe("uncertain");
    expect(f.guard(pending, "mcp__bflow__repository_read", { op: "read", path: "src/health.ts" })).toMatchObject({ permitted: false });
    const restarted = { ...f.binding, session: { ...f.binding.session!, value: "replacement-session" } };
    const stale = f.select([f.out], [], restarted);
    expect(stale.state).toBe("uncertain");
    expect(f.guard(stale, "Read", { file_path: "src/health.ts" })).toMatchObject({ permitted: false });
    expect(f.guard(stale, "mcp__bflow__host_status", {})).toMatchObject({ permitted: true });
  });
});
