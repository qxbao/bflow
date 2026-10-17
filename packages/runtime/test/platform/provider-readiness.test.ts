import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentEnvironment,
  AgentEnvironmentSchema,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type PermissionProfile,
  type SkillManifest
} from "@bflow/contracts";
import {
  ClaudeProviderAdapter,
  type LiveReadinessObservation,
  type ProviderAdapterOptions,
  type ProviderCommandRunner,
  createFakeProviderRunner
} from "@bflow/agent-providers";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import type {
  LaunchJournalEntry,
  LaunchJournalPort,
  ProviderAdapterContext,
  ProviderAdapterFactory
} from "../../src/platform/ports.js";

const SKILL_DIGEST = "1".repeat(64);
const NATIVE_SESSION = { source: "claude", kind: "id" as const, value: "native-session-1" };
const PANE_ID = "pane-developer-1";

const LIVE_READY: LiveReadinessObservation = {
  paneId: PANE_ID,
  transportState: "idle",
  interactiveReady: true,
  nativeSession: NATIVE_SESSION
};

class MemoryJournal implements LaunchJournalPort {
  readonly entries_: LaunchJournalEntry[] = [];
  async append(entry: LaunchJournalEntry): Promise<void> {
    this.entries_.push(entry);
  }
  async entries(): Promise<readonly LaunchJournalEntry[]> {
    return [...this.entries_];
  }
}

