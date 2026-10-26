import { describe, expect, it } from "vitest";
import { AGY_INLINE_REPLY_BYTES } from "../../src/agentic/agy-assignment-admission.js";
import { taskHandoverView, taskHandoverAcknowledgement, deferredTaskHandover } from "../../src/agentic/task-handover-view.js";

const context = { binding: { runId: "r", taskId: "t" }, handover: { status: "selected", envelope: { content: {
  nextAction: "Continue", decisions: Array(8).fill("x".repeat(700)), disprovedHypotheses: Array(8).fill("漢".repeat(300)), untestedAngles: [], references: []
} } }, authority: { requirement: { objective: "Owner requirement" }, specification: { acceptanceCriteria: [{ id: "ac-1", description: "Keep policy" }] },
  approval: { approvalId: "pending" }, pendingAction: { reason: "Wait for owner" }, task: { metadata: { ownedPaths: ["src"] } } } };

describe("bounded handover presentation", () => {
  it("pages exact untrusted context and authoritative obligations within Agy's reply budget", () => {
    let offset = 0, cursor: string | undefined, assembled = "";
    do {
      const page = taskHandoverView(context, { view: "page", offset, ...(cursor ? { cursor } : {}) }, true) as any;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(AGY_INLINE_REPLY_BYTES);
      expect(page).toMatchObject({ code: "handover_context_paged", contextTrust: "untrusted_handover_with_host_authority" });
      assembled += page.page; cursor = page.cursor; offset = page.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(assembled)).toEqual(context);
  });
  it("automatically pages oversized Agy reads, keeps normal full reads, and refuses stale/mixed cursors", () => {
    const first = taskHandoverView(context, {}, true) as any;
    expect(first.code).toBe("handover_context_paged");
    expect(taskHandoverView(context, {}, false)).toEqual(context);
    expect(() => taskHandoverView({ ...context, authority: { approval: "changed" } }, { cursor: first.cursor, offset: first.nextOffset }, true)).toThrow(/handover_cursor_stale/);
    expect(() => taskHandoverView(context, { offset: 1 }, true)).toThrow(/cursor/);
  });
  it("defers automatic context and keeps acknowledgements bounded without dropping stored content", () => {
    const deferred = deferredTaskHandover(context) as any;
    expect(deferred).toMatchObject({ code: "handover_context_deferred", readWith: { tool: "read_task_handover", runId: "r", taskId: "t" } });
    expect(Buffer.byteLength(JSON.stringify(deferred))).toBeLessThan(1000);
    const acknowledgement = taskHandoverAcknowledgement({ ...context, handover: { ...context.handover, status: "accepted" } }) as any;
    expect(acknowledgement.handover.status).toBe("accepted");
    expect(acknowledgement.handover).not.toHaveProperty("envelope");
    expect(context.handover.envelope.content.decisions).toHaveLength(8);
  });
});
