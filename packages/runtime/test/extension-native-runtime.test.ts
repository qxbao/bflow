import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { nativeExtensionFixture } from "./helpers/native-extension.js";

const value = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };

describe.each(["analysis", "qa"] as const)("%s SDK native lifecycle", family => {
  it("binds only accepted native handles, verifies signed receipts in Core, and stops at the real human gate", async () => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open(); await f.start(sdk);
    const status = await sdk.drive("run-native");
    expect(status.status).toBe(family === "analysis" ? "awaiting_business_decision" : "awaiting_design_approval");
    const snapshot = value(await engine.getSnapshot("run-native"))!;
    const bound = snapshot.tasks.filter(task => task.agentExecution);
    expect(bound).toHaveLength(2);
    for (const task of bound) {
      expect(task.agentExecution).toEqual(f.handles.get(task.agentExecution!.requestId));
      expect(task.agentExecution!.target.transport).toBe("herdr");
      expect(task.bindingVerification!.receipt.handle).toEqual(task.agentExecution);
      expect(task.bindingVerification!.receipt.correlation.verified).toBe(true);
    }
    expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({ schemaVersion: 2, delivery: "native" });
  });

  it("recovers acceptance lost before SDK/Core binding without resending or substituting a logical handle", async () => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk); f.loseAck();
    await expect(current.sdk.drive("run-native")).rejects.toThrow(/unknown|reconcil/i);
    expect(value(await current.engine.getSnapshot("run-native"))!.tasks.every(task => !task.agentExecution)).toBe(true);
    current = await f.open();
    await current.sdk.drive("run-native");
    expect(f.transport.sentRequests).toHaveLength(2);
    expect(f.transport.reconciledRequests).toHaveLength(1);
    const snapshot = value(await current.engine.getSnapshot("run-native"))!;
    expect(snapshot.tasks.find(task => task.taskId === (family === "analysis" ? "survey" : "design"))!.agentExecution!.executionId)
      .toBe(family === "analysis" ? "herdr-survey" : "herdr-design");
  });

  it("refuses output without native binding proof and cannot promote SDK journal history to native evidence", async () => {
    const f = await nativeExtensionFixture(family), { sdk, engine } = await f.open(); await f.start(sdk); f.omitReceipt();
    await expect(sdk.drive("run-native")).rejects.toThrow(/binding receipt/i);
    expect(value(await engine.getSnapshot("run-native"))!.tasks.every(task => !task.result)).toBe(true);
    const journal = JSON.parse(await readFile(f.journalPath, "utf8")); journal.schemaVersion = 1; delete journal.delivery;
    await writeFile(f.journalPath, JSON.stringify(journal));
    await expect(f.open()).rejects.toThrow(/legacy|native|journal/i);
  });

  it("replays a processed result after restart using the original native correlation and does not dispatch twice", async () => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk);
    current.engine.recordAgentResult = async () => { throw new Error("crash before Core result write"); };
    await expect(current.sdk.drive("run-native")).rejects.toThrow("crash before Core result write");
    expect(f.transport.sentRequests).toHaveLength(1);
    const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
    expect(journal.runs[0].executions[0]).toMatchObject({ state: "recorded", native: { phase: "completed" } });
    current = await f.open();
    const result = await current.sdk.drive("run-native");
    expect(result.status).toBe(family === "analysis" ? "awaiting_business_decision" : "awaiting_design_approval");
    expect(f.transport.sentRequests).toHaveLength(2);
  });

  it("keeps unresolved native delivery across repeated restarts without any automatic resend", async () => {
    const f = await nativeExtensionFixture(family); let current = await f.open(); await f.start(current.sdk); f.loseAck();
    await expect(current.sdk.drive("run-native")).rejects.toThrow(/unknown|reconcil/i);
    f.transport.customReconcileHandler = request => ({ ok: true, value: { status: "unknown_delivery", requestId: request.requestId,
      reason: "remote scope is still unresolved", retrySafe: false, manualInterventionRequired: true, observedAt: new Date().toISOString() } });
    for (let restart = 0; restart < 2; restart++) {
      current = await f.open();
      await expect(current.sdk.drive("run-native")).rejects.toThrow(/unknown|reconcil/i);
      expect(value(await current.engine.getSnapshot("run-native"))!.tasks.every(task => !task.agentExecution)).toBe(true);
    }
    expect(f.transport.sentRequests).toHaveLength(1);
  });
});