describe("ProviderReadiness", () => {
  let baseDir: string;
  let workspace: string;
  let stateDirectory: string;
  let binaryPath: string;
  let skillManifest: SkillManifest;
  let environment: AgentEnvironment;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-provider-readiness-")));
    workspace = join(baseDir, "workspace");
    stateDirectory = join(baseDir, "state");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(workspace, 0o700);
    await chmod(stateDirectory, 0o700);

    binaryPath = join(baseDir, "claude");
    await writeFile(binaryPath, "#!/bin/sh\necho ok\n", { mode: 0o700 });
    await chmod(binaryPath, 0o700);

    const scope = {
      kind: "session" as const,
      machineId: "mach-1",
      repositoryId: "repo-1",
      workspaceRoot: workspace,
      sessionId: "sess-1"
    };
    const permissionProfile: PermissionProfile = {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      profileId: "perm-claude-developer",
      mode: "workspace_auto",
      scope,
      filesystem: "workspace_write",
      readableRoots: [workspace],
      writableRoots: [workspace],
      deniedRoots: [join(workspace, ".secret")],
      isolation: "provider_policy",
      network: { mode: "deny", allowedHosts: [] },
      allowedTools: ["Read", "Edit"],
      deniedAction: "request_via_conversation",
      allowGlobalPermissionBypass: false
    };
    environment = AgentEnvironmentSchema.parse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environmentId: "env-claude-developer-1",
      provider: "claude",
      role: "developer",
      scope,
      cwd: workspace,
      stateDirectory,
      configFingerprint: "a".repeat(64),
      permissionProfile,
      environmentVariables: { BUILD_ENV: "test" },
      secretBindings: { API_TOKEN: "secret://vault/dev-token" },
      requiredCapabilityIds: ["claude-implementation"],
      requiredMcpServiceIds: [],
      skillManifestDigest: SKILL_DIGEST
    });
    // An empty but schema-valid manifest: the adapter verifies role and digest only.
    skillManifest = {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      manifestId: "skills-claude-developer-1",
      environmentId: environment.environmentId,
      scope,
      role: "developer",
      provider: "claude",
      digest: SKILL_DIGEST,
      skills: [],
      bindings: []
    } as SkillManifest;
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function contextFor(overrides?: Partial<ProviderAdapterContext>): ProviderAdapterContext {
    return {
      mcpRegistrations: [],
      mcpObservations: [],
      skillManifest,
      renderedSkillsContent: "",
      trustedIssuerKeys: {},
      ...overrides
    };
  }

  /** Real Claude adapter; context fields are passed straight through as adapter options. */
  function realFactory(runner: ProviderCommandRunner, executablePath = binaryPath): ProviderAdapterFactory {
    return (provider, context) => {
      if (provider !== "claude") throw new Error(`test factory only builds claude, got ${provider}`);
      const options: ProviderAdapterOptions = {
        ...context,
        executablePath,
        runner,
        allowTestFilesystemOwnership: true
      };
      return new ClaudeProviderAdapter(options);
    };
  }

  function readinessWith(
    factory: ProviderAdapterFactory,
    journal: LaunchJournalPort = new MemoryJournal(),
    now?: () => Date
  ): ProviderReadiness {
    return new ProviderReadiness({ factory, journal, ...(now !== undefined ? { now } : {}) });
  }

  const healthyRunner = () => createFakeProviderRunner({ scenario: "healthy" });

  it("caches a ready preflight and reports it fresh for the same environment", async () => {
    const readiness = readinessWith(realFactory(healthyRunner()));

    const preflight = await readiness.preflight(environment, contextFor());
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.value.status).toBe("ready");
    expect(preflight.value.stage).toBe("preflight");
    expect(preflight.value.checks.every((check) => check.status === "passed")).toBe(true);

    const fresh = readiness.assertFresh(environment.environmentId, environment.configFingerprint);
    expect(fresh.ok).toBe(true);
  });

  it("fails closed when the binary is missing", async () => {
    const journal = new MemoryJournal();
    const readiness = readinessWith(realFactory(healthyRunner(), join(baseDir, "missing-claude")), journal);

    const preflight = await readiness.preflight(environment, contextFor());
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.error.code).toBe("validation");
    expect(preflight.error.message).toContain("blocked");
    const details = preflight.error.details as { status: string; checks: Array<{ check: string; status: string }> };
    expect(details.status).toBe("blocked");
    expect(details.checks.find((check) => check.check === "binary")?.status).toBe("failed");

    expect(readiness.assertFresh(environment.environmentId, environment.configFingerprint).ok).toBe(false);
    expect(journal.entries_).toHaveLength(0);
  });

  it("fails closed on an authentication failure and scrubs provider secrets from the result", async () => {
    const readiness = readinessWith(realFactory(createFakeProviderRunner({ scenario: "auth_expired" })));

    const preflight = await readiness.preflight(environment, contextFor());
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    const serialized = JSON.stringify(preflight.error);
    expect(serialized).toContain("auth_expired");
    expect(serialized).not.toContain("sk-secret-12345");
    expect(readiness.assertFresh(environment.environmentId, environment.configFingerprint).ok).toBe(false);
  });

  it("refuses prepareLaunch without a fresh preflight and journals nothing", async () => {
    const journal = new MemoryJournal();
    const readiness = readinessWith(realFactory(healthyRunner()), journal);

    const launch = await readiness.prepareLaunch(environment, contextFor(), 1);
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error.code).toBe("conflict");
    expect(journal.entries_).toHaveLength(0);
  });

  it("journals the intent before prepareLaunch resolves", async () => {
    const events: string[] = [];
    const journal: LaunchJournalPort = {
      async append(entry) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        events.push(`append:${entry.kind}`);
      },
      async entries() {
        return [];
      }
    };
    const readiness = readinessWith(realFactory(healthyRunner()), journal);
    expect((await readiness.preflight(environment, contextFor())).ok).toBe(true);

    const launch = await readiness.prepareLaunch(environment, contextFor(), 2);
    events.push("resolved");
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(events).toEqual(["append:intent", "resolved"]);
    expect(launch.value.environment).toEqual(environment);
    expect(launch.value.expiresAt > new Date().toISOString()).toBe(true);
  });

  it("records an intent carrying the launch fingerprint and generation", async () => {
    const journal = new MemoryJournal();
    const readiness = readinessWith(realFactory(healthyRunner()), journal);
    await readiness.preflight(environment, contextFor());

    const launch = await readiness.prepareLaunch(environment, contextFor(), 3);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(journal.entries_).toEqual([
      expect.objectContaining({
        kind: "intent",
        launchId: launch.value.launchId,
        role: "developer",
        provider: "claude",
        environmentId: environment.environmentId,
        configFingerprint: environment.configFingerprint,
        launchFingerprint: launch.value.launchFingerprint,
        generation: 3
      })
    ]);
  });

  it("rejects a non-positive launch generation", async () => {
    const readiness = readinessWith(realFactory(healthyRunner()));
    await readiness.preflight(environment, contextFor());
    const launch = await readiness.prepareLaunch(environment, contextFor(), 0);
    expect(launch.ok).toBe(false);
  });

  it("does not treat a different config fingerprint as the cached environment", async () => {
    const readiness = readinessWith(realFactory(healthyRunner()));
    await readiness.preflight(environment, contextFor());

    const other = readiness.assertFresh(environment.environmentId, "c".repeat(64));
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe("conflict");

    const changed = { ...environment, configFingerprint: "c".repeat(64) };
    const launch = await readiness.prepareLaunch(changed, contextFor(), 1);
    expect(launch.ok).toBe(false);
  });

  it("refuses a launch when the environment content changed after preflight", async () => {
    const readiness = readinessWith(realFactory(healthyRunner()));
    await readiness.preflight(environment, contextFor());

    const drifted = AgentEnvironmentSchema.parse({
      ...environment,
      environmentVariables: { BUILD_ENV: "other" }
    });
    const launch = await readiness.prepareLaunch(drifted, contextFor(), 1);
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error.message).toContain("environment changed");
  });

  it("expires cached health after its TTL using the injected clock", async () => {
    let clock = new Date();
    const readiness = readinessWith(realFactory(healthyRunner()), new MemoryJournal(), () => clock);
    expect((await readiness.preflight(environment, contextFor())).ok).toBe(true);

    clock = new Date(clock.getTime() + 4 * 60_000);
    expect(readiness.assertFresh(environment.environmentId, environment.configFingerprint).ok).toBe(true);
    expect((await readiness.prepareLaunch(environment, contextFor(), 1)).ok).toBe(true);

    clock = new Date(clock.getTime() + 2 * 60_000);
    const expired = readiness.assertFresh(environment.environmentId, environment.configFingerprint);
    expect(expired.ok).toBe(false);
    const launch = await readiness.prepareLaunch(environment, contextFor(), 2);
    expect(launch.ok).toBe(false);
  });

  it("activates a launch with a signed attestation and matching live observation", async () => {
    const journal = new MemoryJournal();
    const readiness = readinessWith(realFactory(healthyRunner()), journal);
    expect((await readiness.preflight(environment, contextFor())).ok).toBe(true);
    const launch = await readiness.prepareLaunch(environment, contextFor(), 1);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;

    const signer = Ed25519LaunchAttestationSigner.generate("bflow-test-host");
    const activation = await readiness.verifyActivated({
      profile: launch.value,
      context: contextFor({ liveObservation: LIVE_READY }),
      paneId: PANE_ID,
      nativeSession: NATIVE_SESSION,
      signer
    });

    expect(activation.ok).toBe(true);
    if (!activation.ok) return;
    expect(activation.value.stage).toBe("activated");
    expect(activation.value.status).toBe("ready");
    expect(activation.value.launchAttestation?.launchId).toBe(launch.value.launchId);
    expect(activation.value.launchAttestation?.paneId).toBe(PANE_ID);
    expect(journal.entries_.map((entry) => entry.kind)).toEqual(["intent", "attested", "activated"]);
    expect(readiness.assertFresh(environment.environmentId, environment.configFingerprint).ok).toBe(true);
  });

  it("does not authorize a new launch from activated health alone", async () => {
    const readiness = readinessWith(realFactory(healthyRunner()));
    expect((await readiness.preflight(environment, contextFor())).ok).toBe(true);
    const launch = await readiness.prepareLaunch(environment, contextFor(), 1);
    if (!launch.ok) throw new Error("expected launch");

    const signer = Ed25519LaunchAttestationSigner.generate("bflow-test-host");
    const activation = await readiness.verifyActivated({
      profile: launch.value,
      context: contextFor({ liveObservation: LIVE_READY }),
      paneId: PANE_ID,
      nativeSession: NATIVE_SESSION,
      signer
    });
    expect(activation.ok).toBe(true);

    const second = await readiness.prepareLaunch(environment, contextFor(), 2);
    expect(second.ok).toBe(false);
  });

  it("journals a failed activation and returns failure when the observation is not ready", async () => {
    const journal = new MemoryJournal();
    const readiness = readinessWith(realFactory(healthyRunner()), journal);
    expect((await readiness.preflight(environment, contextFor())).ok).toBe(true);
    const launch = await readiness.prepareLaunch(environment, contextFor(), 1);
    if (!launch.ok) throw new Error("expected launch");

    const signer = Ed25519LaunchAttestationSigner.generate("bflow-test-host");
    const activation = await readiness.verifyActivated({
      profile: launch.value,
      context: contextFor({ liveObservation: { ...LIVE_READY, interactiveReady: false } }),
      paneId: PANE_ID,
      nativeSession: NATIVE_SESSION,
      signer
    });

    expect(activation.ok).toBe(false);
    const last = journal.entries_.at(-1);
    expect(last).toEqual(expect.objectContaining({
      kind: "failed",
      launchId: launch.value.launchId,
      code: "native_binding_not_interactive_ready"
    }));
    expect(journal.entries_.some((entry) => entry.kind === "activated")).toBe(false);
  });

  it("refuses activation of a profile this readiness instance did not prepare", async () => {
    const journal = new MemoryJournal();
    const preparing = readinessWith(realFactory(healthyRunner()), journal);
    expect((await preparing.preflight(environment, contextFor())).ok).toBe(true);
    const launch = await preparing.prepareLaunch(environment, contextFor(), 1);
    if (!launch.ok) throw new Error("expected launch");

    const restarted = readinessWith(realFactory(healthyRunner()), journal);
    const activation = await restarted.verifyActivated({
      profile: launch.value,
      context: contextFor({ liveObservation: LIVE_READY }),
      paneId: PANE_ID,
      nativeSession: NATIVE_SESSION,
      signer: Ed25519LaunchAttestationSigner.generate("bflow-test-host")
    });
    expect(activation.ok).toBe(false);
    if (activation.ok) return;
    expect(activation.error.code).toBe("conflict");
  });
});
