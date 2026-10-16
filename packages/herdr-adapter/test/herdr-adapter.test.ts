import { describe, expect, it } from "vitest";
import { AgentRequestSchema, AgentExecutionHandleSchema } from "@bflow/contracts";
import { HerdrCliTransport, createProcessRunner } from "../src/index.js";
import type { CommandInvocation, CommandOutcome, HerdrCommandRunner } from "../src/index.js";

const time = "2026-01-01T00:00:00.000Z";
const agent = (patch: Record<string, unknown> = {}) => ({
  agent: "codex", name: "worker", agent_status: "idle", workspace_id: "workspace-1", tab_id: "tab-1",
  pane_id: "pane-1", terminal_id: "terminal-1", revision: 1, state_change_seq: 2,
  agent_session: { source: "codex", kind: "id", value: "session-1" }, ...patch
});
const success = (type: string, info = agent()): CommandOutcome => ({ exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type, agent: info } }), stderr: "" });
const remoteError = (code: string): CommandOutcome => ({ exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code, message: code } }) });
const target = { transport: "herdr", agentId: "worker", workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", terminalId: "terminal-1", session: { source: "codex", kind: "id" as const, value: "session-1" } };
const request = (instruction = "echo '$HOME' ; $(touch /tmp/nope)") => AgentRequestSchema.parse({
  requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", role: "implementer",
  target, instruction, inputs: [], attempt: 1,
  retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false, retryableErrorCodes: [] },
  timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" },
  idempotency: { key: "prompt-1", scope: "agent-request", fingerprint: "sha256:abc" }, createdAt: time
});
const handle = AgentExecutionHandleSchema.parse({ executionId: "execution-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", idempotencyKey: "prompt-1", target, correlation: { token: "request-1", provenance: "orchestrator", verified: false }, acceptedAt: time });

function fake(respond: (invocation: CommandInvocation) => CommandOutcome | Promise<CommandOutcome>) {
  const calls: CommandInvocation[] = [];
  const runner: HerdrCommandRunner = { async run(invocation) { calls.push(invocation); return respond(invocation); } };
  return { calls, adapter: new HerdrCliTransport({ runner, clock: () => new Date(time) }) };
}

