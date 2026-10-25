import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import {
  effectiveRegressionScope,
  openPersistedAgenticHost,
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
