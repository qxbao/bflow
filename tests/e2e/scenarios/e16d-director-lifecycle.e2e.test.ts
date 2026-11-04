import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentLifecycle, openPaneManagerEnvironment, readEnvironmentConfig, identifyRepository, runCli } from "@bflow/cli";
import { CreateCheckpointCommandSchema, SessionManifestV3Schema, type CreateCheckpointCommand, type RecoveryCheckpoint, type SessionManifest,
  type SessionManifestV3 } from "@bflow/contracts";
import { DirectorPanes, createDirectorSession, documentationSpecification, git, singleTaskWorkflow, type DirectorSession } from "../helpers/director-session.js";
import { HerdrWireRunner } from "../helpers/herdr-wire-runner.js";

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
    expect(activations.at(-1)).toEqual(up1);
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
    session.close();
    session = undefined;

    // up again: the same durable session and Conversation session; the Runtime reopens on the republished manifest.
    const up2 = await lifecycle().up();
    if (up2.schemaVersion !== 3) throw new Error("resumed bflow up must publish a Director manifest v3");
    expect(up2).toMatchObject({ status: "up", sessionId: up1.sessionId, conversationSessionId: up1.conversationSessionId });
    expect(up2.panes.map(p => p.role).sort()).toEqual(up1.panes.map(p => p.role).sort());
    expect(activations.at(-1)).toEqual(up2);
    noLegacyAgents();
    const resumed = await createDirectorSession({ root, panes: publishedPanes(up2), inspectRun: true });
    session = resumed;
    cleanups.push(async () => resumed.close());
    resumed.trackRun(runId, started.correlationId);
    expect((await resumed.inspect(runId)).status).toBe("implementing");
    await resumed.endpoint.register({ provider: "claude" });
    await resumed.runtime.tick();
    // The accepted assignment is reconciled, never resent after restart.
    expect(assignments(resumed)).toBe(0);
    await resumed.evidence(runId); await resumed.submit(runId);
    for (let pass = 0; pass < 6 && (await resumed.inspect(runId)).status !== "completed"; pass++) await resumed.tickWithReviewer();
    expect((await resumed.inspect(runId)).status).toBe("completed");
    expect(resumed.transport.sentRequests.some(r => ["coordinator", "conversation"].includes(r.role))).toBe(false);

    await lifecycle().down(true);
  }, 180_000);
});