describe("Herdr CLI adapter", () => {
  it("reports unavailable CLI and unsupported protocol", async () => {
    const unavailable = fake(() => ({ exitCode: null, stdout: "", stderr: "", failure: "spawn", cause: "ENOENT" }));
    expect(await unavailable.adapter.initialize({ runtimeId: "runtime-1", configuration: {}, recoveryMode: false, initializedAt: time })).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    const unsupported = fake(({ args }) => args[0] === "--version" ? { exitCode: 0, stdout: "herdr 0.9.1", stderr: "" } : { exitCode: 0, stdout: "protocol: 99\nschema_version: 1", stderr: "" });
    expect(await unsupported.adapter.initialize({ runtimeId: "runtime-1", configuration: {}, recoveryMode: false, initializedAt: time })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
  });

  it("advertises no verified prompt correlation or streaming", async () => {
    const { adapter } = fake(({ args }) => args[0] === "--version" ? { exitCode: 0, stdout: "herdr 0.9.1", stderr: "" } : { exitCode: 0, stdout: "protocol: 22\nschema_version: 1", stderr: "" });
    expect(await adapter.initialize({ runtimeId: "runtime-1", configuration: {}, recoveryMode: false, initializedAt: time })).toMatchObject({ ok: true, value: { supportsSubmissionCorrelation: false, supportsStreaming: false, protocolVersion: "22" } });
  });

  it.each(["0.9.0", "0.9.1", "0.9.5", "0.10.0", "1.0.0", "99.0.0-dev"])(
    "accepts CLI %s when the actual protocol/schema is compatible", async version => {
      const { adapter, calls } = fake(({ args }) => args[0] === "--version"
        ? { exitCode: 0, stdout: `herdr ${version}\n`, stderr: "" }
        : { exitCode: 0, stdout: "protocol: 22\nschema_version: 1", stderr: "" });
      expect(await adapter.initialize({ runtimeId: "runtime-1", configuration: {}, recoveryMode: false, initializedAt: time }))
        .toMatchObject({ ok: true, value: { protocolVersion: "22", metadata: { cliVersion: `herdr ${version}` } } });
      expect(calls.map(call => call.args)).toEqual([["--version"], ["api", "schema"]]);
    });

  it.each(["protocol: 22\nschema_version: 99", "protocol: 99\nschema_version: 1", "not a schema"])(
    "checks actual incompatibility even with a familiar release label: %s", async schema => {
      const { adapter } = fake(({ args }) => args[0] === "--version"
        ? { exitCode: 0, stdout: "herdr 0.9.1", stderr: "" } : { exitCode: 0, stdout: schema, stderr: "" });
      expect(await adapter.initialize({ runtimeId: "runtime-1", configuration: {}, recoveryMode: false, initializedAt: time }))
        .toMatchObject({ ok: false });
    });

  it("requires explicit existing pane and detects startup mismatch", async () => {
    const { adapter, calls } = fake(() => success("agent_started"));
    expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "pane-1" })).toMatchObject({ ok: true, value: { paneId: "pane-1", session: { value: "session-1" } } });
    expect(calls[0]?.args).toEqual(["agent", "start", "worker", "--kind", "codex", "--pane", "pane-1"]);
    expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "pane-2" })).toMatchObject({ ok: false, error: { code: "unknown_delivery", retryable: false } });
  });

  it("maps blocked, timeout, malformed and server-unavailable startup", async () => {
    for (const [outcome, code] of [
      // These outcomes do not prove that startup never launched the agent.
      [remoteError("agent_not_ready"), "unknown_delivery"],
      [{ exitCode: null, stdout: "", stderr: "", failure: "timeout" }, "unknown_delivery"],
      [{ exitCode: 0, stdout: "oops", stderr: "" }, "unknown_delivery"],
      [remoteError("server_unavailable"), "unknown_delivery"]
    ] as const) {
      const { adapter } = fake(() => outcome as CommandOutcome);
      expect(await adapter.startAgent({ name: "worker", kind: "codex", paneId: "pane-1" })).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("submits shell-special prompt as one argv element and never invokes --wait", async () => {
    const { adapter, calls } = fake(({ args }) => args[1] === "get" ? success("agent_info") : success("agent_prompted"));
    const sent = await adapter.send(request());
    expect(sent).toMatchObject({ ok: true, value: { status: "accepted", handle: { correlation: { verified: false, provenance: "orchestrator" } } } });
    expect(calls[1]?.args).toEqual(["agent", "prompt", "pane-1", request().instruction]);
    expect(calls[1]?.args).not.toContain("--wait");
    expect(await adapter.send(request())).toEqual(sent);
    expect(calls).toHaveLength(2);
    expect(await adapter.send(request("different"))).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("accepts write acknowledgement while already working but not business success", async () => {
    const { adapter } = fake(({ args }) => args[1] === "get" ? success("agent_info", agent({ agent_status: "working" })) : success("agent_prompted", agent({ agent_status: "working" })));
    expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "accepted", handle: { correlation: { verified: false } } } });
  });

  it("uses Zod-normalized request identity for submission and deduplication", async () => {
    const { adapter, calls } = fake(({ args }) => args[1] === "get" ? success("agent_info") : success("agent_prompted"));
    const padded = { ...request(), requestId: " request-1 ", idempotency: { ...request().idempotency, key: " prompt-1 " } };
    expect(await adapter.send(padded)).toMatchObject({ ok: true, value: { requestId: "request-1", handle: { idempotencyKey: "prompt-1" } } });
    expect(await adapter.send(padded)).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(calls).toHaveLength(2);
  });

  it("rejects blocked agent before submission", async () => {
    const { adapter, calls } = fake(() => success("agent_info", agent({ agent_status: "blocked" })));
    expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(calls).toHaveLength(1);
    expect(await adapter.reconcile({ requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", idempotencyKey: "prompt-1", target, requestedAt: time })).toMatchObject({ ok: true, value: { status: "not_delivered", retrySafe: true } });
  });

  it("keeps timeout, stalled, lost connection and malformed acknowledgement as unknown delivery", async () => {
    const ambiguous: CommandOutcome[] = [
      { exitCode: null, stdout: "", stderr: "", failure: "timeout" },
      remoteError("agent_prompt_stalled"), remoteError("connection_lost"),
      { exitCode: 0, stdout: "malformed", stderr: "" }
    ];
    for (const outcome of ambiguous) {
      const { adapter, calls } = fake(({ args }) => args[1] === "get" ? success("agent_info") : outcome);
      expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false, manualInterventionRequired: true } });
      expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "unknown_delivery" } });
      expect(calls).toHaveLength(2);
    }
  });

  it("detects replacement or moved pane before sending", async () => {
    for (const patch of [{ agent_session: { source: "codex", kind: "id", value: "session-2" } }, { pane_id: "pane-2" }, { name: "other", agent: "other" }]) {
      const { adapter, calls } = fake(() => success("agent_info", agent(patch)));
      expect(await adapter.send(request())).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(calls).toHaveLength(1);
    }
  });

  it("returns unknown delivery if the occupant changes after prompt submission", async () => {
    const { adapter } = fake(({ args }) => args[1] === "get" ? success("agent_info") : success("agent_prompted", agent({ agent_session: { source: "codex", kind: "id", value: "session-2" } })));
    expect(await adapter.send(request())).toMatchObject({ ok: true, value: { status: "unknown_delivery", resendAllowed: false } });
  });

  it("reconciles only locally known acknowledged handle; uncertain receipt stays uncertain", async () => {
    const { adapter } = fake(({ args }) => args[1] === "get" ? success("agent_info") : success("agent_prompted"));
    await adapter.send(request());
    const identity = { requestId: "request-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", idempotencyKey: "prompt-1", target, requestedAt: time };
    expect(await adapter.reconcile(identity)).toMatchObject({ ok: true, value: { status: "bound" } });
    expect(await new HerdrCliTransport({ runner: { run: async () => success("agent_info") }, clock: () => new Date(time) }).reconcile(identity)).toMatchObject({ ok: true, value: { status: "unknown_delivery", retrySafe: false } });
  });

  it("wait reports transport done only, and read yields unverified text", async () => {
    const { adapter } = fake(({ args }) => args[1] === "get" ? success("agent_info") : args[1] === "wait" ? success("agent_info", agent({ agent_status: "done" })) : { exitCode: 0, stdout: "tests passed?", stderr: "" });
    expect(await adapter.wait(handle)).toMatchObject({ ok: true, value: { state: "done", correlationVerified: false } });
    const messages = [];
    for await (const message of adapter.read(handle)) messages.push(message);
    expect(messages).toMatchObject([{ ok: true, value: { kind: "status", data: {
      source: "terminal_snapshot", text: "tests passed?", correlationVerified: false,
      executionOutputVerified: false, turnIdentity: "unresolved"
    } } }]);
  });

  it("wait timeout, abort and invalid target are typed failures", async () => {
    const timeout = fake(({ args }) => args[1] === "get" ? success("agent_info") : { exitCode: null, stdout: "", stderr: "", failure: "timeout" });
    expect(await timeout.adapter.wait(handle)).toMatchObject({ ok: false, error: { code: "timeout", retrySafety: "observation_only" } });
    const aborted = fake(() => ({ exitCode: null, stdout: "", stderr: "", failure: "aborted" }));
    expect(await aborted.adapter.wait(handle)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const invalid = fake(() => remoteError("invalid_target"));
    expect(await invalid.adapter.wait(handle)).toMatchObject({ ok: false, error: { code: "not_found" } });
    const remoteTimeout = fake(({ args }) => args[1] === "get" ? success("agent_info") : remoteError("timeout"));
    expect(await remoteTimeout.adapter.wait(handle, { until: ["working", "done"] })).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("cancellation checks execution identity and never claims confirmed stop", async () => {
    const { adapter, calls } = fake(({ args }) => args[1] === "get" ? success("agent_info") : { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" });
    const base = { schemaVersion: 1 as const, cancellationId: "cancel-1", runId: "run-1", taskId: "task-1", requestedBy: "human", requestedAt: time, expectedVersion: 1, idempotencyKey: "cancel-1" };
    expect(await adapter.cancel(handle, { ...base, executionId: "wrong" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(calls).toHaveLength(0);
    expect(await adapter.cancel(handle, { ...base, executionId: "execution-1" })).toMatchObject({ ok: true, value: { status: "accepted", details: { stopConfirmed: false } } });
    expect(calls[1]?.args).toEqual(["agent", "send-keys", "pane-1", "ctrl+c"]);
    expect(await adapter.cancel(handle, { ...base, executionId: "execution-1" })).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(calls).toHaveLength(3);
    expect(await adapter.cancel({ ...handle, executionId: "execution-2" }, { ...base, executionId: "execution-2" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("process runner aborts a child without a shell", async () => {
    const controller = new AbortController();
    const running = createProcessRunner(process.execPath).run({ args: ["-e", "setInterval(() => {}, 1000)"], signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();
    expect(await running).toMatchObject({ failure: "aborted" });
  });

  it("does not retry an uncertain cancellation command", async () => {
    const { adapter, calls } = fake(({ args }) => args[1] === "get" ? success("agent_info") : { exitCode: null, stdout: "", stderr: "", failure: "timeout" });
    const cancellation = { schemaVersion: 1 as const, cancellationId: "cancel-1", runId: "run-1", taskId: "task-1", executionId: "execution-1", requestedBy: "human", requestedAt: time, expectedVersion: 1, idempotencyKey: "cancel-1" };
    expect(await adapter.cancel(handle, cancellation)).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
    expect(await adapter.cancel(handle, cancellation)).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
    expect(calls).toHaveLength(2);
  });

  it("does not confirm cancellation if the pane occupant changes afterward", async () => {
    let inspected = 0;
    const { adapter } = fake(({ args }) => {
      if (args[1] === "get") return success("agent_info", agent({ agent_session: { source: "codex", kind: "id", value: ++inspected === 1 ? "session-1" : "session-2" } }));
      return { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" };
    });
    const cancellation = { schemaVersion: 1 as const, cancellationId: "cancel-1", runId: "run-1", taskId: "task-1", executionId: "execution-1", requestedBy: "human", requestedAt: time, expectedVersion: 1, idempotencyKey: "cancel-1" };
    expect(await adapter.cancel(handle, cancellation)).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
  });

  it("does not call lifecycle done a verified terminal execution during cancellation", async () => {
    const { adapter, calls } = fake(() => success("agent_info", agent({ agent_status: "done" })));
    const cancellation = { schemaVersion: 1 as const, cancellationId: "cancel-1", runId: "run-1", taskId: "task-1", executionId: "execution-1", requestedBy: "human", requestedAt: time, expectedVersion: 1, idempotencyKey: "cancel-1" };
    expect(await adapter.cancel(handle, cancellation)).toMatchObject({ ok: true, value: { status: "refused" } });
    expect(calls).toHaveLength(1);
  });
});
