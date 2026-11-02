import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, DelegationRequestSchema, ResolvedToolGrantSchema, RuntimeHttpGrantSchema, RuntimeHttpPolicySchema, type ApprovalRequest } from "@bflow/contracts";
import { buildAnalysisPack, canonicalPlanDigest, createRuntimeHttpAuthority, createHttpQaTool, openWorkflowExtensionRuntimes, workflowPackDigest } from "../src/index.js";
import { AppCheckBrowserLeases } from "../src/agentic/app-check-lease.js";
import { nativeExtensionFixture } from "./helpers/native-extension.js";

const shutdown: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of shutdown.splice(0)) await stop(); });

async function qaFlow(options: { sharedSession?: "reviewer" | "qa"; hostSession?: string; revokeAfterReadiness?: boolean; legacyGrantOnly?: boolean;
  interruptAfterIntent?: "policy" | "lease" } = {}) {
  const f = await nativeExtensionFixture("qa", options.hostSession), { engine } = await f.open();
  if (options.sharedSession) f.panes.get(options.sharedSession)!.session = structuredClone(f.panes.get("tester")!.session);
  const calls: string[] = [], server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json"); response.setHeader("x-build", "accepted-fixture-revision");
    response.end(JSON.stringify({ healthy: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  shutdown.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback fixture port");
  const origin = `http://127.0.0.1:${address.port}`, hostSession = options.hostSession ?? "session-native";
  const pack = buildAnalysisPack({ id: "qa-acceptance", version: "1" });
  pack.defaults = { "workflow.id": "bflow.qa-only", "workflow.version": "1", "capabilities.required": ["workflow.qa_only"] };
  pack.digest = workflowPackDigest(pack);
  const intake = { schemaVersion: 1 as const, requestId: "native-health-qa", sessionId: "session-native", title: "Existing health QA",
    userStatements: [{ id: "U-1", text: "Check health without changing the existing product" }],
    target: { environmentId: "native-health", kind: "fixture" as const, origins: [origin], readinessPath: "/health", buildIdentity: { header: "x-build" } },
    criteria: [{ id: "AC-1", description: "Healthy is true" }], allowedActions: options.interruptAfterIntent ? ["http_read" as const, "http_mutate" as const] : ["http_read" as const], accountPolicy: { accounts: [] },
    dataPolicy: { fixturePrefix: "health-qa", redactKeys: [] }, cleanup: { required: true }, workspace: { assetRoot: "qa" }, protectedPaths: ["src"] };
  f.setOutput((request, assignment) => {
    if (request.taskId === "design") return { design: { schemaVersion: 1, title: "Health QA", cases: [{ id: "TC-1", title: "Healthy",
      criterionIds: ["AC-1"], sideEffect: options.interruptAfterIntent ? "mutating" : "none", expected: "Healthy is true", steps: [{ kind: "http",
        method: options.interruptAfterIntent ? "POST" : "GET", url: options.interruptAfterIntent ? "/mutations/${fixturePrefix}" : "/health",
        ...(options.interruptAfterIntent ? { body: { label: "${fixturePrefix}" } } : {}),
        expect: { status: 200, json: [{ pointer: "/healthy", equals: true }] } }],
      cleanup: options.interruptAfterIntent ? [{ kind: "http", method: "DELETE", url: "/mutations/${fixturePrefix}", expect: { status: 200 } }] : [] }],
      criteriaCoverage: [{ criterionId: "AC-1", caseIds: ["TC-1"] }] } };
    if (request.taskId === "design-review") return { verdict: "approved", designDigest: assignment.context.design.digest, findings: [] };
    if (request.taskId === "adjudication") return { executionDigest: assignment.context.execution.digest,
      verdicts: assignment.context.execution.cases.map((item: { caseId: string; status: string }) => ({ caseId: item.caseId,
        classification: item.status === "assertion_failed" ? "product_failure" : item.status, rationale: "Pinned observed outcome" })) };
    throw new Error(`Unexpected native QA task ${request.taskId}`);
  });
  const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "fixture-qa-grant", policyDigest: "a".repeat(64), toolId: "qa-http",
    kind: "stdio_mcp", serviceId: "qa-http", requiredness: "required", role: "qa", triggers: ["explicit"], operations: ["http_read"],
    scope: { kind: "session", machineId: "fixture-machine", repositoryId: "fixture-repo", workspaceRoot: f.repo, sessionId: hostSession } });
  const policyBody = { schemaVersion: 3, kind: "runtime_http", toolId: "qa-http", role: "qa", repositoryId: "fixture-repo",
    scope: { kind: "repository", machineId: "fixture-machine", repositoryId: "fixture-repo", workspaceRoot: f.repo }, origins: [origin], operations: intake.allowedActions };
  const runtimePolicy = RuntimeHttpPolicySchema.parse({ ...policyBody, digest: canonicalPlanDigest(policyBody) });
  const runtimeGrants = options.legacyGrantOnly ? [] : [RuntimeHttpGrantSchema.parse({ schemaVersion: 3, grantId: "runtime-qa-grant", kind: "runtime_http",
    toolId: "qa-http", role: "qa", scope: grant.scope, policyDigest: runtimePolicy.digest, origins: [origin], operations: intake.allowedActions })];
  let current = true;
  let leaseNow = Date.now();
  const composed = await openWorkflowExtensionRuntimes({ repositoryPath: f.repo, sessionId: "session-native", directory: join(f.root, "host-sdk"),
    engine, runStore: f.runStore, artifactStore: f.artifactStore, native: f.native, authorizeHuman: () => true,
    now: () => new Date().toISOString(), readPack: async () => pack, publishToConversation: async () => {},
    qa: { tools: { http: createHttpQaTool() }, grants: [grant], leases: new AppCheckBrowserLeases(join(f.root, "leases"), () => new Date(leaseNow)),
      runtimeHttpGrants: runtimeGrants,
      runtimeHttpAuthority: createRuntimeHttpAuthority({ policy: runtimePolicy, grants: runtimeGrants, machineId: "fixture-machine", repositoryId: "fixture-repo",
        workspaceRoot: f.repo, sessionId: hostSession, revalidate: async () => {} }),
      grantScopeSessionId: hostSession, beforeTargetAction: async () => {
        if (!current) throw new Error("execution_resolution_drift");
        if (options.revokeAfterReadiness) current = false;
        if (options.interruptAfterIntent) {
          const saved = JSON.parse(await readFile(join(f.root, "host-sdk/native-qa-v2.json"), "utf8"));
          if (saved.runs[0].execution?.mutations.some((item: { state: string }) => item.state === "intent")) {
            if (options.interruptAfterIntent === "policy") throw new Error("policy_revoked_after_intent");
            leaseNow += 120_000;
          }
        }
      } } });
  f.setAuthorize((intent, binding) => composed.host.authorizeNative(intent, binding));
  const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "qa-delegation", messageId: "qa-message", correlationId: "qa-correlation",
    sessionId: "session-native", runId: "run-native", requestedBy: "conversation", targetRole: "coordinator", title: intake.title,
    objective: intake.userStatements[0]!.text, specificationId: "qa-spec", sddLevel: "lightweight", acceptanceCriteria: [{ id: "AC-1", category: "functional",
      description: "Healthy is true", verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [],
    priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: "qa-delegation" });
  await composed.host.admit(delegation); await composed.host.start({ kind: "qa", runId: "run-native", intake,
    packPin: { id: pack.id, version: pack.version, digest: pack.digest } });
  const approve = (request: ApprovalRequest) => ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId,
    runId: request.runId, sessionId: request.sessionId, target: request.target, revision: request.revision, generation: request.generation,
    decision: "approved", decidedBy: "user:owner", decidedAt: new Date().toISOString(), feedbackArtifacts: [],
    idempotencyKey: "exact-qa-owner", metadata: request.metadata });
  return { ...f, ...composed, engine, calls, approve };
}

