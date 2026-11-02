import { describe, expect, it, vi } from "vitest";
import { AgentExecutionHandleSchema, AgentRequestSchema } from "@bflow/contracts";
import type { OperationResult } from "@bflow/contracts";
import { HerdrCliTransport, createProcessRunner } from "../src/index.js";
import type { CommandInvocation, CommandOutcome } from "../src/index.js";
import { operationBudget } from "../src/operation-budget.js";
import { SingleFlight } from "../src/single-flight.js";

const BASE_TIME = "2026-10-31T00:00:00.000Z";
const BASE_TARGET = {
  transport: "herdr",
  agentId: "worker",
  workspaceId: "w1",
  tabId: "t1",
  paneId: "p1",
  terminalId: "term1",
  session: { source: "codex", kind: "id" as const, value: "s1" }
};

const makeAgent = (patch: Record<string, unknown> = {}) => ({
  agent: "codex",
  name: "worker",
  agent_status: "working",
  workspace_id: "w1",
  tab_id: "t1",
  pane_id: "p1",
  terminal_id: "term1",
  revision: 1,
  state_change_seq: 2,
  agent_session: { source: "codex", agent: "codex", kind: "id", value: "s1" },
  ...patch
});

const okEnvelope = (type: string, info = makeAgent()): CommandOutcome => ({
  exitCode: 0,
  stdout: JSON.stringify({ id: "1", result: { type, agent: info } }),
  stderr: ""
});

const makeRequest = (overrides: Record<string, unknown> = {}) =>
  AgentRequestSchema.parse({
    requestId: "req-1",
    attemptId: "att-1",
    runId: "run-1",
    taskId: "task-1",
    role: "implementer",
    target: BASE_TARGET,
    instruction: "run tests",
    inputs: [],
    attempt: 1,
    retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
    timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" },
    idempotency: { key: "idem-1", scope: "agent-request", fingerprint: "fp-1" },
    createdAt: BASE_TIME,
    ...overrides
  });

const makeHandle = (overrides: Record<string, unknown> = {}) =>
  AgentExecutionHandleSchema.parse({
    executionId: "exec-1",
    requestId: "req-1",
    attemptId: "att-1",
    runId: "run-1",
    taskId: "task-1",
    idempotencyKey: "idem-1",
    target: BASE_TARGET,
    correlation: { token: "req-1", provenance: "orchestrator", verified: false },
    acceptedAt: BASE_TIME,
    ...overrides
  });

