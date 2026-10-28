import { describe, expect, it } from "vitest";
import { NATIVE_ACK_GRACE_MS, NativeAckGrace, nativeAckGraceMs } from "../../src/agentic/native-delivery-status.js";

// Live regression (2026-10-28, session bf-76c2ffea01b3dc76e2b7): the 15 s watchdog tick landed between the delegation
// intent (14:47:43) and its ACK (14:47:44) and reported an in-flight delivery as uncertain, pausing the run for the user.
describe("native ACK grace", () => {
  it("does not report an intent whose ACK is still in flight on the first watchdog tick", () => {
    const grace = new NativeAckGrace();
    expect(grace.due(["op-1"], 1_000)).toEqual([]);
    // The ACK arrived before the next tick: the intent is no longer pending and is never reported.
    expect(grace.due([], 16_000)).toEqual([]);
    expect(grace.due([], 1_000 + NATIVE_ACK_GRACE_MS + 1)).toEqual([]);
  });

  it("reports an intent that stays unacknowledged for the whole grace period", () => {
    const grace = new NativeAckGrace(60_000);
    expect(grace.due(["op-1"], 0)).toEqual([]);
    expect(grace.due(["op-1"], 59_999)).toEqual([]);
    expect(grace.due(["op-1"], 60_000)).toEqual(["op-1"]);
  });

  it("tracks each intent from its own first observation and forgets settled ones", () => {
    const grace = new NativeAckGrace(60_000);
    grace.due(["op-1"], 0);
    expect(grace.due(["op-1", "op-2"], 30_000)).toEqual([]);
    expect(grace.due(["op-1", "op-2"], 60_000)).toEqual(["op-1"]);
    expect(grace.due(["op-2"], 90_000)).toEqual(["op-2"]);
    // op-1 settled and disappeared; if the same id were ever pending again it would start a fresh grace period.
    expect(grace.due(["op-1"], 100_000)).toEqual([]);
  });

  it("accepts a bounded environment override and falls back otherwise", () => {
    expect(nativeAckGraceMs(undefined)).toBe(NATIVE_ACK_GRACE_MS);
    expect(nativeAckGraceMs("30000")).toBe(30_000);
    for (const value of ["0", "100", "abc", "1e9", "4999"]) expect(nativeAckGraceMs(value)).toBe(NATIVE_ACK_GRACE_MS);
  });

  it("rejects a non-positive or non-finite grace", () => {
    expect(() => new NativeAckGrace(0)).toThrow();
    expect(() => new NativeAckGrace(Number.NaN)).toThrow();
  });
});
