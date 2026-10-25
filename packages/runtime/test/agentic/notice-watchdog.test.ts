import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleMessage } from "@bflow/contracts";
import { draft } from "../../../specification/test/fixtures.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";
import { decisionMessageId, evaluateWatchdog, type RunFacts, type WatchdogAction } from "../../src/agentic/run-watchdog.js";
import { z } from "zod";
import { WorkflowProposalRejected, describeWorkflowRejection, guardWorkflowProposal, reportsToUser } from "../../src/agentic/workflow-rejection.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const SESSION = "session-1";
const APPROVAL_ID = "apr-user-decision-0123456789abcdef";
const REQUESTED_AT = "2026-10-20T03:00:00.000Z";
const T0 = Date.parse(REQUESTED_AT);
const SEC = 1000;

function run(overrides: Partial<RunFacts> = {}): RunFacts {
  return { runId: "run-1", status: "implementing", live: true, lastActivityAt: T0, awaitingHuman: false, activeHandoff: false,
    pendingDecisions: [], ...overrides };
}
const pending = { approvalId: APPROVAL_ID, requestedAt: REQUESTED_AT };
const notice = (overrides: Partial<{ surfaced: boolean; displayed: boolean; resends: number; since: string }> = {}) => ({
  messageId: decisionMessageId(APPROVAL_ID), surfaced: false, displayed: false, resends: 0, since: REQUESTED_AT, ...overrides
});
const idlePanes = [{ role: "coordinator", status: "idle" }, { role: "developer", status: "done" }];

