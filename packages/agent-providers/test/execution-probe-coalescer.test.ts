import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderExecutionProbeCoalescer } from "../src/index.js";
import type { ProviderCommandInvocation, ProviderCommandOutcome, ProviderCommandRunner } from "../src/types.js";

const success: ProviderCommandOutcome = { exitCode: 0, started: true, stdout: "pong", stderr: "" };
const failure: ProviderCommandOutcome = { exitCode: 1, started: true, stdout: "", stderr: "model unavailable" };
const invocation: ProviderCommandInvocation = { executable: "/trusted/codex", args: ["exec", "ping"], cwd: "/workspace" };

function controlledRunner() {
  const pending: Array<{ invocation: ProviderCommandInvocation; resolve: (value: ProviderCommandOutcome) => void }> = [];
  const runner: ProviderCommandRunner = {
    run: command => new Promise(resolve => {
      pending.push({ invocation: command, resolve });
      command.signal?.addEventListener("abort", () => resolve({ exitCode: null, started: true, stdout: "", stderr: "aborted", failure: "aborted" }), { once: true });
    })
  };
  return { runner, pending };
}

function request(identity = "same-context") {
  return { identity, invocation, isCurrent: async () => true };
}

describe("factory-owned provider execution probe coalescing", () => {
  it("shares one overlapping successful ping and never reuses a completed result", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const first = coalescer.probe(request());
    const second = coalescer.probe(request());
    await expect.poll(() => pending.length).toBe(1);
    pending[0]!.resolve(success);
    expect(await first).toEqual(success);
    expect(await second).toEqual(success);
    const third = coalescer.probe(request());
    await expect.poll(() => pending.length).toBe(2);
    pending[1]!.resolve(success);
    expect(await third).toEqual(success);
  });

  it("does not combine different probe identities or factory instances", async () => {
    const { runner, pending } = controlledRunner();
    const one = createProviderExecutionProbeCoalescer({ runner });
    const two = createProviderExecutionProbeCoalescer({ runner });
    const outcomes = [one.probe(request("a")), one.probe(request("b")), two.probe(request("a"))];
    await expect.poll(() => pending.length).toBe(3);
    pending.forEach(entry => entry.resolve(success));
    expect(await Promise.all(outcomes)).toEqual([success, success, success]);
  });

  it("does not use a failed shared ping as the follower's observation", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const first = coalescer.probe(request());
    const second = coalescer.probe(request());
    await expect.poll(() => pending.length).toBe(1);
    pending[0]!.resolve(failure);
    expect(await first).toEqual(failure);
    await expect.poll(() => pending.length).toBe(2);
    pending[1]!.resolve(success);
    expect(await second).toEqual(success);
  });

  it("fails closed when a follower's configuration drifts during the shared ping", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const first = coalescer.probe(request());
    const second = coalescer.probe({ ...request(), isCurrent: async () => false });
    await expect.poll(() => pending.length).toBe(1);
    pending[0]!.resolve(success);
    expect(await first).toEqual(success);
    // If an unsafe implementation starts a retry, release it to expose the wrong success.
    setTimeout(() => pending[1]?.resolve(success), 20);
    expect((await second).failure).toBe("invalid_arguments");
    expect(pending).toHaveLength(1);
  });

  it("rejects context drift during a follower's individual fallback ping", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    let fresh = true;
    const first = coalescer.probe(request());
    const second = coalescer.probe({ ...request(), isCurrent: async () => fresh });
    await expect.poll(() => pending.length).toBe(1);
    pending[0]!.resolve(failure);
    expect(await first).toEqual(failure);
    await expect.poll(() => pending.length).toBe(2);
    fresh = false;
    pending[1]!.resolve(success);
    expect((await second).failure).toBe("invalid_arguments");
  });

  it("allows either role to cancel without killing the other's ping", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const cancelled = new AbortController();
    const first = coalescer.probe(request(), { signal: cancelled.signal });
    const second = coalescer.probe(request());
    await expect.poll(() => pending.length).toBe(1);
    cancelled.abort();
    expect((await first).failure).toBe("aborted");
    expect(pending[0]!.invocation.signal?.aborted).toBe(false);
    pending[0]!.resolve(success);
    expect(await second).toEqual(success);
  });

  it("aborts and evicts work when every waiter cancels", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const cancelled = new AbortController();
    const first = coalescer.probe(request(), { signal: cancelled.signal });
    await expect.poll(() => pending.length).toBe(1);
    cancelled.abort();
    expect((await first).failure).toBe("aborted");
    expect(pending[0]!.invocation.signal?.aborted).toBe(true);
    const second = coalescer.probe(request());
    await expect.poll(() => pending.length).toBe(2);
    pending[1]!.resolve(success);
    expect(await second).toEqual(success);
  });

  it("enforces each waiter's timeout without shortening another role's ping", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const first = coalescer.probe(request(), { timeoutMs: 10 });
    const second = coalescer.probe(request(), { timeoutMs: 1000 });
    expect((await first).failure).toBe("timeout");
    expect(pending[0]!.invocation.signal?.aborted).toBe(false);
    pending[0]!.resolve(success);
    expect(await second).toEqual(success);
  });

  it("does not start an already cancelled or expired request", async () => {
    const { runner, pending } = controlledRunner();
    const coalescer = createProviderExecutionProbeCoalescer({ runner });
    const cancelled = new AbortController();
    cancelled.abort();
    expect((await coalescer.probe(request(), { signal: cancelled.signal })).failure).toBe("aborted");
    expect((await coalescer.probe(request(), { deadline: new Date(0).toISOString() })).failure).toBe("timeout");
    expect(pending).toHaveLength(0);
  });
});


