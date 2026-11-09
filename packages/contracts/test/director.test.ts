import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const time = "2026-11-03T10:00:00.000Z";

const session = {
  schemaVersion: 1,
  directorId: "director-1",
  provider: "claude",
  repositoryRoot: "/repo",
  tokenId: "token-1",
  startedAt: time,
  heartbeatAt: time,
  waitingSince: null
};

const message = {
  schemaVersion: 1,
  seq: 1,
  messageId: "msg-1",
  author: "user",
  channel: "web",
  text: "Làm trang todo",
  at: time
};

const issue = {
  schemaVersion: 1,
  issueId: "issue-1",
  runId: "run-1",
  kind: "verification_exhausted",
  status: "open",
  summary: "Verification exhausted",
  attempts: 3,
  evidence: ["artifact://sha256/abc"],
  createdAt: time,
  updatedAt: time
};

describe("director contracts", () => {
  it("accepts a valid session and rejects an unknown provider", () => {
    expect(contracts.DirectorSessionSchema.safeParse(session).success).toBe(true);
    expect(contracts.DirectorSessionSchema.safeParse({ ...session, provider: "gemini" }).success).toBe(false);
  });

  it("rejects unknown keys on a session (strict)", () => {
    expect(contracts.DirectorSessionSchema.safeParse({ ...session, token: "x" }).success).toBe(false);
  });

  it("rejects blank and oversized message text, accepts Vietnamese text", () => {
    expect(contracts.DirectorMessageSchema.safeParse({ ...message, text: "   " }).success).toBe(false);
    expect(contracts.DirectorMessageSchema.safeParse({ ...message, text: "a".repeat(16385) }).success).toBe(false);
    expect(contracts.DirectorMessageSchema.safeParse({ ...message, text: "Làm trang todo" }).success).toBe(true);
  });

  it("rejects seq 0 and an unknown author", () => {
    expect(contracts.DirectorMessageSchema.safeParse({ ...message, seq: 0 }).success).toBe(false);
    expect(contracts.DirectorMessageSchema.safeParse({ ...message, author: "coordinator" }).success).toBe(false);
  });

  it("validates parked issue evidence and attempts", () => {
    expect(contracts.ParkedIssueSchema.safeParse(issue).success).toBe(true);
    expect(contracts.ParkedIssueSchema.safeParse({ ...issue, evidence: ["https://x"] }).success).toBe(false);
    expect(contracts.ParkedIssueSchema.safeParse({ ...issue, attempts: -1 }).success).toBe(false);
  });

  it("accepts plan_mismatch as a parked issue kind and rejects unknown kinds", () => {
    expect(contracts.ParkedIssueSchema.safeParse({ ...issue, kind: "plan_mismatch" }).success).toBe(true);
    expect(contracts.ParkedIssueSchema.safeParse({ ...issue, kind: "invented" }).success).toBe(false);
  });

  it("accepts an empty wait result", () => {
    const empty = { cursor: "m0.i0.r", timedOut: true, messages: [], issues: [], runtimeEvents: [] };
    expect(contracts.DirectorWaitResultSchema.safeParse(empty).success).toBe(true);
  });

  it("accepts a progress snapshot with a running developer task and rejects an unknown presence", () => {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: time,
      director: { presence: "active" },
      runs: [{
        runId: "run-1",
        title: "Todo page",
        sdlcStatus: "implementing",
        tasks: [{ taskKey: "t1", title: "Build page", status: "running", role: "developer" }]
      }],
      pendingApprovals: 0,
      pendingQuestions: 0,
      issues: []
    };
    expect(contracts.DirectorProgressSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(contracts.DirectorProgressSnapshotSchema.safeParse({
      ...snapshot,
      director: { presence: "online" }
    }).success).toBe(false);
  });

  it("exposes the wait timing limits", () => {
    expect(contracts.DIRECTOR_LIMITS.waitDefaultMs).toBe(45000);
    expect(contracts.DIRECTOR_LIMITS.waitMaxMs).toBe(300000);
  });
});
