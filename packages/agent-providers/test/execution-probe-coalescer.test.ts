import { describe, expect, it } from "vitest";
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