describe("opt-in completed model execution observations", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const reusable = (runner: ProviderCommandRunner, ttl = 30_000) =>
    createProviderExecutionProbeCoalescer({ runner, successfulResultTtlMs: ttl });

  it("reuses a successful observation until its original completion expires, without extending on hits", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let executions = 0;
    const coalescer = reusable({ run: async () => { executions++; return { ...success }; } });
    expect(await coalescer.probe(request())).toEqual(success);
    now = 30_099;
    expect(await coalescer.probe(request())).toEqual(success);
    expect(executions).toBe(1);
    now = 30_100;
    expect(await coalescer.probe(request())).toEqual(success);
    expect(executions).toBe(2);
  });

  it("runs a fresh ping when cached success expires during context verification", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let executions = 0;
    const coalescer = reusable({ run: async () => { executions++; return { ...success }; } });
    await coalescer.probe(request());
    expect(await coalescer.probe({ ...request(), isCurrent: async () => { now = 30_000; return true; } })).toEqual(success);
    expect(executions).toBe(2);
    now = 59_999;
    await coalescer.probe(request());
    expect(executions).toBe(2);
  });

  it("honors a shorter opt-in duration and an explicit zero duration", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let executions = 0;
    const runner: ProviderCommandRunner = { run: async () => { executions++; return { ...success }; } };
    const coalescer = reusable(runner, 10);
    await coalescer.probe(request());
    now = 9;
    await coalescer.probe(request());
    expect(executions).toBe(1);
    now = 10;
    await coalescer.probe(request());
    expect(executions).toBe(2);
    const uncached = reusable(runner, 0);
    await uncached.probe(request());
    await uncached.probe(request());
    expect(executions).toBe(4);
  });

  it.each([-1, 30_001, Infinity, NaN])("rejects invalid reuse lifetime %s", ttl => {
    expect(() => reusable({ run: async () => success }, ttl)).toThrow(RangeError);
  });

  it("revalidates on every hit and evicts an observation after uncertain or changed context", async () => {
    let executions = 0;
    const coalescer = reusable({ run: async () => { executions++; return success; } });
    await coalescer.probe(request());
    expect((await coalescer.probe({ ...request(), isCurrent: async () => false })).failure).toBe("invalid_arguments");
    expect(await coalescer.probe(request())).toEqual(success);
    expect(executions).toBe(2);
    expect((await coalescer.probe({ ...request(), isCurrent: async () => { throw new Error("unavailable"); } })).failure).toBe("invalid_arguments");
    await coalescer.probe(request());
    expect(executions).toBe(3);
  });

  it("does not reuse across invocation/environment/identity/factory boundaries or leak mutated output", async () => {
    let executions = 0;
    const runner: ProviderCommandRunner = { run: async () => { executions++; return { ...success }; } };
    const coalescer = reusable(runner);
    const first = await coalescer.probe(request());
    Object.assign(first, { exitCode: 0, stdout: "tampered" });
    expect((await coalescer.probe(request())).stdout).toBe("pong");
    await coalescer.probe(request("another-session"));
    await coalescer.probe({ ...request(), invocation: { ...invocation, env: { ACCOUNT: "another" } } });
    await coalescer.probe({ ...request(), invocation: { ...invocation, args: ["exec", "other"] } });
    await reusable(runner).probe(request());
    expect(executions).toBe(5);
  });

  it("checks effective environment again after asynchronous current-context verification", async () => {
    const original = process.env["BFLOW_PROBE_TEST"];
    try {
      const coalescer = reusable({ run: async () => ({ ...success }) });
      await coalescer.probe(request());
      const result = await coalescer.probe({ ...request(), isCurrent: async () => {
        process.env["BFLOW_PROBE_TEST"] = "changed-after-key-check";
        return true;
      } });
      expect(result.failure).toBe("invalid_arguments");
    } finally {
      if (original === undefined) delete process.env["BFLOW_PROBE_TEST"];
      else process.env["BFLOW_PROBE_TEST"] = original;
    }
  });

  it("does not retain failures, rejected commands, or a success after every waiter cancels", async () => {
    let executions = 0;
    const coalescer = reusable({ run: async () => {
      executions++;
      if (executions === 1) return failure;
      if (executions === 2) throw new Error("runner rejected");
      return { ...success };
    } });
    expect(await coalescer.probe(request())).toEqual(failure);
    await expect(coalescer.probe(request())).rejects.toThrow("runner rejected");
    expect(await coalescer.probe(request())).toEqual(success);
    expect(executions).toBe(3);
    const { pending } = controlledRunner();
    const lateRunner: ProviderCommandRunner = { run: command => new Promise(resolve => { pending.push({ invocation: command, resolve }); }) };
    const late = reusable(lateRunner);
    const controller = new AbortController();
    const first = late.probe(request(), { signal: controller.signal });
    await expect.poll(() => pending.length).toBe(1);
    controller.abort();
    expect((await first).failure).toBe("aborted");
    pending[0]!.resolve(success);
    await Promise.resolve();
    const second = late.probe(request());
    await expect.poll(() => pending.length).toBe(2);
    pending[1]!.resolve(success);
    expect(await second).toEqual(success);
  });

  it("bounds completed retention and respects cancellation even during cache validation", async () => {
    let executions = 0;
    const coalescer = reusable({ run: async () => { executions++; return { ...success }; } });
    await coalescer.probe(request("oldest"));
    for (let index = 0; index < 128; index++) await coalescer.probe(request(`session-${index}`));
    await coalescer.probe(request("oldest"));
    expect(executions).toBe(130);
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    const hit = coalescer.probe({ ...request("oldest"), isCurrent: () => new Promise(resolve => { finish = () => resolve(true); }) }, { signal: controller.signal });
    await expect.poll(() => finish !== undefined).toBe(true);
    controller.abort();
    expect((await hit).failure).toBe("aborted");
    finish!();
    expect(executions).toBe(130);
  });
});
