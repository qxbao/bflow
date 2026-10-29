import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
