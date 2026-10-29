import { describe, expect, it } from "vitest";
import { handoverPrototypeApprovals } from "../../src/handover/build.js";

const manifestDigest = "b".repeat(64);
const approval = (status: string, decisionDigest?: string) => ({
  request: { approvalId: "prototype-1", requestedAt: "2026-10-29T12:00:00.000Z" }, version: 1, manifestDigest, status,
  ...(decisionDigest ? { decision: { approvalId: "prototype-1", decision: status === "approved" ? "approved" : "rejected", decidedBy: "owner",
    decidedAt: "2026-10-29T12:05:00.000Z", metadata: { manifestDigest: decisionDigest } } } : {})
});

describe("handover prototype approvals", () => {
  it("lists an approved prototype review bound to its manifest as prototype-only evidence", () => {
    const [item] = handoverPrototypeApprovals({ approvals: [approval("approved", manifestDigest)] } as never, new Set());
    expect(item).toMatchObject({ approvalId: "prototype-1", kind: "prototype", decision: "approved", validity: "valid", decidedBy: "owner" });
    expect(item!.target).toContain(`v1 manifest ${manifestDigest.slice(0, 12)}`);
    expect(item!.reasons.join(" ")).toMatch(/does not prove acceptance criteria/);
  });
  it("marks a decision bound to another manifest stale, and pending, refused or superseded reviews accordingly", () => {
    const items = handoverPrototypeApprovals({ approvals: [approval("approved", "c".repeat(64)), approval("pending"),
      approval("rejected", manifestDigest), { ...approval("approved", manifestDigest), request: { approvalId: "prototype-2", requestedAt: "2026-10-29T12:00:00.000Z" } }] } as never,
    new Set(["prototype-2"]));
    expect(items.map(item => item.validity)).toEqual(["stale", "pending", "refused", "superseded"]);
    expect(handoverPrototypeApprovals(undefined, new Set())).toEqual([]);
  });
});
