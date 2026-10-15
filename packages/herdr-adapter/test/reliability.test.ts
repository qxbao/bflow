import { describe, expect, it, vi } from "vitest";
import { AgentExecutionHandleSchema, AgentMessageSchema, AgentRequestSchema } from "@bflow/contracts";
import { HerdrCliTransport, createProcessRunner } from "../src/index.js";
import type { CommandInvocation, CommandOutcome } from "../src/index.js";

const time = "2026-10-14T00:00:00.000Z";
const target = { transport: "herdr", agentId: "worker", workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "term1", session: { source: "codex", kind: "id" as const, value: "s1" } };
const agent = (patch: Record<string, unknown> = {}) => ({ agent: "codex", name: "worker", agent_status: "working", workspace_id: "w1", tab_id: "t1", pane_id: "p1", terminal_id: "term1", revision: 1, agent_session: { source: "codex", agent: "codex", kind: "id", value: "s1" }, ...patch });
const response = (type: string, info = agent()): CommandOutcome => ({ exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type, agent: info } }), stderr: "" });
const acknowledged: CommandOutcome = { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" };
const timeout: CommandOutcome = { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true };
const request = () => AgentRequestSchema.parse({ requestId: "r1", attemptId: "a1", runId: "run1", taskId: "task1", role: "implementer", target, instruction: "new prompt", inputs: [], attempt: 1, retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false }, timeout: { executionTimeoutMs: 1000, onTimeout: "fail" }, idempotency: { key: "k1", scope: "agent-request", fingerprint: "f1" }, createdAt: time });
const handle = () => AgentExecutionHandleSchema.parse({ executionId: "e1", requestId: "r1", attemptId: "a1", runId: "run1", taskId: "task1", idempotencyKey: "k1", target, correlation: { token: "r1", provenance: "orchestrator", verified: false }, acceptedAt: time });
const cancellation = () => ({ schemaVersion: 1 as const, cancellationId: "c1", runId: "run1", taskId: "task1", executionId: "e1", requestedBy: "human", requestedAt: time, expectedVersion: 1, idempotencyKey: "cancel1" });
const reconciliation = () => ({ requestId: "r1", attemptId: "a1", runId: "run1", taskId: "task1", idempotencyKey: "k1", target: structuredClone(target), requestedAt: time });

function fixture(respond?: (i: CommandInvocation) => CommandOutcome | Promise<CommandOutcome>, clock: () => Date = () => new Date(time)) {
  const calls: CommandInvocation[] = [];
  const adapter = new HerdrCliTransport({ clock, runner: { run(i) {
    calls.push(i);
    return Promise.resolve(respond ? respond(i) : i.args[1] === "get" ? response("agent_info") : i.args[1] === "prompt" ? response("agent_prompted") : acknowledged);
  } } });
  return { adapter, calls, count: (command: string) => calls.filter(i => i.args[1] === command).length };
}
async function readAll(adapter: HerdrCliTransport, execution = handle()) {
  const messages = [];
  for await (const item of adapter.read(execution)) messages.push(item);
  return messages;
}