describe("Slice 3 Herdr adapter hardening regressions", () => {
  it("H1 (P02-RA01): createProcessRunner does not overflow 32-bit setTimeout (> 2_147_483_647 ms) into 1ms premature kill", async () => {
    const runner = createProcessRunner("/bin/sh");
    const outcome = await runner.run({
      args: ["-c", "sleep 0.03; printf ok"],
      timeoutMs: 3_000_000_000
    });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("ok");
  });

  it("H1 (P02-RA01): SingleFlight chains >32-bit duplicate wait timers instead of firing prematurely at 2_147_483_647 ms", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = Date.parse(BASE_TIME);
      const clock = () => new Date(nowMs);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });

      const adapter = new HerdrCliTransport({
        clock,
        runner: {
          async run(inv: CommandInvocation) {
            if (inv.args[1] === "get") return okEnvelope("agent_info");
            entered();
            await gate;
            return okEnvelope("agent_prompted");
          }
        }
      });

      const owner = adapter.send(makeRequest(), { timeoutMs: 4_000_000_000 });
      await started;

      let duplicateSettled = false;
      const duplicate = adapter
        .send(makeRequest(), { timeoutMs: 3_000_000_000 })
        .finally(() => {
          duplicateSettled = true;
        });

      nowMs += 2_147_483_647;
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(duplicateSettled).toBe(false);

      nowMs += 852_516_353;
      await vi.advanceTimersByTimeAsync(852_516_353);
      expect(await duplicate).toMatchObject({
        ok: false,
        error: { code: "unknown_delivery", retryable: false }
      });

      release();
      expect(await owner).toMatchObject({ ok: true, value: { status: "accepted" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("H2: operationBudget handles negative out-of-range clocks, sub-ms timeouts, and backward clock skew under deadline-only options", async () => {
    expect(() =>
      operationBudget({ timeoutMs: 1_000 }, () => new Date(-9e15), 30_000)
    ).not.toThrow();
    expect(operationBudget({ timeoutMs: 1_000 }, () => new Date(-9e15), 30_000)).toMatchObject({
      ok: false,
      error: { code: "validation", retryable: false }
    });

    const subMs = operationBudget({ timeoutMs: 0.4 }, () => new Date(1_000), 30_000);
    expect(subMs.ok).toBe(true);
    if (subMs.ok) {
      expect(Date.parse(subMs.value.deadline!) > 1_000).toBe(true);
    }

    let nowMs = Date.parse(BASE_TIME);
    const seenTimeouts: number[] = [];
    const adapter = new HerdrCliTransport({
      defaultTimeoutMs: 30_000,
      clock: () => new Date(nowMs),
      runner: {
        async run(inv) {
          seenTimeouts.push(inv.timeoutMs ?? -1);
          if (inv.args[1] === "get") {
            // Simulate NTP stepping wall clock backward by 5 seconds between substeps
            nowMs -= 5_000;
            return okEnvelope("agent_info");
          }
          return okEnvelope("agent_prompted");
        }
      }
    });

    const res = await adapter.send(makeRequest(), {
      deadline: new Date(Date.parse(BASE_TIME) + 120).toISOString()
    });
    expect(res).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(seenTimeouts).toEqual([120, 120]);
  });

  it("H2: wait() pre-validates until states before spawning inspect and passes positive integer --timeout", async () => {
    let nowMs = Date.parse(BASE_TIME);
    const calls: CommandInvocation[] = [];
    const adapter = new HerdrCliTransport({
      clock: () => new Date(nowMs),
      runner: {
        async run(inv) {
          calls.push(inv);
          if (inv.args[1] === "get") {
            nowMs += 37;
            return okEnvelope("agent_info");
          }
          return okEnvelope("agent_info", makeAgent({ agent_status: "done" }));
        }
      }
    });

    const invalid = await adapter.wait(makeHandle(), { until: ["not_a_state" as never] });
    expect(invalid).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    expect(calls).toHaveLength(0);

    const okRes = await adapter.wait(makeHandle(), { timeoutMs: 50, until: ["done"] });
    expect(okRes).toMatchObject({ ok: true, value: { state: "done" } });
    const waitCall = calls.find((c) => c.args[1] === "wait");
    expect(waitCall?.args).toEqual(["agent", "wait", "p1", "--timeout", "13", "--until", "done"]);

    // Exhaust budget during inspect -> must fail with timeout (not_started for wait step, or observation_only) without invoking `agent wait --timeout 0`
    calls.length = 0;
    const exhausted = await adapter.wait(makeHandle(), { timeoutMs: 30, until: ["done"] });
    expect(exhausted).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(calls.some((c) => c.args[1] === "wait")).toBe(false);
  });

  it("H3: createProcessRunner does not hang when child spawns background grandchild inheriting stdout/stderr and preserves split UTF-8", async () => {
    const runner = createProcessRunner("/bin/sh");

    // 1. Parent exits 0 while background grandchild holds stdout/stderr open for 10s
    const start = Date.now();
    const outcome = await runner.run({
      args: ["-c", 'sleep 10 & printf \'{"gcPid":%d}\' "$!"; exit 0'],
      timeoutMs: 8_000
    });
    const elapsed = Date.now() - start;
    let gcPid: number | undefined;
    try {
      gcPid = (JSON.parse(outcome.stdout) as { gcPid?: number }).gcPid;
    } finally {
      if (gcPid) {
        try {
          process.kill(gcPid, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }
    expect(outcome.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3_000);

    // 2. Multi-byte UTF-8 emoji split across two pipe chunks
    const utf8Outcome = await runner.run({
      args: ["-c", 'printf "\\360\\237"; sleep 0.02; printf "\\232\\200"'],
      timeoutMs: 5_000
    });
    expect(utf8Outcome.exitCode).toBe(0);
    expect(utf8Outcome.stdout).toBe("🚀");
  });

  it("H4: oversized argv pre-exec E2BIG is classified as non-retryable validation (started: false) and releases SingleFlight", async () => {
    const runner = createProcessRunner("/bin/sh");
    const oversized = "x".repeat(200_000);
    const raw = await runner.run({ args: ["-c", ":", oversized], timeoutMs: 5_000 });
    expect(raw.started).toBe(false);
    expect(raw.failure).toBe("invalid_arguments");
    expect(raw.cause).toContain("E2BIG");

    // Verify HerdrCliTransport maps pre-exec E2BIG to non-retryable validation without poisoning unknown_delivery
    let attempt = 0;
    const adapter = new HerdrCliTransport({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv) {
          if (inv.args[1] === "get") return okEnvelope("agent_info");
          attempt++;
          if (attempt === 1) return raw;
          return okEnvelope("agent_prompted");
        }
      }
    });

    const first = await adapter.send(makeRequest());
    expect(first).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    // Same idempotency key + same payload can cleanly retry if transient or inspected, and reconcile does not report bound
    const second = await adapter.send(makeRequest());
    expect(second).toMatchObject({ ok: true, value: { status: "accepted" } });
  });

  it("H5: SingleFlight settles joiners even if onError throws; reconcile handles providerData key order/deep clone; non-zero exit parses stdout JSON fallback", async () => {
    // 1. SingleFlight resilience when action rejects and onError throws
    const sf = new SingleFlight<string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p1 = sf.execute(
      "k1",
      "fp1",
      async () => {
        await gate;
        throw new Error("boom");
      },
      () => {
        throw new Error("onError exploded");
      }
    );
    const p2 = sf.execute(
      "k1",
      "fp1",
      async () => ({ ok: true, value: "unused" }),
      () => {
        throw new Error("joiner onError exploded");
      },
      {
        options: {},
        clock: () => new Date(BASE_TIME),
        interrupted: () => ({
          ok: false,
          error: { code: "cancelled", retryable: false, message: "interrupted" }
        })
      }
    );
    release();
    const [r1, r2]: [OperationResult<string>, OperationResult<string>] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);

    // 2. reconcile() canonical target comparison & deep-clone isolation on providerData
    const targetOrderA = {
      ...BASE_TARGET,
      providerData: { b: 2, a: 1, nested: { state: "clean" } }
    };
    const targetOrderB = {
      ...BASE_TARGET,
      providerData: { a: 1, b: 2, nested: { state: "clean" } }
    };
    const adapter = new HerdrCliTransport({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv) {
          return inv.args[1] === "get" ? okEnvelope("agent_info") : okEnvelope("agent_prompted");
        }
      }
    });
    const sent = await adapter.send(makeRequest({ target: targetOrderA }));
    expect(sent).toMatchObject({ ok: true, value: { status: "accepted" } });

    const rec1 = await adapter.reconcile({
      requestId: "req-1",
      attemptId: "att-1",
      runId: "run-1",
      taskId: "task-1",
      idempotencyKey: "idem-1",
      target: targetOrderB,
      requestedAt: BASE_TIME
    });
    expect(rec1).toMatchObject({ ok: true, value: { status: "bound" } });
    if (rec1.ok && rec1.value.status === "bound") {
      (rec1.value.handle.target.providerData as Record<string, any>).nested.state = "mutated";
    }
    const rec2 = await adapter.reconcile({
      requestId: "req-1",
      attemptId: "att-1",
      runId: "run-1",
      taskId: "task-1",
      idempotencyKey: "idem-1",
      target: targetOrderB,
      requestedAt: BASE_TIME
    });
    expect(rec2).toMatchObject({
      ok: true,
      value: {
        status: "bound",
        handle: { target: { providerData: { nested: { state: "clean" } } } }
      }
    });

    // 3. Structured JSON error written to stdout on non-zero exit code
    const stdoutErrAdapter = new HerdrCliTransport({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run() {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              id: "1",
              error: { code: "pane_not_found", message: "Pane missing on stdout" }
            }),
            stderr: ""
          };
        }
      }
    });
    expect(await stdoutErrAdapter.wait(makeHandle())).toMatchObject({
      ok: false,
      error: { code: "not_found", retryable: false, message: "Pane missing on stdout" }
    });
  });
});
