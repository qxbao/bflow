import { describe, expect, it } from "vitest";
import { createHerdrAdapter, createProcessRunner } from "../src/index.js";
import type { CommandInvocation, CommandOutcome } from "../src/index.js";
import { scheduleSafeTimeout } from "../src/operation-budget.js";
import { SingleFlight } from "../src/single-flight.js";

const BASE_TIME = "2026-10-31T12:00:00.000Z";

function agentPayload(overrides: Record<string, unknown> = {}) {
  return {
    agent: "codex",
    name: "developer-1",
    agent_status: "working",
    workspace_id: "ws-1",
    tab_id: "tab-1",
    pane_id: "w1:pE",
    terminal_id: "term-1",
    revision: 7,
    cwd: "/repo",
    foreground_cwd: "/repo",
    state_change_seq: 3,
    agent_session: {
      agent: "codex",
      source: "herdr-test",
      kind: "id",
      value: "sess-1"
    },
    ...overrides
  };
}

function okEnvelope(type: string, agentOverrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "req-1",
    result: {
      type,
      agent: agentPayload(agentOverrides)
    }
  });
}

function makeTarget(overrides: Record<string, unknown> = {}) {
  return {
    transport: "herdr" as const,
    agentId: "developer-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    paneId: "w1:pE",
    terminalId: "term-1",
    session: {
      source: "herdr-test",
      kind: "id" as const,
      value: "sess-1"
    },
    ...overrides
  };
}

function makeHandle(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "exec-1",
    requestId: "req-1",
    attemptId: "att-1",
    runId: "run-1",
    taskId: "task-1",
    idempotencyKey: "idem-1",
    target: makeTarget(),
    correlation: {
      token: "req-1",
      provenance: "orchestrator" as const,
      verified: false
    },
    acceptedAt: BASE_TIME,
    ...overrides
  };
}

function makeSendRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    attemptId: "att-1",
    runId: "run-1",
    taskId: "task-1",
    role: "implementer" as const,
    target: makeTarget(),
    instruction: "Implement feature X",
    workingDirectory: "/repo",
    inputs: [],
    attempt: 1,
    retry: {
      maxAttempts: 1,
      strategy: "fixed" as const,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitter: false
    },
    timeout: {
      executionTimeoutMs: 1_000,
      onTimeout: "fail" as const
    },
    idempotency: {
      key: "idem-1",
      scope: "agent-request" as const,
      fingerprint: "f1"
    },
    createdAt: BASE_TIME,
    ...overrides
  };
}

