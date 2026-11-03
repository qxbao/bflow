import { describe, expect, it } from "vitest";
import { DIRECTOR_LIMITS, DirectorMailboxItemSchema, DirectorWaitResultSchema } from "../src/index.js";

const item = {
  schemaVersion: 1,
  seq: 1,
  messageId: "msg-1",
  at: "2026-11-03T10:00:00.000Z",
  audience: "user",
  runId: "run-1",
  type: "approval.request",
  kind: "approval",
  fromRole: "coordinator",
  summary: "Cần duyệt kế hoạch",
  text: "Bạn duyệt kế hoạch này nhé?",
  code: "#3"
};

describe("Director mailbox", () => {
  it("accepts a valid item and runtime sender", () => {
    expect(DirectorMailboxItemSchema.safeParse(item).success).toBe(true);
    expect(DirectorMailboxItemSchema.safeParse({ ...item, fromRole: "runtime", audience: "director" }).success).toBe(true);
  });

  it("rejects malformed approval aliases", () => {
    for (const code of ["3", "#0", "#a", "#03", "# 3"]) expect(DirectorMailboxItemSchema.safeParse({ ...item, code }).success).toBe(false);
  });

  it("keeps DirectorWaitResult without mailbox valid (B1 compatibility)", () => {
    const base = { cursor: "c1", timedOut: false, messages: [], issues: [], runtimeEvents: [] };
    expect(DirectorWaitResultSchema.safeParse(base).success).toBe(true);
    expect(DirectorWaitResultSchema.safeParse({ ...base, mailbox: [item] }).success).toBe(true);
    expect(DIRECTOR_LIMITS.mailboxPage).toBe(200);
    expect(DIRECTOR_LIMITS.mailboxMax).toBe(5000);
  });
});
