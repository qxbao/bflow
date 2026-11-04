import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRequestSchema, ExecutionResolutionSourcesSchema } from "@bflow/contracts";
import { canonicalPlanDigest } from "../../src/planning/index.js";
import { parseAgenticJournalState } from "../../src/agentic/journal.js";
import { ensureAgenticHost, openPersistedAgenticHost } from "../../dist/agentic/host-controller.js";
import {
  effectiveFastPathMode,
  effectiveRegressionScope,
  readHostConfiguration,
  type AgenticHostOptions
} from "../../src/agentic/host-controller.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

const basePolicy: NonNullable<AgenticHostOptions["policy"]> = {
  sdd: { minimumLevel: "lightweight", approvalRequired: true },
  tdd: { policy: "conditional" },
  verification: { maxIterations: 3, onExhausted: "require_human" },
  concurrency: { maxConcurrency: 2 }
};

describe.skipIf(process.platform !== "linux")("empty stopped host execution-source recovery", () => {
  async function fixture(pinned = true) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-source-recovery-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "herdr-fixture.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
    const watched = join(root, "settings.json");
    const sources = (model: string) => ExecutionResolutionSourcesSchema.parse({ schemaVersion: 3,
      plan: { schemaVersion: 3, resolverVersion: "test", policyVersion: "test", repository: { revision: "baseline" }, mode: "intake" },
      files: [{ component: "native-settings", path: watched, format: "json",
        ...(pinned ? { expectedDigest: canonicalPlanDigest({ model }) } : {}) }] });
    await writeFile(watched, JSON.stringify({ model: "before-trust" }));
    const options = { repositoryPath: root, sessionId: "source-recovery", herdrBinary: binary };
    const original = await ensureAgenticHost({ ...options, executionResolution: sources("before-trust") });
    cleanup.push(() => original.shutdown().catch(() => undefined));
    const configPath = join(root, ".bflow/state/host/source-recovery/host.json");
    const before = await readHostConfiguration(configPath);
    const owner = JSON.parse(await readFile(join(before.directory, "owner.json"), "utf8"));
    const stop = async () => {
      await original.shutdown();
      await vi.waitFor(() => expect(() => process.kill(owner.pid, 0)).toThrow(), { timeout: 5000, interval: 20 });
    };
    return { root, watched, options, original, configPath, before, sources, stop };
  }

  it("refreshes a freshly resolved startup snapshot after trust changes without replacing host identity", async () => {
    const { root, watched, options, configPath, before, sources, stop } = await fixture();
    await stop();
    await writeFile(watched, JSON.stringify({ model: "after-trust" }));
    const fresh = sources("after-trust");
    const recovered = await ensureAgenticHost({ ...options, executionResolution: fresh });
    cleanup.push(() => recovered.shutdown().catch(() => undefined));
    const after = await readHostConfiguration(configPath);
    expect(after.executionResolution).toEqual(fresh);
    expect(after.executionSourceDigests?.["native-settings"]).toBe(canonicalPlanDigest({ model: "after-trust" }));
    expect({ token: after.token, socketPath: after.socketPath, directory: after.directory })
      .toEqual({ token: before.token, socketPath: before.socketPath, directory: before.directory });
  }, 30_000);

  it.each(["inbox", "missing-owner", "live-owner-missing-socket"])(
    "guards changed unpinned source contents against %s without rewriting authority", async scenario => {
      const { root, watched, options, configPath, before, sources, stop } = await fixture(false);
      await stop();
      await writeFile(watched, JSON.stringify({ model: "after-trust" }));
      if (scenario === "missing-owner") await rm(join(before.directory, "owner.json"));
      if (scenario === "live-owner-missing-socket")
        await writeFile(join(before.directory, "owner.json"), JSON.stringify({ pid: process.pid }));
      if (scenario === "inbox") {
        const directory = join(root, ".bflow/state/agentic/journal");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const state = { version: 1, repository: root, runs: [], outbound: [], pendingCore: [], pendingVerifications: [],
          inbox: [{ status: "applied", message: { schema_version: 2, message_id: "prior-message", correlation_id: "prior-correlation",
            run_id: "prior-run", sender: { role: "coordinator" }, recipient: { role: "conversation" },
            type: "conversation.progress", payload: {}, artifact_references: [] } }] };
        parseAgenticJournalState(state, root);
        await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
      }
      const bytes = await readFile(configPath);
      await expect(ensureAgenticHost({ ...options, executionResolution: sources("after-trust") }).then(controller => {
        cleanup.push(() => controller.shutdown().catch(() => undefined)); return controller;
      })).rejects.toThrow();
      expect(await readFile(configPath)).toEqual(bytes);
    }, 30_000);

  it.each([false, true])("ignores observation-only changes when reusing a host (stopped=%s)", async stopped => {
    const { root, options, configPath, sources, stop } = await fixture();
    if (stopped) {
      await stop();
      const directory = join(root, ".bflow/state/agentic/journal");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Existing durable history must not make a health observation look like new execution authority.
      const state = { version: 1, repository: root, runs: [], outbound: [], pendingCore: [], pendingVerifications: [],
        inbox: [{ status: "applied", message: { schema_version: 2, message_id: "prior-message", correlation_id: "prior-correlation",
          run_id: "prior-run", sender: { role: "coordinator" }, recipient: { role: "conversation" },
          type: "conversation.progress", payload: {}, artifact_references: [] } }] };
      parseAgenticJournalState(state, root);
      await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
    }
    const fresh = sources("before-trust");
    fresh.plan.observations = [{ id: "gateway-health", status: "observed", checkedAt: new Date().toISOString(),
      source: { kind: "runtime", locator: "machine.state/setup-gateway-ready.json" } }];
    const before = await readFile(configPath);
    const reused = await ensureAgenticHost({ ...options, executionResolution: fresh });
    cleanup.push(() => reused.shutdown().catch(() => undefined));
    expect(await readFile(configPath)).toEqual(before);
  }, 30_000);

  it.each(["live-host", "live-owner-missing-socket", "missing-owner", "malformed-owner", "malformed-journal",
    "foreign-journal", "existing-run", "unknown-delivery", "inbox", "persisted-reopen", "stale-fresh-sources"])(
    "refuses %s without changing durable authority or starting a replacement", async scenario => {
      const { root, watched, options, configPath, before, sources, stop } = await fixture();
      if (scenario !== "live-host") await stop();
      await writeFile(watched, JSON.stringify({ model: "after-trust" }));
      const ownerPath = join(before.directory, "owner.json");
      if (scenario === "live-owner-missing-socket") await writeFile(ownerPath, JSON.stringify({ pid: process.pid }));
      if (scenario === "missing-owner") await rm(ownerPath);
      if (scenario === "malformed-owner") await writeFile(ownerPath, JSON.stringify({ pid: "invalid" }));
      if (["malformed-journal", "foreign-journal", "existing-run", "unknown-delivery", "inbox"].includes(scenario)) {
        const directory = join(root, ".bflow/state/agentic/journal");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const message = { schema_version: 2, message_id: "message-1", correlation_id: "correlation-1", run_id: "run-1",
          sender: { role: "coordinator" }, recipient: { role: "developer" }, type: "task.status", payload: {}, artifact_references: [] };
        const run = { runId: "run-1", status: "cancelled", coreCreated: false, cancelled: true, maxIterations: 3, tasks: [],
          delegation: { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1",
            sessionId: options.sessionId, runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Prior work",
            objective: "Keep previous workflow binding", specificationId: "spec-1", sddLevel: "lightweight", inputArtifacts: [],
            acceptanceCriteria: [{ id: "ac-1", description: "Preserve history", category: "functional", verificationMethod: "unit_test",
              required: true, status: "pending", evidenceArtifactIds: [] }], priority: "normal",
            requestedAt: new Date().toISOString(), idempotencyKey: "intake-1" } };
        const state = { version: 1, repository: root, runs: scenario === "existing-run" ? [run] : [],
          outbound: scenario === "unknown-delivery" ? [{ message, status: "unknown_delivery", selector: "developer",
            taskId: "task-1", attemptId: "attempt-1", capabilities: [], request: AgentRequestSchema.parse({
              requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", role: "developer",
              target: { transport: "herdr", agentId: "developer-1", paneId: "pane-1" }, instruction: "Preserve delivery",
              inputs: [], attempt: 1, retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
              timeout: { executionTimeoutMs: 1000, onTimeout: "fail" },
              idempotency: { key: "request-1", scope: "agent-request", fingerprint: "request-1" }, createdAt: new Date().toISOString()
            }) }] : [],
          inbox: scenario === "inbox" ? [{ message, status: "received" }] : [], pendingCore: [], pendingVerifications: [] };
        // Ensure the nonempty cases really are valid workflow state, not merely malformed fixtures.
        if (["existing-run", "unknown-delivery", "inbox"].includes(scenario)) parseAgenticJournalState(state, root);
        await writeFile(join(directory, "state.json"), scenario === "malformed-journal" ? "{" :
          JSON.stringify(scenario === "foreign-journal" ? { ...state, repository: "/foreign" } : state), { mode: 0o600 });
      }
      const bytes = await readFile(configPath);
      const log = await readFile(join(before.directory, "host.log"));
      const operation = scenario === "persisted-reopen" ? openPersistedAgenticHost(options) : ensureAgenticHost({ ...options,
        executionResolution: sources(scenario === "stale-fresh-sources" ? "before-trust" : "after-trust") });
      await expect(operation).rejects.toThrow();
      expect(await readFile(configPath)).toEqual(bytes);
      expect(await readFile(join(before.directory, "host.log"))).toEqual(log);
      if (scenario !== "live-host") await expect(readFile(before.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    }, 30_000);
});

describe("persisted host policy regressionScope recovery", () => {
  it("treats persisted host policy without regressionScope as mapped_only", () => {
    expect(effectiveRegressionScope(basePolicy, true)).toBe("mapped_only");
    expect(effectiveRegressionScope(basePolicy, false)).toBe("affected");
    expect(effectiveRegressionScope(undefined, false)).toBe("mapped_only");
    expect(effectiveRegressionScope(undefined, true)).toBe("mapped_only");
    expect(
      effectiveRegressionScope(
        {
          ...basePolicy,
          verification: { ...basePolicy.verification, regressionScope: "full" }
        },
        true
      )
    ).toBe("full");
  });

  it("rejects persisted host.json with unknown regressionScope", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-recovery-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sessionId = "session-1";
    const directory = join(root, ".bflow", "state", "host", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hostJsonPath = join(directory, "host.json");
    await writeFile(
      hostJsonPath,
      JSON.stringify({
        repositoryPath: root,
        sessionId,
        directory,
        socketPath: join(directory, "host.sock"),
        token: "secret-token",
        policy: {
          ...basePolicy,
          verification: {
            ...basePolicy.verification,
            regressionScope: "bogus"
          }
        }
      }),
      { mode: 0o600 }
    );

    await expect(readHostConfiguration(hostJsonPath)).rejects.toThrow("Invalid persisted host policy");
    await expect(openPersistedAgenticHost({ repositoryPath: root, sessionId })).rejects.toThrow(
      "Invalid persisted host policy"
    );
  });

  it("persisted host policy without fastPath is valid and treated as off", async () => {
    expect(effectiveFastPathMode(basePolicy, true)).toBe("off");
    expect(effectiveFastPathMode(basePolicy, false)).toBe("auto");
    expect(effectiveFastPathMode(undefined, false)).toBe("off");
    expect(effectiveFastPathMode(undefined, true)).toBe("off");
    expect(
      effectiveFastPathMode(
        {
          ...basePolicy,
          fastPath: { mode: "auto" }
        },
        true
      )
    ).toBe("auto");
    expect(
      effectiveFastPathMode(
        {
          ...basePolicy,
          fastPath: { mode: "off" }
        },
        false
      )
    ).toBe("off");

    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-fastpath-valid-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sessionId = "session-fastpath-valid";
    const directory = join(root, ".bflow", "state", "host", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hostJsonPath = join(directory, "host.json");
    await writeFile(
      hostJsonPath,
      JSON.stringify({
        repositoryPath: root,
        sessionId,
        directory,
        socketPath: join(directory, "host.sock"),
        token: "secret-token",
        policy: basePolicy
      }),
      { mode: 0o600 }
    );

    const configuration = await readHostConfiguration(hostJsonPath);
    expect(effectiveFastPathMode(configuration.policy, true)).toBe("off");

    if (process.platform === "linux") {
      const binary = join(root, "herdr-fixture.mjs");
      await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
      await writeFile(
        hostJsonPath,
        JSON.stringify({
          repositoryPath: root,
          sessionId,
          directory,
          socketPath: join(directory, "host.sock"),
          token: "secret-token",
          herdrBinary: binary,
          policy: basePolicy
        }),
        { mode: 0o600 }
      );
      const recovered = await openPersistedAgenticHost({ repositoryPath: root, sessionId });
      cleanup.push(() => recovered.shutdown().catch(() => undefined));
      const afterRecover = await readHostConfiguration(hostJsonPath);
      expect(effectiveFastPathMode(afterRecover.policy, true)).toBe("off");
      await recovered.shutdown();

      const impactIndex = {
        executable: join(root, "bin", "gitnexus"),
        home: join(root, "state", "gitnexus", "gitnexus-home"),
        storageLockPath: join(root, "state", "gitnexus", "gitnexus-storage-test.lock")
      };
      const reopened = await ensureAgenticHost({
        repositoryPath: root,
        sessionId,
        herdrBinary: binary,
        impactIndex,
        policy: {
          ...basePolicy,
          verification: { ...basePolicy.verification, regressionScope: "affected" },
          fastPath: { mode: "auto" }
        }
      });
      cleanup.push(() => reopened.shutdown().catch(() => undefined));
      const afterReopen = await readHostConfiguration(hostJsonPath);
      expect(effectiveFastPathMode(afterReopen.policy, true)).toBe("auto");
      expect(effectiveRegressionScope(afterReopen.policy, true)).toBe("affected");
      expect(afterReopen.impactIndex).toEqual(impactIndex);
    }
  });

  it("rejects invalid persisted fastPath.mode", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-fastpath-invalid-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sessionId = "session-fastpath-invalid";
    const directory = join(root, ".bflow", "state", "host", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hostJsonPath = join(directory, "host.json");
    await writeFile(
      hostJsonPath,
      JSON.stringify({
        repositoryPath: root,
        sessionId,
        directory,
        socketPath: join(directory, "host.sock"),
        token: "secret-token",
        policy: {
          ...basePolicy,
          fastPath: {
            mode: "bogus"
          }
        }
      }),
      { mode: 0o600 }
    );

    await expect(readHostConfiguration(hostJsonPath)).rejects.toThrow("Invalid persisted host policy");
    await expect(openPersistedAgenticHost({ repositoryPath: root, sessionId })).rejects.toThrow(
      "Invalid persisted host policy"
    );
  });

  it.skipIf(process.platform !== "linux")("persists and reloads impactIndex in host.json", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-impact-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "herdr-fixture.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
    const sessionId = "session-impact";
    const impactIndex = {
      executable: join(root, "bin", "gitnexus"),
      home: join(root, "state", "gitnexus", "gitnexus-home"),
      storageLockPath: join(root, "state", "gitnexus", "gitnexus-storage-test.lock")
    };
    const host = await ensureAgenticHost({
      repositoryPath: root,
      sessionId,
      herdrBinary: binary,
      impactIndex
    } as AgenticHostOptions);
    cleanup.push(() => host.shutdown().catch(() => undefined));

    const hostJsonPath = join(root, ".bflow", "state", "host", sessionId, "host.json");
    const configuration = await readHostConfiguration(hostJsonPath);
    expect(configuration.impactIndex).toEqual(impactIndex);
  });

  it("rejects persisted host.json when impactIndex.home is relative or contains null byte", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-impact-invalid-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const sessionId = "session-invalid-impact";
    const directory = join(root, ".bflow", "state", "host", sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hostJsonPath = join(directory, "host.json");
    await writeFile(
      hostJsonPath,
      JSON.stringify({
        repositoryPath: root,
        sessionId,
        directory,
        socketPath: join(directory, "host.sock"),
        token: "secret-token",
        impactIndex: {
          executable: "/usr/local/bin/gitnexus",
          home: "relative/gitnexus-home",
          storageLockPath: "/var/lib/bflow/gitnexus.lock"
        }
      }),
      { mode: 0o600 }
    );

    await expect(readHostConfiguration(hostJsonPath)).rejects.toThrow("Invalid persisted host");
    await expect(openPersistedAgenticHost({ repositoryPath: root, sessionId })).rejects.toThrow(
      "Invalid persisted host"
    );

    await writeFile(
      hostJsonPath,
      JSON.stringify({
        repositoryPath: root,
        sessionId,
        directory,
        socketPath: join(directory, "host.sock"),
        token: "secret-token",
        impactIndex: {
          executable: "/usr/local/bin/gitnexus",
          home: "/var/lib/bflow/gitnexus\0home",
          storageLockPath: "/var/lib/bflow/gitnexus.lock"
        }
      }),
      { mode: 0o600 }
    );

    await expect(readHostConfiguration(hostJsonPath)).rejects.toThrow("Invalid persisted host");
  });
});

it('reopens a live owner for quiesce despite stale execution sources while preserving startup validation',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'bflow-live-owner-drift-')));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const sessionId='drift-recovery',binary=join(root,'herdr-fixture.mjs');await writeFile(binary,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n',{mode:0o700});
 const controller=await ensureAgenticHost({repositoryPath:root,sessionId,herdrBinary:binary});cleanup.push(()=>controller.shutdown().catch(()=>undefined));
 const path=join(root,'.bflow/state/host',sessionId,'host.json');const {readFile}=await import('node:fs/promises');const saved=JSON.parse(await readFile(path,'utf8'));
 // A persisted execution source no longer exists; stop/recovery must connect without granting execution.
 saved.executionResolution={schemaVersion:3,plan:{schemaVersion:3,resolverVersion:'1',policyVersion:'1',repository:{revision:'abc'},mode:'intake'},files:[{component:'project-config',path:join(root,'missing.json'),format:'json'}]};
 await writeFile(path,JSON.stringify(saved),{mode:0o600});
 const reopened=await openPersistedAgenticHost({repositoryPath:root,sessionId});
 expect(await reopened.quiesce()).toMatchObject({ok:true});await reopened.shutdown();
 await expect(ensureAgenticHost({repositoryPath:root,sessionId,herdrBinary:binary,executionResolution:saved.executionResolution})).rejects.toThrow();
});

it('refreshes inactive source snapshots only from explicit resolved startup and keeps persisted recovery fail-closed',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'bflow-resolved-restart-')));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const binary=join(root,'herdr.mjs');await writeFile(binary,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n',{mode:0o700});
 const sourcePath=join(root,'source.json');await writeFile(sourcePath,'{"model":"haiku"}');
 const source={schemaVersion:3 as const,plan:{schemaVersion:3,resolverVersion:'1',policyVersion:'1',repository:{revision:'abc'},mode:'intake'},files:[{component:'project-config',path:sourcePath,format:'json' as const}]};
 const first=await ensureAgenticHost({repositoryPath:root,sessionId:'resolved-restart',herdrBinary:binary,executionResolution:source});cleanup.push(()=>first.shutdown().catch(()=>undefined));
 expect(await first.quiesce()).toMatchObject({ok:true});await first.shutdown();
 await writeFile(sourcePath,'{"model":"haiku","effort":"low"}');
 const next=await ensureAgenticHost({repositoryPath:root,sessionId:'resolved-restart',herdrBinary:binary,executionResolution:source});cleanup.push(()=>next.shutdown().catch(()=>undefined));
 expect(await next.quiesce()).toMatchObject({ok:true});await next.shutdown();
});