describe("Round 2 Slice 03 — Herdr Adapter Adversarial Hardening", () => {
  it("R2-H1: classifies disappeared pane/target/session accurately across wait/read/cancel/reconcile (JSON codes & plain-text CLI errors), distinguishes daemon unavailability, tolerates CLI log noise, and keeps post-write send fail-closed", async () => {
    // 1. Plain-text CLI non-zero exit "agent target w1:pE not found" during wait/read/reconcile
    const plainNotFoundAdapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(): Promise<CommandOutcome> {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Error: agent target w1:pE not found\n",
            started: true
          };
        }
      }
    });

    const waitNotFound = await plainNotFoundAdapter.wait(makeHandle(), { until: ["idle"] });
    expect(waitNotFound).toMatchObject({
      ok: false,
      error: { code: "not_found", retryable: false }
    });

    const readEvents = [];
    for await (const item of plainNotFoundAdapter.read(makeHandle())) {
      readEvents.push(item);
    }
    expect(readEvents).toMatchObject([
      { ok: false, error: { code: "not_found", retryable: false } }
    ]);

    const reconciled = await plainNotFoundAdapter.reconcile({
      requestId: "req-1",
      attemptId: "att-1",
      runId: "run-1",
      taskId: "task-1",
      idempotencyKey: "idem-missing",
      target: makeTarget(),
      requestedAt: BASE_TIME
    });
    expect(reconciled).toMatchObject({
      ok: true,
      value: {
        status: "unknown_delivery",
        retrySafe: false,
        manualInterventionRequired: true
      }
    });
    if (reconciled.ok && reconciled.value.status === "unknown_delivery") {
      expect(reconciled.value.reason).toContain("agent target w1:pE not found");
    }

    // 2. Extended structured JSON error codes (target_not_found, session_not_found, generic cli_error with target-not-found message)
    for (const remoteError of [
      { code: "target_not_found", message: "Target pane w1:pE does not exist" },
      { code: "session_not_found", message: "Herdr session bf-123 not found" },
      { code: "workspace_not_found", message: "Workspace ws-1 not found" },
      { code: "cli_error", message: "agent target w1:pE not found in active session" }
    ]) {
      const jsonErrAdapter = createHerdrAdapter({
        clock: () => new Date(BASE_TIME),
        runner: {
          async run(): Promise<CommandOutcome> {
            return {
              exitCode: 1,
              stdout: "",
              stderr: JSON.stringify({ id: "1", error: remoteError }),
              started: true
            };
          }
        }
      });
      const res = await jsonErrAdapter.wait(makeHandle(), { until: ["done"] });
      expect(res).toMatchObject({
        ok: false,
        error: { code: "not_found", retryable: false }
      });
    }

    // 3. Cancel where target disappears between #inspect and send-keys returns not_found (authoritatively rejected by Herdr)
    const cancelRaceAdapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv: CommandInvocation): Promise<CommandOutcome> {
          if (inv.args[1] === "get") {
            return { exitCode: 0, stdout: okEnvelope("agent_info"), stderr: "", started: true };
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Error: agent target w1:pE not found\n",
            started: true
          };
        }
      }
    });
    const cancelRes = await cancelRaceAdapter.cancel(makeHandle(), {
      schemaVersion: 1,
      cancellationId: "cancel-1",
      runId: "run-1",
      taskId: "task-1",
      executionId: "exec-1",
      requestedBy: "human",
      expectedVersion: 1,
      idempotencyKey: "cancel-idem-1",
      reason: "user_cancelled",
      requestedAt: BASE_TIME
    });
    expect(cancelRes).toMatchObject({
      ok: false,
      error: { code: "not_found", retryable: false }
    });

    // 4. Plain-text daemon socket unavailability maps to retryable transport_unavailable, NOT corruption
    const daemonDownAdapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(): Promise<CommandOutcome> {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Error: failed to connect to herdr daemon socket (/run/user/1000/herdr.sock): ECONNREFUSED\n",
            started: true
          };
        }
      }
    });
    const daemonRes = await daemonDownAdapter.wait(makeHandle(), { until: ["idle"] });
    expect(daemonRes).toMatchObject({
      ok: false,
      error: { code: "transport_unavailable", retryable: true }
    });

    // 5. Leading/trailing CLI diagnostic warning lines around valid JSON envelope do not trigger false corruption
    const noisyAdapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv: CommandInvocation): Promise<CommandOutcome> {
          const type = inv.args[1] === "wait" ? "agent_info" : "agent_info";
          return {
            exitCode: 0,
            stdout: `[herdr] warning: experimental flag ignored\n${okEnvelope(type, { agent_status: "idle" })}\n`,
            stderr: "",
            started: true
          };
        }
      }
    });
    const noisyWait = await noisyAdapter.wait(makeHandle(), { until: ["idle"] });
    expect(noisyWait).toMatchObject({
      ok: true,
      value: { state: "idle" }
    });

    // 6. INVARIANT: Post-write submit (`agent prompt` with started: true) MUST remain strictly fail-closed (`unknown_delivery`)
    const postWriteFailAdapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv: CommandInvocation): Promise<CommandOutcome> {
          if (inv.args[1] === "get") {
            return {
              exitCode: 0,
              stdout: okEnvelope("agent_info", { agent_status: "idle" }),
              stderr: "",
              started: true
            };
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Error: agent target w1:pE not found\n",
            started: true
          };
        }
      }
    });
    const sendRes = await postWriteFailAdapter.send(makeSendRequest());
    expect(sendRes).toMatchObject({
      ok: true,
      value: {
        status: "unknown_delivery",
        resendAllowed: false,
        manualInterventionRequired: true
      }
    });
  });

  it("R2-H2: SingleFlight owner pre-side-effect abort/timeout does not poison concurrent joiners with valid budget, and scheduleSafeTimeout guards NaN/Infinity", async () => {
    let inspectCalls = 0;
    let promptCalls = 0;

    const adapter = createHerdrAdapter({
      clock: () => new Date(BASE_TIME),
      runner: {
        async run(inv: CommandInvocation): Promise<CommandOutcome> {
          if (inv.args[1] === "get") {
            inspectCalls++;
            const callNo = inspectCalls;
            if (callNo === 1) {
              return await new Promise<CommandOutcome>((resolve) => {
                const onAbort = () =>
                  resolve({
                    exitCode: null,
                    stdout: "",
                    stderr: "",
                    failure: "aborted",
                    started: false
                  });
                if (inv.signal?.aborted) {
                  onAbort();
                  return;
                }
                inv.signal?.addEventListener("abort", onAbort, { once: true });
              });
            }
            return {
              exitCode: 0,
              stdout: okEnvelope("agent_info", { agent_status: "idle" }),
              stderr: "",
              started: true
            };
          }
          promptCalls++;
          return {
            exitCode: 0,
            stdout: okEnvelope("agent_prompted", { agent_status: "working" }),
            stderr: "",
            started: true
          };
        }
      }
    });

    const ownerAbort = new AbortController();
    const joinerAbort = new AbortController();
    const req = makeSendRequest({
      idempotency: {
        key: "idem-shared-join",
        scope: "agent-request" as const,
        fingerprint: "f1"
      }
    });

    const ownerPromise = adapter.send(req, { signal: ownerAbort.signal, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 15));
    const joinerPromise = adapter.send(req, { signal: joinerAbort.signal, timeoutMs: 5_000 });

    // Abort owner while #inspect (`agent get`, pre-side-effect) is in flight
    ownerAbort.abort();

    const [ownerOutcome, joinerOutcome] = await Promise.all([ownerPromise, joinerPromise]);
    expect(ownerOutcome).toMatchObject({
      ok: false,
      error: { code: "cancelled" }
    });
    expect(joinerOutcome).toMatchObject({
      ok: true,
      value: { status: "accepted" }
    });
    expect(promptCalls).toBe(1);

    // Direct SingleFlight test: owner hits pre-start budget timeout (`retrySafety: "not_started"`), healthy joiner takes over
    const sf = new SingleFlight<string>();
    let attempts = 0;
    const ownerRun = sf.execute(
      "k-timeout",
      "fp-1",
      async () => {
        attempts++;
        if (attempts === 1) {
          await new Promise((r) => setTimeout(r, 20));
          return {
            ok: false,
            error: {
              code: "timeout",
              retryable: true,
              retrySafety: "not_started",
              message: "Owner short budget elapsed before start"
            }
          };
        }
        return { ok: true, value: "succeeded-on-joiner" };
      },
      () => ({ ok: false, error: { code: "corruption", retryable: false, message: "unexpected" } })
    );
    const joinerRun = sf.execute(
      "k-timeout",
      "fp-1",
      async () => {
        attempts++;
        return { ok: true, value: "succeeded-on-joiner" };
      },
      () => ({ ok: false, error: { code: "corruption", retryable: false, message: "unexpected" } }),
      {
        options: { deadline: "2026-10-31T12:00:10.000Z" },
        clock: () => new Date(BASE_TIME),
        interrupted: () => ({
          ok: false,
          error: { code: "cancelled", retryable: false, message: "interrupted" }
        })
      }
    );

    const [r1, r2] = await Promise.all([ownerRun, joinerRun]);
    expect(r1).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(r2).toEqual({ ok: true, value: "succeeded-on-joiner" });

    // scheduleSafeTimeout handles Infinity and NaN cleanly
    let firedInfinity = false;
    const cancelInf = scheduleSafeTimeout(() => {
      firedInfinity = true;
    }, Number.POSITIVE_INFINITY);
    await new Promise((r) => setTimeout(r, 15));
    cancelInf();
    expect(firedInfinity).toBe(false);

    let firedNaN = false;
    const cancelNaN = scheduleSafeTimeout(() => {
      firedNaN = true;
    }, Number.NaN);
    await new Promise((r) => setTimeout(r, 20));
    cancelNaN();
    expect(firedNaN).toBe(true);
  });

  it("R2-H3: createProcessRunner refreshes post-exit pipe drain while stdout chunks actively arrive, still bounds idle grandchild FD leaks, and reports pre-exec ENOENT code", async () => {
    const runner = createProcessRunner(process.execPath);

    // 1. Active post-exit pipe chunks arriving across >60ms window after parent exit must NOT be truncated at 50ms
    const activeStreamScript = [
      "const { spawn } = require('node:child_process');",
      "const writerCode = [",
      "  \"process.stdout.write('{\\\"part1\\\":\\\"' + 'A'.repeat(2048) + '\\\",');\",",
      "  \"setTimeout(() => process.stdout.write('\\\"part2\\\":\\\"' + 'B'.repeat(2048) + '\\\",'), 35);\",",
      "  \"setTimeout(() => { process.stdout.write('\\\"part3\\\":\\\"done\\\"}'); process.exit(0); }, 75);\"",
      "].join(' ');",
      "const child = spawn(process.execPath, ['-e', writerCode], { detached: true, stdio: 'inherit' });",
      "child.unref();",
      "process.exit(0);"
    ].join(" ");

    const streamOutcome = await runner.run({
      args: ["-e", activeStreamScript],
      timeoutMs: 3_000
    });
    expect(streamOutcome.exitCode).toBe(0);
    expect(streamOutcome.failure).toBeUndefined();
    const parsed = JSON.parse(streamOutcome.stdout) as {
      part1: string;
      part2: string;
      part3: string;
    };
    expect(parsed.part1.length).toBe(2048);
    expect(parsed.part2.length).toBe(2048);
    expect(parsed.part3).toBe("done");

    // 2. Idle grandchild holding stdout FD open without writing still settles promptly (< 500ms)
    const idleLeakScript = [
      "const { spawn } = require('node:child_process');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { detached: true, stdio: 'inherit' });",
      "gc.unref();",
      "process.stdout.write(JSON.stringify({ gcPid: gc.pid }));",
      "process.exit(0);"
    ].join(" ");
    const t0 = Date.now();
    const idleOutcome = await runner.run({
      args: ["-e", idleLeakScript],
      timeoutMs: 3_000
    });
    const elapsed = Date.now() - t0;
    const gcInfo = JSON.parse(idleOutcome.stdout) as { gcPid?: number };
    if (gcInfo.gcPid) {
      try {
        process.kill(gcInfo.gcPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    expect(idleOutcome.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(600);

    // 3. Pre-exec ENOENT reports started: false, failure: "spawn", and safe errno code in cause without raw binary path
    const missingBin = "/nonexistent/bflow-secret-path/herdr-missing-binary";
    const enoentOutcome = await createProcessRunner(missingBin).run({
      args: ["--version"],
      timeoutMs: 1_000
    });
    expect(enoentOutcome.started).toBe(false);
    expect(enoentOutcome.failure).toBe("spawn");
    expect(enoentOutcome.cause).toContain("ENOENT");
    expect(enoentOutcome.cause).not.toContain(missingBin);
  });
});
