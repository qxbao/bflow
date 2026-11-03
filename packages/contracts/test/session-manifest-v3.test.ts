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
const pin = { profileId: "profile-1", version: "1.0.0", digest: "a".repeat(64) };

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

  const issuesOf = (value: unknown) => {
    const result = SessionManifestSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }));
  };

  it("rejects a v3 manifest with a coordinator or conversation pane", () => {
    for (const role of ["coordinator", "conversation"]) {
      const manifest = v3();
      manifest.panes[0].role = role;
      expect(issuesOf(manifest)).toContainEqual({ path: "panes.0.role", message: `director session manifest must not contain a ${role} pane` });
    }
  });

  it("rejects a v3 up manifest without progressPane or with a non-running one", () => {
    const expected = { path: "progressPane", message: "session manifest in status 'up' must include a running progress pane" };
    const missing = v3();
    delete missing.progressPane;
    expect(issuesOf(missing)).toContainEqual(expected);
    const notRunning = v3();
    notRunning.progressPane.phase = "launch_unknown";
    expect(issuesOf(notRunning)).toContainEqual(expected);
  });

  it("rejects a mismatched attachTarget and duplicate pane ids", () => {
    const paneMismatch = v3();
    paneMismatch.attachTarget.paneId = "w1:p9";
    expect(issuesOf(paneMismatch)).toContainEqual({ path: "attachTarget.paneId", message: "attachTarget.paneId must equal progress pane's paneId" });
    const tabMismatch = v3();
    tabMismatch.attachTarget.tabId = "w1:t9";
    expect(issuesOf(tabMismatch)).toContainEqual({ path: "attachTarget.tabId", message: "attachTarget.tabId must equal progress pane's tabId" });
    const duplicate = v3();
    duplicate.panes[0].paneId = duplicate.progressPane.paneId;
    expect(issuesOf(duplicate)).toContainEqual({ path: "panes.0.paneId", message: `duplicate paneId in panes: ${duplicate.progressPane.paneId}` });
  });

  it("rejects a pane whose sessionId differs from the manifest", () => {
    const manifest = v3();
    manifest.panes[0].sessionId = "other-session";
    expect(issuesOf(manifest)).toContainEqual({
      path: "panes.0.sessionId",
      message: "pane sessionId other-session does not match manifest sessionId bf-fixture-director"
    });
  });

  it("rejects a pane roleProfile pin without a matching snapshot", () => {
    const manifest = v3();
    manifest.panes[0].roleProfile = pin;
    expect(issuesOf(manifest)).toContainEqual({
      path: "panes.0.roleProfile",
      message: "pane profile requires a matching pinned manifest snapshot and governance role"
    });
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

  it("rejects non-coordinator target, missing runId and roleProfile with the director rules", () => {
    const issues = (value: unknown) => {
      const result = DelegationRequestSchema.safeParse(value);
      return result.success ? [] : result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }));
    };
    expect(issues({ ...base, targetRole: "developer" })).toContainEqual({ path: "targetRole", message: "director can only create work for coordinator" });
    const { runId: _runId, ...noRun } = base;
    expect(issues(noRun)).toContainEqual({ path: "runId", message: "runId is required when director starts work" });
    expect(issues({ ...base, roleProfile: pin })).toEqual([{ path: "roleProfile", message: "only Coordinator may select a specialist profile" }]);
  });
});