describe("workflow proposal rejection", () => {
  it("classifies an unconfigured criterion as missing_behavioral_runner with methods, criteria and three informational options", () => {
    const rejection = describeWorkflowRejection({ error: new Error("No owner-configured behavioral runner for unit_test"), phase: "verification",
      specification: draft("api"), configuredMethods: [] });
    expect(rejection).toMatchObject({ code: "missing_behavioral_runner", methods: ["unit_test"], criteria: ["ac-1"] });
    expect(rejection.reason).toContain("unit_test");
    expect(rejection.options).toHaveLength(3);
    expect(rejection.options[0]).toContain("auto:unit");
    expect(rejection.options[0]).not.toContain(".bflow/verification.json");
    expect(rejection.options[0]).not.toContain("journal");
    expect(rejection.options[1]).toContain("manual_review");
    expect(rejection.options[2]).toBe("Hủy run này.");
  });

  it("does not ask for a runner when the criterion's method is configured or the criterion is manual review", () => {
    const configured = describeWorkflowRejection({ error: new Error("Mixed criteria"), phase: "verification", specification: draft("api"),
      configuredMethods: ["unit_test"] });
    expect(configured.code).toBe("unsupported_verification");
    expect(configured).not.toHaveProperty("methods");
    const manual = describeWorkflowRejection({ error: new Error("x"), phase: "verification", specification: draft("documentation"), configuredMethods: [] });
    expect(manual).not.toHaveProperty("methods");
  });

  it("returns a schema-invalid specification to the Coordinator as invalid_specification with path-qualified issues", () => {
    const { error } = z.object({ metadata: z.object({ conditionalTdd: z.object({ taskId: z.string() }) }) }).safeParse({ metadata: {} });
    const rejection = describeWorkflowRejection({ error, phase: "specification", specification: draft("api"), configuredMethods: [] });
    expect(rejection.code).toBe("invalid_specification");
    expect(rejection.reason).toContain("metadata.conditionalTdd: Required");
    expect(rejection.reason).not.toContain("\"path\"");
    expect(reportsToUser(rejection)).toBe(false);
    const plain = describeWorkflowRejection({ error: new Error("Invalid Specification.metadata.conditionalTdd assessment."), phase: "specification",
      specification: draft("api"), configuredMethods: ["unit_test"] });
    expect(plain).toMatchObject({ code: "invalid_specification" });
    expect(plain.reason).toContain("metadata.conditionalTdd");
  });

  it("reports project policy failures as policy_violation", () => {
    const rejection = describeWorkflowRejection({ error: new Error("Project policy requires a full specification"), phase: "policy",
      specification: draft("api"), configuredMethods: [] });
    expect(rejection.code).toBe("policy_violation");
    expect(rejection.options).toHaveLength(2);
  });

  it("guards a proposal by throwing a structured error whose message is the rejection JSON, and never mutates the specification", () => {
    const specification = draft("api"), before = structuredClone(specification);
    expect(() => guardWorkflowProposal({ phase: "verification", specification, configuredMethods: [], check: () => undefined })).not.toThrow();
    let caught: unknown;
    try {
      guardWorkflowProposal({ phase: "verification", specification, configuredMethods: [], check: () => {
        throw new Error("No owner-configured behavioral runner for unit_test");
      } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WorkflowProposalRejected);
    const rejection = (caught as WorkflowProposalRejected).rejection;
    expect(JSON.parse((caught as Error).message)).toEqual(rejection);
    expect(rejection.code).toBe("missing_behavioral_runner");
    expect(specification).toEqual(before);
  });
});

describe("run watchdog decisions", () => {
  it("takes no action for a displayed pending decision, a working agent or a terminal run", () => {
    const now = T0 + 600 * SEC;
    expect(evaluateWatchdog({ now, runs: [run({ pendingDecisions: [pending] })], notices: [notice({ surfaced: true, displayed: true, since: REQUESTED_AT })], panes: idlePanes })).toEqual([]);
    // A recently surfaced, undisplayed question waits; a working agent does not change that, and it suppresses stalls.
    expect(evaluateWatchdog({ now, runs: [run({ pendingDecisions: [pending] })], notices: [notice({ surfaced: true, since: new Date(now - 10 * SEC).toISOString() })],
      panes: [{ role: "developer", status: "working" }] })).toEqual([]);
    expect(evaluateWatchdog({ now, runs: [run({ live: false, status: "completed", lastActivityAt: T0 })], notices: [], panes: idlePanes })).toEqual([]);
  });

  it("reconciles a pending decision that has no notice receipt, but only after the grace period", () => {
    const runs = [run({ pendingDecisions: [pending] })];
    expect(evaluateWatchdog({ now: T0 + 30 * SEC, runs, notices: [], panes: idlePanes })).toEqual([]);
    expect(evaluateWatchdog({ now: T0 + 61 * SEC, runs, notices: [], panes: idlePanes })).toEqual([
      { kind: "reconcile_notice", runId: "run-1", approvalId: APPROVAL_ID, messageId: `decision-${APPROVAL_ID}` }
    ]);
  });

  it("resurfaces a surfaced but undisplayed decision after 60 seconds, with the next attempt number", () => {
    const runs = [run({ pendingDecisions: [pending] })];
    const surfacedAt = Date.parse(REQUESTED_AT) + 5 * SEC;
    const since = new Date(surfacedAt).toISOString();
    expect(evaluateWatchdog({ now: surfacedAt + 60 * SEC, runs, notices: [notice({ surfaced: true, since })], panes: idlePanes })).toEqual([]);
    expect(evaluateWatchdog({ now: surfacedAt + 61 * SEC, runs, notices: [notice({ surfaced: true, since, resends: 1 })], panes: idlePanes })).toEqual([
      { kind: "resurface", runId: "run-1", approvalId: APPROVAL_ID, messageId: `decision-${APPROVAL_ID}`, attempt: 2 }
    ]);
  });

  it("emits a blocked action instead of a fourth resurfacing", () => {
    const actions = evaluateWatchdog({ now: T0 + 500 * SEC, runs: [run({ pendingDecisions: [pending] })],
      notices: [notice({ surfaced: true, since: REQUESTED_AT, resends: 3 })], panes: idlePanes });
    expect(actions).toEqual([{ kind: "blocked", runId: "run-1", approvalId: APPROVAL_ID, messageId: `decision-${APPROVAL_ID}`, resends: 3 }]);
  });

  it("reports a live run from run-local work, even when an unrelated role pane is busy", () => {
    const facts = run({ lastActivityAt: T0 });
    expect(evaluateWatchdog({ now: T0 + 180 * SEC, runs: [facts], notices: [], panes: idlePanes })).toEqual([]);
    const actions = evaluateWatchdog({ now: T0 + 181 * SEC, runs: [facts], notices: [], panes: idlePanes });
    expect(actions).toEqual([{ kind: "stalled", runId: "run-1", episodeKey: `run-1@${T0}`, idleSince: T0 }]);
    expect(evaluateWatchdog({ now: T0 + 181 * SEC, runs: [facts], notices: [], panes: [{ role: "reviewer", paneId: "other-pane", status: "working" }] }))
      .toEqual([{ kind: "stalled", runId: "run-1", episodeKey: `run-1@${T0}`, idleSince: T0 }]);
    expect(evaluateWatchdog({ now: T0 + 181 * SEC, runs: [facts], notices: [], panes: [{ role: "reviewer", paneId: "other-pane", status: "unavailable" }] }))
      .toEqual([{ kind: "stalled", runId: "run-1", episodeKey: `run-1@${T0}`, idleSince: T0 }]);
  });

  it.each(["intake", "clarifying", "specifying", "planning", "tdd_deciding", "implementing", "verifying", "reviewing"] as const)(
    "applies the same missing-next-action liveness rule during %s", status => {
      const facts = run({ status, lastActivityAt: T0, awaitingHuman: false, activeHandoff: false, acceptedRoles: [], pendingDecisions: [] });
      expect(evaluateWatchdog({ now: T0 + 181 * SEC, runs: [facts], notices: [], panes: [] })).toEqual([
        { kind: "stalled", runId: "run-1", episodeKey: `run-1@${T0}`, idleSince: T0 }
      ]);
    }
  );

  it("never reports a stall while a human gate, a handoff or a pending decision is open", () => {
    const now = T0 + 900 * SEC;
    expect(evaluateWatchdog({ now, runs: [run({ awaitingHuman: true })], notices: [], panes: idlePanes })).toEqual([]);
    expect(evaluateWatchdog({ now, runs: [run({ activeHandoff: true })], notices: [], panes: idlePanes })).toEqual([]);
    const withDecision = evaluateWatchdog({ now, runs: [run({ pendingDecisions: [pending] })], notices: [notice({ displayed: true })], panes: idlePanes });
    expect(withDecision.some(action => action.kind === "stalled")).toBe(false);
  });

  it("changes the stall episode key with every new activity, so each episode reports once", () => {
    const first = evaluateWatchdog({ now: T0 + 400 * SEC, runs: [run({ lastActivityAt: T0 })], notices: [], panes: idlePanes });
    const second = evaluateWatchdog({ now: T0 + 400 * SEC, runs: [run({ lastActivityAt: T0 + 100 * SEC })], notices: [], panes: idlePanes });
    const keys = [first, second].map(actions => (actions[0] as Extract<WatchdogAction, { kind: "stalled" }>).episodeKey);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("notice receipts for the watchdog", () => {
  async function journal(): Promise<HostReceiptJournal> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-notice-watchdog-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    return new HostReceiptJournal(join(root, "receipts"), join(root, "repo"), SESSION);
  }
  const decisionMessage = (question: string, options: string[]): RoleMessage => ({ schema_version: 2,
    message_id: decisionMessageId(APPROVAL_ID), correlation_id: "corr-1", run_id: "run-1", sender: { role: "runtime" },
    recipient: { role: "conversation" }, type: "approval.request", artifact_references: [], occurred_at: REQUESTED_AT,
    idempotency_key: `approval-${APPROVAL_ID}`,
    payload: { schemaVersion: 2, approvalId: APPROVAL_ID, runId: "run-1", expiresAt: "2026-10-20T03:30:00.000Z",
      metadata: { kind: "user_decision", question, requestedByRole: "developer", options } } } as unknown as RoleMessage);

  it("keeps a long decision askable: the structured fields survive the summary cap", async () => {
    const receipts = await journal();
    const options = Array.from({ length: 6 }, (_, index) => `Lựa chọn ${index + 1} ${"x".repeat(400)}`);
    await receipts.appendConversationNotice(decisionMessage("Q".repeat(1500), options));
    const [stored] = await receipts.unsurfacedConversationNotices();
    expect(stored!.truncated).toBe(true);
    const rendered = renderConversationNotice(stored!);
    expect(rendered.kind).toBe("user_decision");
    expect(rendered).toMatchObject({ approvalId: APPROVAL_ID, shortId: "#1" });
    expect(rendered.display).toContain('Bạn trả lời: "#1: 1"');
    expect(rendered.display).toContain("6. Lựa chọn 6");
    expect(rendered.display).toContain("hết hạn lúc");
  });

  it("resurfaces a notice as a new epoch and stops once it is displayed", async () => {
    const receipts = await journal(), id = decisionMessageId(APPROVAL_ID);
    await receipts.appendConversationNotice(decisionMessage("Dùng schema nào?", ["Schema v2", "Giữ v1"]));
    await receipts.markConversationNoticesSurfaced([id]);
    expect((await receipts.unsurfacedConversationNotices()).map(item => item.messageId)).toEqual([]);
    expect((await receipts.conversationNoticeStates())[0]).toMatchObject({ approvalId: APPROVAL_ID, surfaced: true, displayed: false, resends: 0 });

    expect(await receipts.resurfaceConversationNotice(id)).toBe(1);
    expect((await receipts.unsurfacedConversationNotices()).map(item => item.messageId)).toEqual([id]);
    expect((await receipts.conversationNoticeStates())[0]).toMatchObject({ surfaced: false, resends: 1 });

    await receipts.markConversationNoticesSurfaced([id]);
    expect((await receipts.unsurfacedConversationNotices()).map(item => item.messageId)).toEqual([]);
    expect((await receipts.conversationNoticeStates())[0]).toMatchObject({ surfaced: true, resends: 1 });
    expect(await receipts.resurfaceConversationNotice(id)).toBe(2);

    await receipts.markConversationNoticesSurfaced([id]);
    expect(await receipts.markConversationNoticesDisplayed([id])).toEqual([id]);
    expect((await receipts.conversationNoticeStates())[0]).toMatchObject({ displayed: true });
    expect(await receipts.resurfaceConversationNotice(id)).toBeUndefined();
  });

  it("does not resurface an unknown notice", async () => {
    const receipts = await journal();
    expect(await receipts.resurfaceConversationNotice("decision-apr-missing")).toBeUndefined();
  });
});