describe("P02 reliability regressions", () => {
  it("F01 joins concurrent identical sends and reconciles one binding", async () => {
    const { adapter, count } = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => adapter.send(request())));
    expect(count("prompt")).toBe(1);
    expect(results.every(item => JSON.stringify(item) === JSON.stringify(results[0]))).toBe(true);
    const reconciled = await adapter.reconcile(reconciliation());
    expect(reconciled).toMatchObject({ ok: true, value: { status: "bound" } });
    const first = results[0];
    if (!first?.ok || first.value.status !== "accepted" || !reconciled.ok || reconciled.value.status !== "bound") throw new Error("Expected binding");
    expect(reconciled.value.handle).toEqual(first.value.handle);
  });

  it("F01 rejects a conflicting in-flight fingerprint before a second write", async () => {
    const { adapter, count } = fixture();
    const [first, collision] = await Promise.all([adapter.send(request()), adapter.send({ ...request(), instruction: "different" })]);
    expect(first).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(collision).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(count("prompt")).toBe(1);
  });

  it("duplicate caller abort does not abort or overwrite the shared submission", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { adapter, count } = fixture(async i => {
      if (i.args[1] === "get") return response("agent_info");
      entered(); await gate; return response("agent_prompted");
    });
    const owner = adapter.send(request());
    await started;
    const controller = new AbortController();
    const duplicate = adapter.send(request(), { signal: controller.signal });
    controller.abort();
    expect(await duplicate).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
    release();
    expect(await owner).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(await adapter.reconcile(reconciliation())).toMatchObject({ ok: true, value: { status: "bound" } });
    expect(count("prompt")).toBe(1);
  });

  it("duplicate caller deadline expires without changing the original receipt", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const { adapter, count } = fixture(async i => {
        if (i.args[1] === "get") return response("agent_info");
        entered(); await gate; return response("agent_prompted");
      });
      const owner = adapter.send(request()); await started;
      const duplicate = adapter.send(request(), { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(20);
      expect(await duplicate).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
      release();
      expect(await owner).toMatchObject({ ok: true, value: { status: "accepted" } });
      expect(count("prompt")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("F01 preserves unknown delivery for all duplicates and reconciliation", async () => {
    const { adapter, count } = fixture(i => i.args[1] === "get" ? response("agent_info") : timeout);
    const results = await Promise.all([adapter.send(request()), adapter.send(request())]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false } });
    expect(await adapter.send(request())).toEqual(results[0]);
    expect(await adapter.reconcile(reconciliation())).toMatchObject({ ok: true, value: { status: "unknown_delivery", retrySafe: false } });
    expect(count("prompt")).toBe(1);
  });

  it("F02 joins duplicate cancellations and rejects collision", async () => {
    const { adapter, count } = fixture();
    const [a, b, collision] = await Promise.all([
      adapter.cancel(handle(), cancellation()), adapter.cancel(handle(), cancellation()),
      adapter.cancel(handle(), { ...cancellation(), reason: "changed" })
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(collision).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(count("send-keys")).toBe(1);
  });

  it("F02 retains uncertain cancellation without resending", async () => {
    const { adapter, count } = fixture(i => i.args[1] === "get" ? response("agent_info") : timeout);
    const results = await Promise.all([adapter.cancel(handle(), cancellation()), adapter.cancel(handle(), cancellation())]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
    expect(await adapter.cancel(handle(), cancellation())).toEqual(results[0]);
    expect(count("send-keys")).toBe(1);
  });

  it.each([false, true])("F03 never verifies old-turn snapshot even for incoming verified=%s", async verified => {
    const { adapter } = fixture(i => i.args[1] === "read" ? { exitCode: 0, stdout: "OLD TURN OUTPUT", stderr: "" } : response("agent_info"));
    const execution = handle();
    if (verified) execution.correlation = { token: "external", provenance: "remote", verified: true };
    const result = await readAll(adapter, execution);
    expect(result).toMatchObject([{ ok: true, value: { kind: "status", data: { source: "terminal_snapshot", text: "OLD TURN OUTPUT", correlationVerified: false, executionOutputVerified: false, turnIdentity: "unresolved" } } }]);
    if (result[0]?.ok) expect(AgentMessageSchema.safeParse(result[0].value).success).toBe(true);
  });

  it("F03 new prompt pending cannot make old done/output a verified result", async () => {
    const { adapter } = fixture(i => i.args[1] === "read" ? { exitCode: 0, stdout: "old turn", stderr: "" } : response(i.args[1] === "prompt" ? "agent_prompted" : "agent_info", agent({ agent_status: i.args[1] === "prompt" ? "working" : "done" })));
    const sent = await adapter.send(request());
    if (!sent.ok || sent.value.status !== "accepted") throw new Error("Expected receipt");
    expect(await adapter.wait(sent.value.handle)).toMatchObject({ ok: true, value: { state: "done", correlationVerified: false } });
    expect(await readAll(adapter, sent.value.handle)).toMatchObject([{ ok: true, value: { kind: "status", data: { text: "old turn", correlationVerified: false } } }]);
  });

  it.each(["missing-handle-session", "missing-server-session", "different-session", "different-name"])("F04 fails closed for %s", async scenario => {
    const execution = handle();
    if (scenario === "missing-handle-session") delete execution.target.session;
    const patch = scenario === "missing-server-session" ? { agent_session: null }
      : scenario === "different-session" ? { agent_session: { source: "codex", kind: "id", value: "s2" } }
      : scenario === "different-name" ? { name: "replacement", agent: "worker", agent_session: { source: "codex", agent: "worker", kind: "id", value: "s1" } } : { revision: 999 };
    const { adapter, count } = fixture(() => response("agent_info", agent(patch)));
    const expected = scenario.startsWith("missing") ? "unknown_delivery" : "conflict";
    expect(await adapter.wait(execution)).toMatchObject({ ok: false, error: { code: expected } });
    expect(await readAll(adapter, execution)).toMatchObject([{ ok: false, error: { code: expected } }]);
    expect(await adapter.cancel(execution, cancellation())).toMatchObject({ ok: false, error: { code: expected } });
    expect(count("send-keys")).toBe(0); expect(count("read")).toBe(0); expect(count("wait")).toBe(0);
  });

  it("F04 accepts valid session continuity despite revision changes", async () => {
    const { adapter, count } = fixture(i => i.args[1] === "send-keys" ? acknowledged : response("agent_info", agent({ revision: 999 })));
    expect(await adapter.wait(handle())).toMatchObject({ ok: true, value: { targetRevision: 999, correlationVerified: false } });
    expect(await adapter.cancel(handle(), cancellation())).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(count("send-keys")).toBe(1);
  });

  it.each([{ agent: "different-kind", kind: "id" }, { agent: "codex", kind: "opaque" }])("F04 rejects inconsistent wire session evidence %j", async session => {
    const { adapter, count } = fixture(() => response("agent_info", agent({ agent_session: { source: "codex", value: "s1", ...session } })));
    expect(await adapter.cancel(handle(), cancellation())).toMatchObject({ ok: false, error: { code: "corruption", retryable: false } });
    expect(count("send-keys")).toBe(0);
  });

  it("F04 pins a session discovered at inspect when submission target had none", async () => {
    const data = request(); delete data.target.session;
    const { adapter } = fixture(i => response(i.args[1] === "get" ? "agent_info" : "agent_prompted", agent(i.args[1] === "get" ? {} : { agent_session: { source: "codex", kind: "id", value: "s2" } })));
    expect(await adapter.send(data)).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false } });
  });

  it.each(["different", "missing"])("F04 detects session %s during wait and read", async mode => {
    const patch = mode === "missing" ? { agent_session: null } : { agent_session: { source: "codex", kind: "id", value: "s2" } };
    const expected = mode === "missing" ? "unknown_delivery" : "conflict";
    let inspected = 0;
    const { adapter } = fixture(i => i.args[1] === "read" ? { exitCode: 0, stdout: "must not publish", stderr: "" }
      : response("agent_info", agent(i.args[1] === "wait" || ++inspected > 1 ? patch : {})));
    expect(await adapter.wait(handle())).toMatchObject({ ok: false, error: { code: expected } });
    inspected = 0;
    expect(await readAll(adapter)).toMatchObject([{ ok: false, error: { code: expected } }]);
  });

  it.each([{ deadline: time }, { timeoutMs: 0 }])("F05 no invocation after expired budget %j", async options => {
    const { adapter, calls } = fixture();
    expect(await adapter.send(request(), options)).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(await adapter.cancel(handle(), cancellation(), options)).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(calls).toHaveLength(0);
  });

  it("F05 relative budget ends between inspection and prompt write", async () => {
    let ms = Date.parse(time);
    const { adapter, count } = fixture(() => { ms += 100; return response("agent_info"); }, () => new Date(ms));
    expect(await adapter.send(request(), { timeoutMs: 100 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(count("prompt")).toBe(0);
  });

  it("F05 uses remaining budget across substeps and keeps post-write timeout uncertain", async () => {
    let ms = Date.parse(time);
    const { adapter, calls } = fixture(i => { ms += i.args[1] === "get" ? 40 : 60; return i.args[1] === "get" ? response("agent_info") : timeout; }, () => new Date(ms));
    expect(await adapter.send(request(), { timeoutMs: 100 })).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false } });
    expect(calls.map(i => i.timeoutMs)).toEqual([100, 60]);
  });

  it.each([{ timeoutMs: -1 }, { timeoutMs: NaN }, { deadline: "bad" }])("F05 validates invalid options %j", async options => {
    const { adapter, calls } = fixture();
    expect(await adapter.send(request(), options)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(calls).toHaveLength(0);
  });

  it("F06 startup before launch times out safely without invocation", async () => {
    const { adapter, calls } = fixture();
    expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "p1" }, { timeoutMs: 0 })).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "not_started" } });
    expect(calls).toHaveLength(0);
  });

  it("F06 possible startup timeout requires reconciliation", async () => {
    const { adapter, count } = fixture(() => timeout);
    expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "p1" })).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: expect.stringContaining("inspect") } });
    expect(count("start")).toBe(1);
  });

  it("F06 startup abort after possible launch stays uncertain", async () => {
    const { adapter } = fixture(() => ({ exitCode: null, stdout: "", stderr: "", failure: "aborted", started: true }));
    expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "p1" })).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
  });

  it.each(["throw", "reject"])("F07 runner %s after prompt invocation becomes sticky uncertainty", async mode => {
    const { adapter, count } = fixture(i => {
      if (i.args[1] === "get") return response("agent_info");
      if (mode === "throw") throw new Error("sensitive runner error");
      return Promise.reject(new Error("sensitive runner error"));
    });
    const first = await adapter.send(request());
    expect(first).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false } });
    expect(await adapter.send(request())).toEqual(first);
    expect(count("prompt")).toBe(1);
    expect(JSON.stringify(first)).not.toContain("sensitive runner error");
  });

  it("F07 NUL is typed validation before any command and invalid argv never spawns", async () => {
    const { adapter, calls } = fixture();
    expect(await adapter.send({ ...request(), instruction: "bad\0arg" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(calls).toHaveLength(0);
    expect(await createProcessRunner(process.execPath).run({ args: ["bad\0arg"] })).toMatchObject({ failure: "invalid_arguments", started: false });
  });

  it("F07 observation runner failure stays typed in read stream", async () => {
    const { adapter } = fixture(i => i.args[1] === "get" ? response("agent_info") : Promise.reject(new Error("failure")));
    expect(await readAll(adapter)).toMatchObject([{ ok: false, error: { code: "corruption", retryable: false } }]);
  });

  it("F07 uncertain runner cancellation rejection stays reserved", async () => {
    const { adapter, count } = fixture(i => { if (i.args[1] === "get") return response("agent_info"); throw new Error("cancel rejected"); });
    const [a, b] = await Promise.all([adapter.cancel(handle(), cancellation()), adapter.cancel(handle(), cancellation())]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
    expect(await adapter.cancel(handle(), cancellation())).toEqual(a);
    expect(count("send-keys")).toBe(1);
  });

  it("F07 process timeout and abort report launched state and clean up", async () => {
    const runner = createProcessRunner(process.execPath);
    expect(await runner.run({ args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 100 })).toMatchObject({ failure: "timeout", started: true });
    const controller = new AbortController(); controller.abort();
    expect(await runner.run({ args: [], signal: controller.signal })).toMatchObject({ failure: "aborted", started: false });
    expect(await runner.run({ args: [], timeoutMs: 0 })).toMatchObject({ failure: "timeout", started: false });
    expect(await runner.run({ args: ["-e", "process.stdout.write('x'.repeat(10000))"], maxOutputBytes: 64, timeoutMs: 2000 })).toMatchObject({ failure: "output_limit", started: true });
  });

  it("F07 failed spawn is proven not started and releases safe reservation", async () => {
    let failSpawn = true;
    const { adapter, count } = fixture(i => i.args[1] === "get" ? response("agent_info") : failSpawn ? { exitCode: null, stdout: "", stderr: "", failure: "spawn", started: false } : response("agent_prompted"));
    expect(await adapter.send(request())).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    expect(await adapter.send({ ...request(), instruction: "changed after failed spawn" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    failSpawn = false;
    expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(count("prompt")).toBe(2);
    expect(await createProcessRunner("/nonexistent/bflow-p02-cli").run({ args: [], timeoutMs: 1000 })).toMatchObject({ failure: "spawn", started: false });
  });

  it("F08 isolates receipt correlation and locator from caller mutation", async () => {
    const { adapter, count } = fixture();
    const first = await adapter.send(request());
    if (!first.ok || first.value.status !== "accepted") throw new Error("Expected receipt");
    const original = structuredClone(first);
    first.value.handle.correlation = { token: "forged", provenance: "remote", verified: true };
    first.value.handle.target.session!.value = "forged-session";
    first.value.handle.target.paneId = "wrong-pane";
    expect(await adapter.send(request())).toEqual(original);
    const reconciled = await adapter.reconcile(reconciliation());
    expect(reconciled).toMatchObject({ ok: true, value: { status: "bound", handle: { correlation: { token: "r1", provenance: "orchestrator", verified: false }, target: { paneId: "p1", session: { value: "s1" } } } } });
    if (reconciled.ok && reconciled.value.status === "bound") reconciled.value.handle.correlation.token = "changed again";
    expect(await adapter.send(request())).toEqual(original);
    expect(count("prompt")).toBe(1);
  });

  it("F08 isolates cached cancellation outcome", async () => {
    const { adapter, count } = fixture();
    const first = await adapter.cancel(handle(), cancellation());
    if (!first.ok || first.value.status !== "accepted") throw new Error("Expected cancellation");
    const original = structuredClone(first);
    first.value.details = { stopConfirmed: true };
    first.value.executionId = "wrong";
    expect(await adapter.cancel(handle(), cancellation())).toEqual(original);
    expect(count("send-keys")).toBe(1);
  });

  it("F08 isolates cached uncertain cancellation errors", async () => {
    const { adapter, count } = fixture(i => i.args[1] === "get" ? response("agent_info") : timeout);
    const first = await adapter.cancel(handle(), cancellation());
    if (first.ok) throw new Error("Expected uncertainty");
    const original = structuredClone(first);
    first.error.message = "caller changed error";
    expect(await adapter.cancel(handle(), cancellation())).toEqual(original);
    expect(count("send-keys")).toBe(1);
  });
});
