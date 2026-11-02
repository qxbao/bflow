import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTestRunners, parseTscBuildArgs } from "../../src/agentic/runner-detection.js";
import { isRecognizedAssertionMessage, matchesExpectedIdentity, resolveExpectedIdentities } from "../../src/agentic/node-tap.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { InspectInputSchema } from "../../src/agentic/mcp-output-views.js";
import { ReadTaskLogInputSchema } from "../../src/agentic/task-log-tools.js";
import { unmeasuredPolicyPhaseRequests } from "../../src/agentic/phase-recovery.js";
import type { JournalState, RunRecord, Outbound } from "../../src/agentic/journal.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createFixture(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "f06-r4-attack-")));
  temporaryRoots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

describe("Flow 06 Round 4 — Developer execution, tools & runner hardening", () => {
  describe("Vector 2: Red evidence recognized for valid failing tests", () => {
    it("recognizes modern assertion failure message variants without rejecting as testCodeFailure", () => {
      const validAssertionErrors = [
        "Error: Expected 200, received 404",
        "Error: Expected function to throw an error, but it didn't",
        "Error: Expected 'foo' to equal 'bar'",
        "Error: expected false to be true",
        "Error: Expected value to be truthy",
        "Error: Assertion failed: state must be ready",
        "Assertion failed: value mismatch",
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n+ actual - expected",
        "expect(received).toBe(expected) // Object.is equality",
        "Error: expect(received).toStrictEqual(expected)",
        "[ERR_ASSERTION]: expected 1 to be 2"
      ];
      for (const msg of validAssertionErrors) {
        expect(isRecognizedAssertionMessage(msg)).toBe(true);
      }
    });
  });

  describe("Vector 3: Green test identity matching with file prefix and hierarchy", () => {
    it("matches expected test identity even when prefixed with test file path or suite separators", () => {
      const leaf = {
        ancestors: ["Calculator"],
        title: "adds numbers",
        rawName: "Calculator > adds numbers"
      };

      // Exact name
      expect(matchesExpectedIdentity(leaf, "Calculator adds numbers")).toBe(true);
      expect(matchesExpectedIdentity(leaf, "Calculator > adds numbers")).toBe(true);

      // File path prefixed
      expect(matchesExpectedIdentity(leaf, "test/math.test.ts > Calculator > adds numbers")).toBe(true);
      expect(matchesExpectedIdentity(leaf, "test/math.test.ts: Calculator > adds numbers")).toBe(true);
      expect(matchesExpectedIdentity(leaf, "math.test.ts::Calculator::adds numbers")).toBe(true);

      // Suffix title
      expect(matchesExpectedIdentity(leaf, "adds numbers")).toBe(true);
    });

    it("resolves expected identities with file prefix in resolveExpectedIdentities", () => {
      const leaves = [
        { ancestors: ["Calculator"], title: "adds numbers", rawName: "Calculator > adds numbers" }
      ];
      const expected = ["test/math.test.ts > Calculator > adds numbers"];
      const resolved = resolveExpectedIdentities(leaves, expected);
      expect(resolved.matched).toBe(true);
      if (resolved.matched) {
        expect(resolved.canonicalNames).toEqual(expected);
      }
    });
  });

  describe("Vector 4: Tool inputs from model with nulls, extra fields, and aliases", () => {
    it("ReadTaskLogInputSchema accepts snake_case aliases and extra fields", () => {
      const input = {
        run_id: "run-123",
        task_id: "task-456",
        max_bytes: 4096,
        model_comment: "diagnostic check"
      };
      const parsed = ReadTaskLogInputSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.runId).toBe("run-123");
        expect(parsed.data.taskId).toBe("task-456");
        expect(parsed.data.maxBytes).toBe(4096);
      }
    });
  });

  describe("Vector 5: MCP output views / cursors invalid after restart", () => {
    it("TaskActivityLog.readWithMeta gracefully handles stale or rotated cursor after restart", async () => {
      const root = await createFixture();
      const logPath = join(root, "activity.log");
      const log = TaskActivityLog.open(logPath);

      await log.record({ kind: "progress", role: "developer", action: "Step 1", runId: "r1", taskId: "t1" });
      await log.record({ kind: "progress", role: "developer", action: "Step 2", runId: "r1", taskId: "t1" });

      // Stale cursor with an id that does not exist in the log (e.g. from previous session/restart)
      const staleAfterId = "00000000-0000-0000-0000-000000000000";
      await expect(log.readWithMeta({ runId: "r1", taskId: "t1", afterId: staleAfterId })).resolves.toBeDefined();
    });
  });

  describe("Vector 8: task_policy_phase_pending does not hang when verifier lease expires", () => {
    it("unmeasuredPolicyPhaseRequests recovers an accepted phase request whose lease has expired", () => {
      const pastTime = new Date(Date.now() - 60_000).toISOString();
      const run: RunRecord = {
        runId: "run-1",
        status: "implementing",
        delegation: { correlationId: "c1" },
        tasks: [
          {
            taskId: "t1",
            state: "running",
            worktrees: [],
            spec: {
              specification: {} as any,
              strategy: {
                tddDecision: { mode: "required" },
                metadata: { tddEvidence: [] }
              } as any
            }
          }
        ]
      } as any;

      const state: JournalState = {
        inbox: [],
        runs: [run],
        outbound: [
          {
            status: "accepted",
            lease: { leaseId: "l1", role: "qa", acquiredAt: pastTime, expiresAt: pastTime, fencingToken: 1 },
            message: {
              schema_version: 2,
              message_id: "phase-t1-red",
              run_id: "run-1",
              type: "verification.requested",
              payload: {
                kind: "conditional_evidence",
                taskId: "t1",
                phase: "red",
                implementationAttemptId: "att-1"
              }
            }
          } as Outbound,
          {
            status: "accepted",
            taskId: "t1",
            handle: { attemptId: "att-1" },
            message: {
              schema_version: 2,
              message_id: "assign-t1",
              run_id: "run-1",
              type: "task.assignment"
            }
          } as Outbound
        ]
      } as any;

      const unmeasured = unmeasuredPolicyPhaseRequests(state, run);
      expect(unmeasured.length).toBe(1);
      expect(unmeasured[0]!.message.message_id).toBe("phase-t1-red");
    });
  });
});