describe("native QA host behavior (local transport fixture)", () => {
  it.each(["policy", "lease"] as const)("checks %s again after mutation intent is durable and never sends the mutation", async interruptAfterIntent => {
    const f = await qaFlow({ interruptAfterIntent }); await f.host.drive("run-native");
    await f.host.decide(f.approve((await f.host.pendingApprovals())[0]!));
    if (interruptAfterIntent === "policy") await expect(f.host.drive("run-native")).rejects.toThrow("policy_revoked_after_intent");
    else {
      const result = await f.host.drive("run-native") as any;
      expect(result.extension.classifications).toEqual({ "TC-1": "blocked" });
    }
    expect(f.calls).toEqual(["GET /health"]);
    expect(f.qa.status("run-native").execution!.mutations).toEqual([expect.objectContaining({ state: "not_delivered" })]);
  });
  it("never treats a legacy MCP grant as authority for native host HTTP execution", async () => {
    const f = await qaFlow({ legacyGrantOnly: true }); await f.host.drive("run-native");
    await f.host.decide(f.approve((await f.host.pendingApprovals())[0]!)); const result = await f.host.drive("run-native") as any;
    expect(f.calls).toEqual([]); expect(result.extension.classifications).toEqual({ "TC-1": "blocked" });
    expect(result.extension.execution.readiness.ready).toBe(false);
  });
  it("binds actual native roles and preserves original approval before real HTTP under the distinct host grant session", async () => {
    const f = await qaFlow({ hostSession: "herdr-host-session" }), before = await readFile(join(f.repo, "src/health.ts"));
    const waiting = await f.host.drive("run-native") as any;
    expect(waiting.extensionStatus).toBe("awaiting_design_approval"); expect(f.calls).toEqual([]);
    const decision = f.approve((await f.host.pendingApprovals())[0]!);
    await f.host.decide(decision); const result = await f.host.drive("run-native") as any;
    expect(result.extensionStatus).toBe("reported"); expect(result.extension.classifications).toEqual({ "TC-1": "passed" });
    expect(result.extension.execution.build).toMatchObject({ status: "identified", value: "accepted-fixture-revision" });
    expect(result.extension.execution.productUnchanged).toBe(true); expect(f.calls).toEqual(["GET /health", "GET /health"]);
    expect(await readFile(join(f.repo, "src/health.ts"))).toEqual(before);
    expect(f.transport.sentRequests.map(request => request.role)).toEqual(["tester", "reviewer", "qa"]);
    const core = await f.engine.getSnapshot("run-native"); if (!core.ok || !core.value) throw new Error("Missing Core state");
    expect(core.value.status).toBe("succeeded");
    expect(core.value.tasks.filter(task => task.agentExecution?.target.transport === "herdr")).toHaveLength(3);
    expect(result.extension.execution.leases).toEqual([expect.objectContaining({ fencingToken: 1, released: true })]);
    const count = f.calls.length; await f.host.decide(decision); await f.host.drive("run-native"); expect(f.calls).toHaveLength(count);
  });

  it.each(["reviewer", "qa"] as const)("refuses %s sharing the designer's authenticated native session", async sharedSession => {
    const f = await qaFlow({ sharedSession }); const waiting = await f.host.drive("run-native") as any;
    if (sharedSession === "reviewer") {
      expect(waiting.extensionStatus).toBe("needs_revision"); expect(f.calls).toEqual([]);
      expect(await f.host.pendingApprovals()).toEqual([]);
    } else {
      await f.host.decide(f.approve((await f.host.pendingApprovals())[0]!)); const result = await f.host.drive("run-native") as any;
      expect(result.extension.report).toBeUndefined(); expect(result.extension.classifications).toEqual({});
    }
  });

  it("revalidates authority before each HTTP action and stops after readiness when execution resolution drifts", async () => {
    const f = await qaFlow({ revokeAfterReadiness: true }); await f.host.drive("run-native");
    await f.host.decide(f.approve((await f.host.pendingApprovals())[0]!));
    await expect(f.host.drive("run-native")).rejects.toThrow("execution_resolution_drift");
    expect(f.calls).toEqual(["GET /health"]); expect(f.qa.status("run-native").report).toBeUndefined();
  });
});
