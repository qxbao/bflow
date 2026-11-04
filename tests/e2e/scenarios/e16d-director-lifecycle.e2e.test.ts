import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentLifecycle, openPaneManagerEnvironment, readEnvironmentConfig, identifyRepository, runCli } from "@bflow/cli";
import { AgentExecutionHandleSchema, CreateCheckpointCommandSchema, PaneBindingSchema, SessionManifestV3Schema, WebCommandSchema, type CreateCheckpointCommand, type RecoveryCheckpoint, type SessionManifest,
  type SessionManifestV3 } from "@bflow/contracts";
import { DirectorPanes, createDirectorSession, documentationSpecification, git, singleTaskWorkflow, type DirectorSession } from "../helpers/director-session.js";
import { HerdrWireRunner } from "../helpers/herdr-wire-runner.js";
import { createWebDirectorSession, directorWebBridge, PROJECT_ID, projectionToken, webPrincipal } from "../helpers/director-web.js";

/**
 * E16-D (Director C/D Task 9, closes the B2 N2 coupling gap at harness level): the CLI EnvironmentLifecycle `up`/`down` with the E16
 * Herdr wire fake, coupled to an ACTIVE Director run whose Runtime uses exactly the Director manifest `up` published. `down` refuses
 * an unconfirmed shutdown before any barrier; a confirmed `down` quiesces and checkpoints through the Runtime before stopping Herdr;
 * `up` republishes the same durable session (same sessionId and Conversation session) and the run resumes without a resend.
 * Linux-only like E16 (EnvironmentLifecycle/host process facilities). Evidence level: source + fake Herdr wire + fake specialists.
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

/** Director pane policy over the manifest `up` actually published (specialist bindings from Herdr, the same Conversation session). */
function publishedPanes(manifest: SessionManifestV3): DirectorPanes {
  const panes = new DirectorPanes();
  panes.bindings = [...manifest.panes];
  panes.manifest = () => manifest;
  return panes;
}

/** The CLI adds its completion report after activation and the final Herdr probe; all other manifest fields must match. */
async function expectPublishedManifest(activation: SessionManifestV3 | undefined, published: SessionManifestV3, repository: string) {
  expect(activation).toBeDefined();
  if (!activation) throw new Error("bflow up must activate the Runtime host before publishing success");
  expect(published).toEqual({ ...activation, metadata: { ...activation.metadata, stepsCompleted: [
    "load_project_config",
    "validate_required_providers",
    "validate_binaries_and_auth",
    "validate_permissions_and_trust",
    "validate_required_mcp",
    "validate_skills",
    "verify_agent_readiness_preflight",
    "reconcile_herdr_session_and_panes",
    "start_required_agents",
    "confirm_roles_ready",
    "persist_environment_manifest",
    "report_success"
  ] } });
  const persisted = SessionManifestV3Schema.parse(JSON.parse(await readFile(join(repository, ".bflow/state/session.json"), "utf8")));
  expect(persisted).toEqual(published);
}

