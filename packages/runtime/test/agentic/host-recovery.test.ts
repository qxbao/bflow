import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
