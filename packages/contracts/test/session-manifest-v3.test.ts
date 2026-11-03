import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DelegationRequestSchema,
  SessionManifestSchema,
  SessionManifestV3Schema,
  isDirectorSessionManifest
} from "../src/index.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const v3 = () => load("session-manifest-v3.json");

describe("SessionManifest v2|v3", () => {
  it("parses a real v2 manifest and it is not a director manifest", () => {
    const parsed = SessionManifestSchema.parse(load("session-manifest-v2-real.json"));
    expect(parsed.schemaVersion).toBe(2);
    expect(isDirectorSessionManifest(parsed)).toBe(false);
  });

  it("parses a valid v3 manifest", () => {
    const parsed = SessionManifestSchema.parse(v3());
    expect(isDirectorSessionManifest(parsed)).toBe(true);
    expect(SessionManifestV3Schema.safeParse(v3()).success).toBe(true);
  });

  it("rejects a v3 manifest with a coordinator or conversation pane", () => {
    for (const role of ["coordinator", "conversation"]) {
      const manifest = v3();
      manifest.panes[0].role = role;
      expect(SessionManifestSchema.safeParse(manifest).success).toBe(false);
    }
  });

  it("rejects a v3 up manifest without progressPane or with a non-running one", () => {
    const missing = v3();
    delete missing.progressPane;
    expect(SessionManifestSchema.safeParse(missing).success).toBe(false);
    const notRunning = v3();
    notRunning.progressPane.phase = "launch_unknown";
    expect(SessionManifestSchema.safeParse(notRunning).success).toBe(false);
  });

  it("rejects a mismatched attachTarget and duplicate pane ids", () => {
    const paneMismatch = v3();
    paneMismatch.attachTarget.paneId = "w1:p9";
    expect(SessionManifestSchema.safeParse(paneMismatch).success).toBe(false);
    const tabMismatch = v3();
    tabMismatch.attachTarget.tabId = "w1:t9";
    expect(SessionManifestSchema.safeParse(tabMismatch).success).toBe(false);
    const duplicate = v3();
    duplicate.panes[0].paneId = duplicate.progressPane.paneId;
    expect(SessionManifestSchema.safeParse(duplicate).success).toBe(false);
  });

  it("reports unsupported schemaVersion with a readable message", () => {
    const result = SessionManifestSchema.safeParse({ ...v3(), schemaVersion: 4 });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe("unsupported session manifest schemaVersion: 4");
  });

  it("accepts an initializing v3 manifest with no panes", () => {
    const manifest = v3();
    manifest.status = "initializing";
    manifest.panes = [];
    delete manifest.progressPane;
    expect(SessionManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("DelegationRequest requestedBy director", () => {
  const base = {
    schemaVersion: 2,
    delegationId: "deleg-1",
    messageId: "msg-1",
    correlationId: "corr-1",
    sessionId: "bf-fixture-director",
    runId: "run-1",
    requestedBy: "director",
    targetRole: "coordinator",
    title: "Làm trang todo",
    objective: "Làm trang todo",
    specificationId: "spec-1",
    sddLevel: "lightweight",
    acceptanceCriteria: [{ id: "ac-1", description: "Có trang todo", category: "functional", verificationMethod: "unit_test", required: true, status: "pending", evidenceArtifactIds: [] }],
    inputArtifacts: [],
    priority: "normal",
    requestedAt: "2026-11-03T10:00:00.000Z",
    idempotencyKey: "director:msg-1"
  };

  it("accepts a valid director request", () => {
    const result = DelegationRequestSchema.safeParse(base);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it("rejects non-coordinator target, missing runId and roleProfile", () => {
    expect(DelegationRequestSchema.safeParse({ ...base, targetRole: "developer" }).success).toBe(false);
    const { runId: _runId, ...noRun } = base;
    expect(DelegationRequestSchema.safeParse(noRun).success).toBe(false);
    expect(DelegationRequestSchema.safeParse({ ...base, roleProfile: { profileId: "p", revision: 1, digest: "x" } }).success).toBe(false);
  });
});
