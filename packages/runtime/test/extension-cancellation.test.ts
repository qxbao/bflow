import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeExtensionFixture } from "./helpers/native-extension.js";

describe.each(["analysis", "qa"] as const)("%s native cancellation", family => {
  it("cancels its real Core run at a human gate and preserves cancellation on reopen", async () => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open();
    await f.start(sdk); await sdk.drive("run-native");
    const sends = f.transport.sentRequests.length;
    expect(await sdk.cancel("run-native", "Owner stopped this probe")).toMatchObject({ status: "cancelled" });
    expect(await engine.getSnapshot("run-native")).toMatchObject({ ok: true, value: { status: "cancelled" } });
    await sdk.drive("run-native");
    const recovered = await f.open(); await recovered.sdk.drive("run-native");
    expect(recovered.sdk.status("run-native")).toMatchObject({ status: "cancelled" });
    expect(f.transport.sentRequests).toHaveLength(sends);
  });

  it("retains a bound native lease until exact correlated stop proof and never interrupts twice", async () => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open(); await f.start(sdk);
    let ready!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.native.waitResult;
    f.native.waitResult = async id => { ready(); await held; return original(id); };
    const driving = sdk.drive("run-native").catch(() => undefined);
    try {
      await waiting;
      expect(await sdk.cancel("run-native", "Stop active role")).toMatchObject({ status: "cancelling" });
      expect(f.transport.cancelledHandles).toHaveLength(1);
      expect(await engine.getSnapshot("run-native")).toMatchObject({ ok: true, value: { status: "cancelling" } });
      expect((await f.native.snapshot()).outbound[0]).toMatchObject({ status: "accepted", cancelRequested: true });
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      expect(await sdk.cancel("run-native", "Stop active role")).toMatchObject({ status: "cancelled" });
      expect(f.transport.cancelledHandles).toHaveLength(1);
      expect((await f.native.snapshot()).outbound[0]).toMatchObject({ status: "cancelled" });
      expect(await engine.getSnapshot("run-native")).toMatchObject({ ok: true, value: { status: "cancelled" } });
    } finally { release(); await driving; }
    expect(sdk.status("run-native")).toMatchObject({ status: "cancelled" });
  });

  it("keeps uncertain native delivery unresolved without resending or reporting stopped", async () => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open(); await f.start(sdk); f.loseAck();
    await expect(sdk.drive("run-native")).rejects.toThrow(/unknown|reconcile/);
    f.transport.customReconcileHandler = request => ({ ok: true, value: { status: "unknown_delivery", requestId: request.requestId,
      retrySafe: false, observedAt: new Date().toISOString(), reason: "delivery unavailable", manualInterventionRequired: true } });
    expect(await sdk.cancel("run-native", "Stop unknown delivery")).toMatchObject({ status: "cancelling" });
    expect(f.transport.sentRequests).toHaveLength(1);
    expect(f.transport.cancelledHandles).toHaveLength(0);
    expect(await engine.getSnapshot("run-native")).toMatchObject({ ok: true, value: { status: "cancelling" } });
    expect((await f.native.snapshot()).outbound[0]).toMatchObject({ status: "unknown_delivery" });
  });

  it.each(["idle", "done"] as const)("settles an expired lease from fresh exact %s proof without interrupting the old scope", async state => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open(); await f.start(sdk);
    const original = f.native.waitResult;
    f.native.waitResult = async () => { throw new Error("provider stopped before output"); };
    await expect(sdk.drive("run-native")).rejects.toThrow("provider stopped");
    f.native.waitResult = original;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state, observedAt: new Date().toISOString(), correlationVerified: true } });
      expect(await sdk.cancel("run-native", "Owner stops expired native assignment")).toMatchObject({ status: "cancelled" });
      expect(f.transport.cancelledHandles).toHaveLength(0);
      expect(f.transport.sentRequests).toHaveLength(1);
      expect(await engine.getSnapshot("run-native")).toMatchObject({ ok: true, value: { status: "cancelled" } });
      expect((await f.native.snapshot()).outbound[0]).toMatchObject({ status: "cancelled" });
    } finally { vi.useRealTimers(); }
  });

  it("never interrupts an expired scope or reports stopped without exact correlated idle proof", async () => {
    const f = await nativeExtensionFixture(family), { sdk } = await f.open(); await f.start(sdk);
    f.native.waitResult = async () => { throw new Error("provider unresolved"); };
    await expect(sdk.drive("run-native")).rejects.toThrow("provider unresolved");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: false } });
      expect(await sdk.cancel("run-native", "Owner stops unresolved expired assignment")).toMatchObject({ status: "cancelling" });
      expect(f.transport.cancelledHandles).toHaveLength(0);
      expect((await f.native.snapshot()).outbound[0]).toMatchObject({ status: "accepted" });
    } finally { vi.useRealTimers(); }
  });

  it.each(["acquire", "release"] as const)("recovers a lost expired-stop lease %s acknowledgement without replaying delivery or interrupt", async cut => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      let lost = false;
      if (cut === "acquire") {
        const original = f.registry.acquireLease.bind(f.registry);
        f.registry.acquireLease = async (input, options) => {
          const result = await original(input, options);
          if (!lost && result.ok && input.leaseId.startsWith("ext-stop-")) { lost = true; throw new Error("lost cleanup acknowledgement"); }
          return result;
        };
      } else {
        const original = f.registry.releaseLease.bind(f.registry);
        f.registry.releaseLease = async (input, options) => {
          const result = await original(input, options);
          if (!lost && result.ok && input.leaseId.startsWith("ext-stop-")) { lost = true; throw new Error("lost cleanup acknowledgement"); }
          return result;
        };
      }
      await expect(current.sdk.cancel("run-native", "Owner stops expired role")).rejects.toThrow("lost cleanup acknowledgement");
      current = await f.open();
      expect(await current.sdk.cancel("run-native", "Owner stops expired role")).toMatchObject({ status: "cancelled" });
      expect(f.transport.sentRequests).toHaveLength(1);
      expect(f.transport.cancelledHandles).toHaveLength(0);
      const snapshot = await f.native.snapshot();
      const receipt = snapshot.inbox.find(item => (item.message.payload as { kind?: string }).kind === "extension.expired-stop-lease.acquired");
      expect(receipt?.message.payload).toMatchObject({ data: { fencingToken: 2 } });
      expect(snapshot.outbound[0]).toMatchObject({ status: "cancelled", lease: { fencingToken: 1 } });
    } finally { vi.useRealTimers(); }
  });

  it("leaves a newer reservation for the same attempt untouched while the expired assignment is cancelled", async () => {
    const f = await nativeExtensionFixture(family), current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    const old = (await f.native.snapshot()).outbound[0].lease!;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      const newer = await f.registry.acquireLease({ leaseId: "newer-attempt-reservation", agentId: old.agentId,
        runId: old.runId, taskId: old.taskId, attemptId: old.attemptId, ttlMs: 300_000,
        requestedAt: new Date().toISOString(), idempotencyKey: "newer-attempt-reservation" });
      expect(newer).toMatchObject({ ok: true, value: { fencingToken: 2 } });
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      expect(await current.sdk.cancel("run-native", "Stop expired scope only")).toMatchObject({ status: "cancelling" });
      expect(f.transport.cancelledHandles).toHaveLength(0);
      expect(await f.registry.renewLease({ leaseId: "newer-attempt-reservation", fencingToken: 2, expectedVersion: 0,
        ttlMs: 300_000, requestedAt: new Date().toISOString(), idempotencyKey: "newer-attempt-still-owned" })).toMatchObject({ ok: true });
    } finally { vi.useRealTimers(); }
  });

  it("retains cancellation while an expired-stop cleanup lease still has no release acknowledgement", async () => {
    const f = await nativeExtensionFixture(family), current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      const release = f.registry.releaseLease.bind(f.registry);
      f.registry.releaseLease = async (input, options) => input.leaseId.startsWith("ext-stop-")
        ? { ok: false, error: { code: "conflict", message: "cleanup release has not completed", retryable: true } }
        : release(input, options);
      expect(await current.sdk.cancel("run-native", "Stop expired role")).toMatchObject({ status: "cancelling" });
      expect(await current.sdk.cancel("run-native", "Stop expired role")).toMatchObject({ status: "cancelling" });
      f.registry.releaseLease = release;
      expect(await current.sdk.cancel("run-native", "Stop expired role")).toMatchObject({ status: "cancelled" });
      expect(f.transport.cancelledHandles).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["ack", "expiry"] as const)("finishes saved expired-stop cleanup after pane removal and %s recovery", async cut => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 600_000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      const release = f.registry.releaseLease.bind(f.registry); let lost = false;
      f.registry.releaseLease = async (input, options) => {
        if (input.leaseId.startsWith("ext-stop-") && cut === "expiry")
          return { ok: false, error: { code: "conflict", message: "cleanup release unavailable", retryable: true } };
        const result = await release(input, options);
        if (!lost && result.ok && input.leaseId.startsWith("ext-stop-")) { lost = true; throw new Error("lost cleanup release acknowledgement"); }
        return result;
      };
      if (cut === "ack") await expect(current.sdk.cancel("run-native", "Stop expired role")).rejects.toThrow("lost cleanup release acknowledgement");
      else expect(await current.sdk.cancel("run-native", "Stop expired role")).toMatchObject({ status: "cancelling" });
      f.panes.delete(family === "analysis" ? "architect" : "qa");
      if (cut === "expiry") vi.setSystemTime(Date.now() + 600_000);
      current = await f.open();
      expect(await current.sdk.cancel("run-native", "Stop expired role")).toMatchObject({ status: "cancelled" });
      expect(f.transport.cancelledHandles).toHaveLength(0);
      expect(f.transport.sentRequests).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not promote a stale pre-cancellation observation into stop proof after lease expiry", async () => {
    const f = await nativeExtensionFixture(family), current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 1000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: handle.acceptedAt, correlationVerified: true } });
      const release = f.registry.releaseLease.bind(f.registry);
      f.registry.releaseLease = async (input, options) => input.leaseId.startsWith("ext-lease-")
        ? { ok: false, error: { code: "conflict", message: "deferred original lease release", retryable: true } }
        : release(input, options);
      await current.sdk.cancel("run-native", "Stop role").catch(error => { expect(String(error)).toContain("deferred original lease release"); });
      vi.setSystemTime(Date.now() + 600_000);
      expect(await current.sdk.cancel("run-native", "Stop role")).toMatchObject({ status: "cancelling" });
      expect((await f.native.snapshot()).inbox.some(item => (item.message.payload as { kind?: string }).kind === "extension.stop.recorded")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("does not trust a persisted legacy stale stop proof after reopening an expired cancellation", async () => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk);
    f.native.waitResult = async () => { throw new Error("provider unavailable"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("provider unavailable");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 1000);
      f.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      const release = f.registry.releaseLease.bind(f.registry);
      f.registry.releaseLease = async (input, options) => input.leaseId.startsWith("ext-lease-")
        ? { ok: false, error: { code: "conflict", message: "deferred original lease release", retryable: true } }
        : release(input, options);
      await expect(current.sdk.cancel("run-native", "Stop role")).rejects.toThrow("deferred original lease release");
      const path = join(f.root, "delivery/state.json"), legacy = JSON.parse(await readFile(path, "utf8"));
      const stop = legacy.inbox.find((item: { message: { payload: { kind?: string } } }) => item.message.payload.kind === "extension.stop.recorded");
      stop.message.payload.data.stoppedAt = legacy.outbound[0].handle.acceptedAt;
      await writeFile(path, JSON.stringify(legacy));
      vi.setSystemTime(Date.now() + 600_000);
      current = await f.open();
      expect(await current.sdk.cancel("run-native", "Stop role")).toMatchObject({ status: "cancelling" });
      expect((await f.native.snapshot()).inbox.some(item => (item.message.payload as { kind?: string }).kind === "extension.expired-stop-lease.acquired")).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