describe("E16-D — Director lifecycle coupling (bflow up/down with an active Director run)", () => {
  it.skipIf(process.platform !== "linux")("[HARNESS + REAL RUNTIME/SQLITE/GIT] up (v3) → Director start_work → active run → down guard → confirmed down (quiesce+checkpoint) → up same session → resume → completed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bf16d-")));
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const repo = join(root, "repo");
    await mkdir(repo);
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.test");
    await writeFile(join(repo, "guide.md"), "initial\n"); git(repo, "add", "."); git(repo, "commit", "-m", "baseline");
    expect((await runCli(["init", "--json"], { cwd: repo })).ok).toBe(true);
    git(repo, "add", "-f", ".bflow"); git(repo, "commit", "-m", "chore: initialize bflow config");
    const envConfig = await readEnvironmentConfig(await identifyRepository(repo));
    // No Director role in repository config: the Director is chosen at launch time, never a repo role.
    expect(envConfig.environment.roles.some(role => String(role.role) === "director")).toBe(false);

    let session: DirectorSession | undefined;
    const activations: SessionManifestV3[] = [];
    const checkpoints: RecoveryCheckpoint[] = [];
    let quiesces = 0, shutdowns = 0;
    const host = {
      prepare: async () => ({ roleLaunch: Object.fromEntries(envConfig.environment.roles.map(r => [r.role,
        { systemPrompt: `Trusted ${r.role} prompt`, mcpConfigFile: "/tmp/mcp.json", hooksSettingsFile: "/tmp/hooks.json" }])) }),
      activate: async (manifest: SessionManifest) => { activations.push(SessionManifestV3Schema.parse(manifest)); return { ok: true as const, value: undefined }; },
      runtime: {
        findRuns: async (query: { status?: string[] }) => {
          const items = [];
          if (session) for (const run of ((await session.runtime.inspect()) as { runs?: { runId: string }[] }).runs ?? []) {
            const stored = (await session.store.get(run.runId)) as { ok: boolean; value?: { snapshot: { status: string } } | null };
            if (stored.ok && stored.value && (!query.status || query.status.includes(stored.value.snapshot.status))) items.push(stored.value.snapshot);
          }
          return { ok: true as const, value: { items } };
        },
        getRun: async (runId: string) => {
          const stored = session ? (await session.store.get(runId)) as { ok: boolean; value?: { snapshot: unknown } | null } : undefined;
          return { ok: true as const, value: stored?.ok && stored.value ? stored.value.snapshot : null };
        }
      },
      // The host barrier is the Director session's Runtime: stop scheduling, then aggregate checkpoints through Core.
      quiesce: async () => { quiesces++; await session?.runtime.quiesce(); return { ok: true as const, value: undefined }; },
      checkpoint: async (command: CreateCheckpointCommand) => {
        const saved = await session!.runtime.checkpoint(CreateCheckpointCommandSchema.parse(command));
        checkpoints.push(saved);
        return { ok: true as const, value: saved };
      },
      shutdown: async () => { shutdowns++; },
      close: async () => {}
    };
    const wire = new HerdrWireRunner();
    const lifecycle = () => new EnvironmentLifecycle(repo, { runner: wire,
      openIntegration: async composition => openPaneManagerEnvironment(composition, wire, async () => host as never, async () => ["--trusted-role-launch"]) });
    const calls = (domain: string, action: string) => wire.calls.filter(c => c.args[0] === domain && c.args[1] === action);
    const noLegacyAgents = () => expect(calls("agent", "start").map(c => c.args[2]).some(name => /conversation|coordinator/.test(String(name)))).toBe(false);

    // up: Director layout, manifest v3; the Runtime is composed on exactly that manifest.
    const up1 = await lifecycle().up();
    if (up1.schemaVersion !== 3) throw new Error("bflow up must publish a Director manifest v3");
    expect(up1.panes.some(p => p.role === "conversation" || p.role === "coordinator")).toBe(false);
    await expectPublishedManifest(activations.at(-1), up1, repo);
    noLegacyAgents();
    session = await createDirectorSession({ root, panes: publishedPanes(up1), inspectRun: true });

    // Active Director run: user message → start_work → propose_workflow → Developer dispatched.
    const registered = await session.endpoint.register({ provider: "claude" });
    const noted = await session.endpoint.call(registered.token, "director_note_user_message", { text: "Cập nhật guide.md" }) as { seq: number };
    const started = await session.endpoint.call(registered.token, "start_work", { title: "Cập nhật hướng dẫn", objective: "guide.md phản ánh yêu cầu",
      acceptanceCriteria: [{ description: "The requested outcome is independently verifiable", verificationMethod: "manual_review" }], sddLevel: "lightweight",
      userMessageSeq: noted.seq }) as { runId: string; correlationId: string };
    session.trackRun(started.runId, started.correlationId);
    const runId = started.runId;
    expect(await session.inspect(runId)).toMatchObject({ delegation: { requestedBy: "director", sessionId: up1.conversationSessionId } });
    const specification = documentationSpecification(runId, (await session.inspect(runId)).delegation.specificationId);
    specification.sessionId = up1.conversationSessionId;
    await session.endpoint.call(registered.token, "propose_workflow", { runId, specification, definition: singleTaskWorkflow() });
    await session.runtime.tick();
    const assignments = (s: DirectorSession) => s.transport.sentRequests.filter(r => r.runId === runId && r.role === "developer").length;
    expect(assignments(session)).toBe(1);

    // down without confirmation: refused before the barrier (no quiesce, no close, no session stop).
    const closesBefore = calls("pane", "close").length;
    await expect(lifecycle().down(false)).rejects.toThrow(/Unsafe shutdown: 1 active runs/);
    expect(quiesces).toBe(0);
    expect(calls("pane", "close").length).toBe(closesBefore);
    expect(calls("session", "stop").length).toBe(0);

    // Confirmed down: quiesce + Core aggregate checkpoint of the Director run happen before Herdr is stopped.
    const down = await lifecycle().down(true) as SessionManifest;
    expect(down).toMatchObject({ schemaVersion: 3, status: "down", sessionId: up1.sessionId });
    expect(quiesces).toBeGreaterThan(0);
    expect(checkpoints.some(checkpoint => checkpoint.runId === runId)).toBe(true);
    expect(shutdowns).toBeGreaterThan(0);
    const stopIndex = wire.calls.findIndex(c => c.args[0] === "session" && c.args[1] === "stop");
    expect(stopIndex).toBeGreaterThan(-1);
    // These allocations belong to the fake transport, outside the CLI Herdr wire lifecycle. Preserve its existing catalog
    // across the fixture reopen; this does not assert that a real Developer process survives bflow down.
    const retainedDevelopers = session.panes.bindings.filter(pane => pane.role === "developer").map(pane => PaneBindingSchema.parse(pane));
    expect(retainedDevelopers).toHaveLength(1);
    const priorAssignment = (await session.state()).outbound.find((out: any) => out.message.run_id === runId &&
      out.message.type === "task.assignment" && out.status === "accepted");
    if (!priorAssignment || typeof priorAssignment.selector !== "string") throw new Error("Expected the accepted Developer assignment before reopen");
    const priorSelector = priorAssignment.selector;
    const priorHandle = AgentExecutionHandleSchema.parse(priorAssignment.handle);
    const priorBinding = (await session.panes.getRoleBinding(priorSelector)).value;
    expect(priorBinding).toEqual(retainedDevelopers[0]);
    session.close();
    session = undefined;

    // up again: the same durable session and Conversation session; the Runtime reopens on the republished manifest.
    const up2 = await lifecycle().up();
    if (up2.schemaVersion !== 3) throw new Error("resumed bflow up must publish a Director manifest v3");
    expect(up2).toMatchObject({ status: "up", sessionId: up1.sessionId, conversationSessionId: up1.conversationSessionId });
    expect(up2.panes.map(p => p.role).sort()).toEqual(up1.panes.map(p => p.role).sort());
    await expectPublishedManifest(activations.at(-1), up2, repo);
    noLegacyAgents();
    const resumedPanes = publishedPanes(up2);
    resumedPanes.bindings.push(...retainedDevelopers);
    expect(resumedPanes.bindings.filter(pane => pane.role === "developer")).toEqual(retainedDevelopers);
    expect(resumedPanes.manifest()).toEqual(up2);
    const restoredBinding = (await resumedPanes.getRoleBinding(priorSelector)).value;
    expect(restoredBinding).toEqual(priorBinding);
    if (!restoredBinding) throw new Error("The retained fake Developer allocation must resolve after reopen");
    expect({ agentId: restoredBinding.agentId, paneId: restoredBinding.paneId, session: restoredBinding.session,
      worktreePath: restoredBinding.worktreePath }).toEqual({ agentId: priorHandle.target.agentId, paneId: priorHandle.target.paneId,
      session: priorHandle.target.session, worktreePath: priorHandle.target.worktreePath });
    const { session: resumed, authorized } = await createWebDirectorSession({ root, panes: resumedPanes, inspectRun: true });
    session = resumed;
    cleanups.push(async () => resumed.close());
    resumed.trackRun(runId, started.correlationId);
    expect((await resumed.inspect(runId)).status).toBe("implementing");
    const resumedDirector = await resumed.endpoint.register({ provider: "claude" });
    await resumed.runtime.tick();
    // The accepted assignment is reconciled, never resent after restart.
    expect(assignments(resumed)).toBe(0);
    const resumedAssignment = (await resumed.state()).outbound.find((out: any) => out.message.message_id === priorAssignment.message.message_id);
    expect(resumedAssignment?.status).toBe("accepted");
    expect(resumedAssignment?.selector).toBe(priorSelector);
    expect(AgentExecutionHandleSchema.parse(resumedAssignment?.handle)).toEqual(priorHandle);
    await resumed.evidence(runId); await resumed.submit(runId);
    for (let pass = 0; pass < 6 && (await resumed.inspect(runId)).status !== "awaiting_approval"; pass++) await resumed.tickWithReviewer();
    const delivery = await resumed.inspect(runId);
    expect(delivery).toMatchObject({ status: "awaiting_approval", approvalKind: "delivery", approval: { status: "pending" },
      workflowCycle: { status: "passed" }, tasks: [{ cycle: { status: "passed" } }] });
    // A chat message and the Director token cannot approve delivery. Only the fake human's structured Web decision below can.
    const { bridge } = directorWebBridge(resumed);
    expect((await bridge.send({ apiVersion: 1, messageId: randomUUID(), projectId: PROJECT_ID,
      sessionId: up2.conversationSessionId, content: "duyệt", runId })).ok).toBe(true);
    await expect(resumed.endpoint.call(resumedDirector.token, "approve", { runId })).rejects.toThrow("Unknown Director tool: approve");
    await resumed.runtime.tick();
    expect((await resumed.inspect(runId)).approval).toEqual(delivery.approval);
    expect((await resumed.inspect(runId)).status).toBe("awaiting_approval");
    expect(resumed.humanDecisions).toHaveLength(0);
    expect(authorized).toHaveLength(0);
    await resumed.chat.reconcileApprovals();
    const pending = (await resumed.chat.getContext() as any).pendingApprovals[delivery.approval.approvalId];
    expect(pending).toBeDefined();
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: PROJECT_ID,
      kind: "answer_decision", runId, decisionId: pending.approvalId, outcome: "approved",
      expectedVersion: { revisionToken: projectionToken(pending), approvalId: pending.approvalId, target: pending.target,
        revision: pending.revision, generation: pending.generation, evidenceDigest: projectionToken(pending.evidence) } });
    // Existing E17/E18 fake human authentication accepts only the exact decision recorded by the structured gateway.
    // This fixture principal is not a live signed human receipt and grants no authority to a real run.
    const principal = { ...webPrincipal(command), hostSessionId: up2.sessionId };
    const answered = await resumed.chat.handleStructuredInteraction(command, principal as never);
    expect(answered.ok, answered.ok ? undefined : JSON.stringify(answered.error).slice(0, 1000)).toBe(true);
    expect(resumed.humanDecisions).toHaveLength(1);
    const decision = resumed.humanDecisions[0]!;
    expect(decision).toMatchObject({ approvalId: delivery.approval.approvalId, runId, decision: "approved", decidedBy: "human-1" });
    await resumed.runtime.flushOutbound();
    expect(authorized.length).toBeGreaterThan(0);
    for (const accepted of authorized) expect(accepted).toEqual(decision);
    await resumed.runtime.tick();
    const finalRun = await resumed.inspect(runId);
    const finalState = await resumed.state();
    const completionDiagnostic = {
      status: finalRun.status,
      tasks: finalRun.tasks.map((task: any) => ({ taskId: task.taskId, resultStatus: task.result?.status,
        writerReleased: task.writerReleased, verificationPending: task.verificationPending })),
      assignments: finalState.outbound.filter((out: any) => out.message.run_id === runId && out.message.type === "task.assignment")
        .map((out: any) => ({ status: out.status, selector: out.selector,
          selectorPresent: resumed.panes.bindings.some(pane => [pane.role, pane.bindingId, pane.paneId, pane.agentId].includes(out.selector)) }))
    };
    // Bounded structural diagnostics only: no prompts, payloads, credentials, source text or native-session tokens.
    expect(finalRun.status, JSON.stringify(completionDiagnostic).slice(0, 4000)).toBe("completed");
    expect(resumed.transport.sentRequests.some(r => ["coordinator", "conversation"].includes(r.role))).toBe(false);

    await lifecycle().down(true);
  }, 180_000);
});
