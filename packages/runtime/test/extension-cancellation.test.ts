import { describe, expect, it } from "vitest";
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
});
