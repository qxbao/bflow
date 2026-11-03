import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DelegationRequestSchema, RoleMessageSchema, SessionManifestSchema, type AgentRequest } from "@bflow/contracts";
import { buildAnalysisPack } from "@bflow/runtime";
import { openAgenticWorkspace } from "../../dist/agentic/workspace.js";

it.each([false, true])("registers the actual extension role only after successful host preflight (denied=%s)", async denied => {
  const root = await realpath(await mkdtemp("/tmp/bflow-extension-registration-"));
  let workspace: Awaited<ReturnType<typeof openAgenticWorkspace>> | undefined;
  try {
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline"], { cwd: root });
    const binary = join(root, "herdr.mjs");
    await writeFile(binary, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==="--version") console.log("herdr fixture");
else if(args[0]==="api") console.log("protocol: 22\\nschema_version: 1");
else if(args[0]==="agent" && args[1]==="list") console.log(JSON.stringify({result:{type:"agent_list",agents:[]}}));
else console.log(JSON.stringify({running:true,session:process.env.HERDR_SESSION,socket:${JSON.stringify(join(root, "herdr.sock"))}}));
`, { mode: 0o700 });
    const sessionId = "extension-registration", at = new Date().toISOString();
    const manifestDirectory = join(root, ".bflow/state/panes"); await mkdir(manifestDirectory, { recursive: true });
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId, projectName: "fixture", workspaceRoot: root,
      herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conversation", activeRunIds: [],
      panes: ["conversation", "coordinator", "architect"].map((role, index) => ({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId,
        role, agentId: role, paneId: `w1:p${index + 1}`, workspaceId: "w1", tabId: "w1:t1", provider: "codex", agentKind: "codex",
        session: { source: "herdr:codex", kind: "id", value: `native-${role}` }, cwd: root, isolationMode: "dedicated_pane",
        readOnlyWorkspace: true, permanent: true, transportState: "idle", boundAt: at })),
      attachTarget: { role: "conversation", paneId: "w1:p1" }, createdAt: at, updatedAt: at });
    await writeFile(join(manifestDirectory, `${sessionId}.manifest.json`), JSON.stringify(manifest));
    const steps: string[] = [], capabilities = ["repository.read", "architecture"], pack = buildAnalysisPack({ id: "registration", version: "1" });
    workspace = await openAgenticWorkspace({ repositoryPath: root, sessionId, herdrBinary: binary, workflowPack: pack,
      roleCapabilities: { architect: capabilities }, taskChecks: [], workflowChecks: [], deterministicGates: [],
      assertExtensionDispatch: () => { steps.push("dispatch"); },
      revalidateRoleSkills: async () => { steps.push("skills"); },
      preflightRoleCapabilities: async (_binding, required) => {
        steps.push("capabilities"); expect(required).toEqual(capabilities);
        if (denied) throw new Error("host capability preflight denied");
      },
      authenticateMessage: async () => false, authenticateResult: async () => false, authenticateEvidence: async () => false,
      authenticateGateResult: async () => false, authorizeHuman: async () => false });
    workspace.runtime.ports.panes.inspectRoleHealth = async () => ({ ok: true,
      value: { readyForPrompt: true, occupantMatches: true, paneId: "w1:p3", agentId: "architect" } });
    const sent: AgentRequest[] = [];
    workspace.runtime.ports.transport.send = async request => {
      sent.push(request);
      return { ok: true, value: { status: "rejected", requestId: request.requestId, attemptId: request.attemptId,
        runId: request.runId, taskId: request.taskId, observedAt: new Date().toISOString(), reason: "fixture stops before native acceptance" } };
    };
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "message",
      correlationId: "correlation", sessionId: "conversation", runId: "run-registration", requestedBy: "conversation", targetRole: "coordinator",
      title: "Analyze", objective: "Document existing behavior", specificationId: "spec", sddLevel: "lightweight",
      acceptanceCriteria: [{ id: "AC-1", category: "functional", description: "Traceable analysis", verificationMethod: "manual_review",
        required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "normal", requestedAt: at, idempotencyKey: "delegate" });
    await workspace.extensions.admit(delegation);
    await workspace.runtime.queueHerdr(RoleMessageSchema.parse({ schema_version: 2, message_id: "message", correlation_id: "correlation",
      run_id: delegation.runId, sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: delegation, artifact_references: [], idempotency_key: "delegate" }));
    await workspace.extensions.start({ kind: "analysis", runId: "run-registration", packPin: { id: pack.id, version: pack.version, digest: pack.digest },
      intake: { schemaVersion: 1, requestId: "request", sessionId: "conversation", title: "Analyze", userStatements: [{ id: "U-1", text: "Document existing behavior" }],
        deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary"],
        acceptanceCriteria: [{ id: "AC-1", description: "Traceable analysis", required: true }], surveyPaths: ["src"], documentRoot: "docs/analysis" } });
    expect(await workspace.runtime.ports.registry.list("architect")).toMatchObject({ ok: true, value: [] });
    await expect(workspace.extensions.drive("run-registration")).rejects.toThrow(denied ? "host capability preflight denied" : /Native delivery is unknown or rejected/);
    expect(steps.slice(0, 3)).toEqual(["dispatch", "skills", "capabilities"]);
    expect(sent).toHaveLength(denied ? 0 : 1);
    const registered = await workspace.runtime.ports.registry.list("architect");
    expect(registered).toMatchObject({ ok: true, value: denied ? [] : [{ agentId: "architect", role: "architect", capabilities }] });
  } finally {
    if (workspace) {
      await workspace.extensions.cancel("run-registration", "Test cleanup after preflight or proven transport rejection");
      await workspace.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});
