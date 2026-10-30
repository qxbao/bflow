import { describe, expect, it } from "vitest";
import {
  DeterministicRandom,
  minimizeTrace,
  runStatefulExploration,
  replayTrace,
  type ExplorationTrace,
  type ExplorerOperation
} from "./stateful-runtime-explorer.js";

describe("stateful Runtime explorer primitives", () => {
  it("generates the same bounded operation stream for the same seed", () => {
    const left = new DeterministicRandom(0x5eed);
    const right = new DeterministicRandom(0x5eed);
    expect(Array.from({ length: 12 }, () => left.int(7))).toEqual(
      Array.from({ length: 12 }, () => right.int(7))
    );
  });

  it("minimizes a replayable failure while preserving the failure predicate", async () => {
    const trace: ExplorationTrace = {
      seed: 9,
      campaign: "delivery-restart",
      operations: [
        { kind: "create_task" },
        { kind: "advance_clock", milliseconds: 1 },
        { kind: "dispatch" },
        { kind: "restart" },
        { kind: "reconcile" }
      ],
      faults: ["ack_lost"]
    };
    const minimized = await minimizeTrace(trace, async candidate =>
      candidate.operations.some(operation => operation.kind === "dispatch") && candidate.faults.includes("ack_lost")
    );
    expect(minimized.operations.map(operation => operation.kind)).toEqual(["dispatch"]);
    expect(minimized.faults).toEqual(["ack_lost"]);
  });

  it("injects an acknowledgment fault into the real dispatcher without a blind resend", async () => {
    const replay = await replayTrace({ seed: 11, campaign: "delivery", operations: [
      { kind: "create_task" }, { kind: "dispatch" }, { kind: "restart" }, { kind: "reconcile" }
    ], faults: ["ack_lost"] });
    expect(replay.observations).toContain("delivery.unknown");
    expect(replay.activatedFaults).toContain("ack_lost");
    expect(replay.observations.some(item => item.startsWith("restart.reconciled:"))).toBe(true);
    expect(replay.violation).toBeUndefined();
  });

  it("does not attribute a pre-dispatch watchdog action to a later uncertain delivery", async () => {
    const replay = await replayTrace({ seed: 1788510122, campaign: "lifecycle", operations: [
      { kind: "create_task" }, { kind: "restart" }, { kind: "watchdog" }, { kind: "dispatch" }
    ], faults: ["ack_lost"] });
    expect(replay.violation).toBeUndefined();
    expect(replay.observations).toContain("delivery.unknown");
  });

  it("explores lease expiry and lifecycle scheduling without treating valid waits as stalls", async () => {
    const report = await runStatefulExploration({ seeds: { lease: 101, lifecycle: 202 }, sequencesPerCampaign: 4, maxTransitions: 12, wallClockMs: 30_000 });
    const lease = report.campaigns.find(campaign => campaign.campaign === "lease")!;
    const lifecycle = report.campaigns.find(campaign => campaign.campaign === "lifecycle")!;
    expect(lease.injectedFaults).toBeGreaterThan(0);
    expect(lease.transitionCombinations).toBeGreaterThan(2);
    expect(lifecycle.stateSignatures).toBeGreaterThan(0);
    expect([...lease.invariantViolations, ...lifecycle.invariantViolations]).toEqual([]);
  });

  it.skipIf(process.env.BFLOW_RUN_STATEFUL !== "1")("executes the initial bounded three-campaign exploration", async () => {
    const report = await runStatefulExploration({
      seeds: { delivery: 0xd311, lease: 0x1ea5e, lifecycle: 0xcafe },
      sequencesPerCampaign: 100,
      maxTransitions: 24,
      maxFaults: 3,
      wallClockMs: 120_000,
      outputFile: process.env.BFLOW_EXPLORATION_OUTPUT
    });
    expect(report.providerTokens).toBe(0);
    expect(report.campaigns).toHaveLength(3);
    expect(report.campaigns.every(campaign => campaign.generatedSequences === 100)).toBe(true);
    expect(report.campaigns.flatMap(campaign => campaign.invariantViolations)).toEqual([]);
  }, 180_000);

  it("runs bounded campaigns through the explorer entrypoint and reports coverage", async () => {
    const report = await runStatefulExploration({
      seeds: { delivery: 11, lease: 12, lifecycle: 13 },
      sequencesPerCampaign: 2,
      maxTransitions: 8,
      wallClockMs: 30_000
    });
    expect(report.providerTokens).toBe(0);
    expect(report.campaigns).toHaveLength(3);
    expect(report.campaigns.every(campaign => campaign.generatedSequences === 2)).toBe(true);
    expect(report.campaigns.every(campaign => campaign.transitions > 0)).toBe(true);
    expect(report.campaigns.every(campaign => campaign.stateSignatures > 0)).toBe(true);
    expect(report.campaigns.flatMap(campaign => campaign.invariantViolations)).toEqual([]);
  });
});
