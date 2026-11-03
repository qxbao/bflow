import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, ApprovalRequestSchema, PaneBindingSchema, type ApprovalRequest, type SessionManifest } from "@bflow/contracts";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import {
  HUMAN_DECISION_CLI_METHOD, handleHumanDecisionCli, humanDecisionCliIdempotencyKey, type HumanDecisionCliDeps
} from "../../src/agentic/human-decision-cli.js";
import { USER_DECISION_METADATA_KIND } from "../../src/agentic/decision-routing.js";
import { isDirectorCredential, parseDirectorCredentialCall } from "../../src/director/host-methods.js";
import { DIRECTOR_TOOLS } from "../../src/director/tools.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

// B2a Task 9 (D-DIR-02): `bflow approve <#n>` is a human decision through the owner endpoint; the Director can never approve.

const dirs: string[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
const NOW = () => new Date().toISOString();
const CLI = { tty: true, pid: 4242 };

async function approvalSetup() {
  const f = await fixture({ director: true, humanApproval: true });
  const manifest: SessionManifest = unwrap(await f.panes.getManifest());
  const host = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "director-conversation"),
    noticeAliases: () => f.receipts.noticeAliases() });
  host.configureStructuredInteraction({ authorize: async () => true, now: NOW, approval: async () => undefined,
    resume: async command => ({ ok: true, value: { kind: "interaction", runId: command.runId, currentRunId: command.runId } }) });
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  const waiting = await f.inspect();
  expect(waiting.status).toBe("awaiting_approval");
  // The Runtime approval.request notice gets the user-facing #n alias exactly as in a live host.
  const notice = [...f.conversationInbox, ...((await f.runtime.inspect()) as any).outbound.map((out: any) => out.message)]
    .find((message: any) => message.type === "approval.request" && message.payload?.approvalId === waiting.approval.approvalId);
  expect(notice).toBeDefined();
  await f.receipts.appendConversationNotice(notice!);
  const aliases = await f.receipts.noticeAliases();
  const code = Object.entries(aliases.approvalShortIds).find(([, id]) => id === waiting.approval.approvalId)?.[0];
  expect(code).toMatch(/^#[1-9]\d*$/);
  const deps: HumanDecisionCliDeps = { conversationSessionId: manifest.conversationSessionId, now: NOW,
    aliases: () => f.receipts.noticeAliases(),
    pendingApprovals: query => f.runtime.pendingApprovals(query), inspect: () => f.runtime.inspect(),
    existingDecision: approvalId => f.receipts.humanDecision(approvalId),
    recordHuman: (decision, provenance) => f.receipts.recordHuman(decision, provenance),
    receiveOwnerDecision: (decision, record) => host.receiveOwnerDecision(decision, record) };
  const decisions = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "approval.decision");
  return { f, host, deps, code: code!, request: ApprovalRequestSchema.parse(waiting.approval), decisions };
}

describe("human_decision_cli host method", () => {
  it("builds the ApprovalDecision for the exact pending request, records a cli_owner receipt and queues approval.decision", async () => {
    const { f, host, deps, code, request, decisions } = await approvalSetup();
    const result = await handleHumanDecisionCli({ code, outcome: "approved", ...CLI }, deps);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ approvalId: request.approvalId, runId: "run-1", kind: "approval",
      queued: true, code, outcome: "approved", alreadyRecorded: false }) });
    const queued = await decisions();
    expect(queued).toHaveLength(1);
    const decision = ApprovalDecisionSchema.parse(queued[0].message.payload);
    expect(decision).toMatchObject({ approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId, target: request.target,
      revision: request.revision, generation: request.generation, decision: "approved", decidedBy: "human_operator",
      idempotencyKey: humanDecisionCliIdempotencyKey(code, request.approvalId, "approved", undefined) });
    expect(queued[0].delivery).toBe("director_mailbox");
    // The trusted receipt authenticates the queued decision exactly like a hook receipt.
    expect(await f.receipts.authenticateHuman(decision)).toBe(true);
    expect(await f.receipts.humanDecisions()).toEqual([decision]);
    // Gateway projection: the approval left pending and the decision is kept.
    const context = await host.getContext() as any;
    expect(context.pendingApprovals[request.approvalId]).toBeUndefined();
    // Runtime admits the delivered mailbox approval when its human authorization is the host receipt journal (as in the host):
    // it is not refused as unauthenticated. (The fixture's specification approver only knows its own test principal.)
    f.ports.authorizeHuman = (input: any) => f.receipts.authenticateHuman(input);
    await f.runtime.flushOutbound();
    expect((await decisions())[0].status).toBe("delivered");
    const inbox = ((await f.runtime.inspect()) as any).inbox.filter((item: any) => item.message.message_id === queued[0].message.message_id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).not.toBe("rejected");
  }, 60000);

  it("is idempotent: the same command twice records one receipt and one outbound; another answer is a conflict", async () => {
    const { deps, code, decisions } = await approvalSetup();
    expect((await handleHumanDecisionCli({ code, outcome: "approved", ...CLI }, deps)).ok).toBe(true);
    const again = await handleHumanDecisionCli({ code, outcome: "approved", tty: false, pid: 999 }, deps);
    expect(again).toEqual({ ok: true, value: expect.objectContaining({ queued: true, alreadyRecorded: true }) });
    expect(await decisions()).toHaveLength(1);
    const other = await handleHumanDecisionCli({ code, outcome: "rejected", ...CLI }, deps);
    expect(other).toMatchObject({ ok: false, error: { code: "conflict", message: `Thẻ ${code} đã có quyết định khác` } });
    expect(await decisions()).toHaveLength(1);
  }, 60000);

  it("changes_requested carries the reason; an unknown alias is not_found", async () => {
    const { deps, code, decisions } = await approvalSetup();
    expect(await handleHumanDecisionCli({ code: "#99", outcome: "approved", ...CLI }, deps))
      .toEqual({ ok: false, error: { code: "not_found", retryable: false, message: "Không tìm thấy thẻ #99 đang chờ" } });
    expect((await handleHumanDecisionCli({ code, outcome: "changes_requested", reason: "Thêm kiểm thử", ...CLI }, deps)).ok).toBe(true);
    expect((await decisions())[0].message.payload).toMatchObject({ decision: "changes_requested", reason: "Thêm kiểm thử" });
  }, 60000);

  it("a Gateway-closed (superseded/expired) card is a conflict with the Gateway reason and records nothing", async () => {
    const { f, host, deps, code, request, decisions } = await approvalSetup();
    await host.reconcileApprovals();
    const directory = join(f.root, "director-conversation");
    const { FileConversationContextStore } = await import("@bflow/conversation");
    const store = new FileConversationContextStore(directory);
    const sessionId = (await f.panes.getManifest() as any).value.conversationSessionId;
    const loaded = (await store.load(sessionId) as any).value;
    const { [request.approvalId]: _gone, ...pendingApprovals } = loaded.pendingApprovals;
    await store.save({ ...loaded, pendingApprovals, closedApprovals: { [request.approvalId]: { approvalId: request.approvalId, runId: "run-1",
      status: "expired", reason: "Thẻ đã hết hạn", closedAt: NOW() } } });
    // A fresh gateway over the same store sees the closure (as after a host restart).
    const reopened = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory: directory });
    const result = await handleHumanDecisionCli({ code, outcome: "approved", ...CLI }, { ...deps,
      receiveOwnerDecision: (decision, record) => reopened.receiveOwnerDecision(decision, record) });
    expect(result).toMatchObject({ ok: false, error: { code: "conflict", message: `Thẻ ${code}: Thẻ đã hết hạn` } });
    expect(await decisions()).toHaveLength(0);
    expect(await f.receipts.humanDecisions()).toEqual([]);
  }, 60000);
});

describe("human_decision_cli refusals without a pending card", () => {
  const userDecisionRequest = (overrides: Partial<ApprovalRequest> = {}) => ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "apr-ud-1",
    runId: "run-1", sessionId: "conv-1", target: { type: "run" }, revision: 1, generation: 0, requestedBy: "developer",
    requestedAt: "2026-11-03T09:00:00.000Z", reason: "Chọn cách làm", evidence: [], idempotencyKey: "ud-1",
    metadata: { kind: USER_DECISION_METADATA_KIND, options: ["Cách A", "Cách B"] }, ...overrides });
  function fakeDeps(state: unknown, pending: ApprovalRequest[] = []) {
    const recorded: unknown[] = [], admitted: unknown[] = [];
    const deps: HumanDecisionCliDeps = { conversationSessionId: "conv-1", now: () => "2026-11-03T10:00:00.000Z",
      aliases: async () => ({ approvalShortIds: { "#3": "apr-ud-1" }, runShortIds: { "việc #2": "run-1" } }),
      pendingApprovals: async () => pending.map(request => ({ request })), inspect: async () => state,
      existingDecision: async () => undefined, recordHuman: async decision => { recorded.push(decision); },
      receiveOwnerDecision: async (decision, record) => { admitted.push(decision); await record(decision); return { ok: true, value: { queued: true } }; } };
    return { deps, recorded, admitted };
  }
  it("an expired user decision is a conflict", async () => {
    const { deps, recorded } = fakeDeps({ runs: [{ runId: "run-1", status: "implementing", userDecisions: { "apr-ud-1": { status: "expired", request: userDecisionRequest() } } }] });
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "answer", choice: 1, ...CLI }, deps))
      .toEqual({ ok: false, error: { code: "conflict", retryable: true, message: "Thẻ #3: câu hỏi đã ở trạng thái expired" } });
    expect(recorded).toEqual([]);
  });
  it("a terminal run is a conflict", async () => {
    const { deps } = fakeDeps({ runs: [{ runId: "run-1", status: "completed", approval: { approvalId: "apr-ud-1" } }] });
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "approved", ...CLI }, deps))
      .toMatchObject({ ok: false, error: { code: "conflict", message: "Thẻ #3: việc đã kết thúc (completed)" } });
  });
  it("a user decision is answered with --choice and validated against its offered options", async () => {
    const { deps, admitted } = fakeDeps({ runs: [] }, [userDecisionRequest()]);
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "approved", ...CLI }, deps))
      .toMatchObject({ ok: false, error: { code: "validation", message: "Thẻ #3 là câu hỏi có lựa chọn; dùng --choice <n> (1..2)" } });
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "answer", choice: 3, ...CLI }, deps))
      .toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "changes_requested", reason: "x", ...CLI }, deps))
      .toMatchObject({ ok: false, error: { code: "validation" } });
    const answered = await handleHumanDecisionCli({ code: "#3", outcome: "answer", choice: 2, ...CLI }, deps);
    expect(answered).toEqual({ ok: true, value: expect.objectContaining({ kind: "user_decision", runLabel: "việc #2", selectedOption: "Cách B" }) });
    expect(admitted).toEqual([expect.objectContaining({ decision: "approved", decidedBy: "human_operator", metadata: { selectedOption: "Cách B" } })]);
  });
  it("--choice on a non-decision approval is refused", async () => {
    const { deps } = fakeDeps({ runs: [] }, [userDecisionRequest({ metadata: {} })]);
    expect(await handleHumanDecisionCli({ code: "#3", outcome: "answer", choice: 1, ...CLI }, deps))
      .toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("D-DIR-02: the Director cannot approve", () => {
  const ownerToken = "a".repeat(64), directorToken = `director-1.${"s".repeat(32)}`;
  it("a Director credential calling human_decision_cli is refused before any dispatch", () => {
    expect(isDirectorCredential(directorToken, ownerToken)).toBe(true);
    expect(() => parseDirectorCredentialCall(HUMAN_DECISION_CLI_METHOD, { code: "#1", outcome: "approved", ...CLI }))
      .toThrow("Director credentials can only call director tools");
  });
  it("no Director tool is named for approval or decision", () => {
    expect(DIRECTOR_TOOLS.length).toBeGreaterThan(0);
    expect(DIRECTOR_TOOLS.filter(tool => /approve|decision/i.test(tool.name))).toEqual([]);
  });
});

describe("cli_owner human receipts", () => {
  async function journal() {
    const directory = await mkdtemp(join(tmpdir(), "human-cli-receipts-")); dirs.push(directory);
    return new HostReceiptJournal(join(directory, "receipts"), "/repo", "session-1");
  }
  const decision = (overrides: Record<string, unknown> = {}) => ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: "apr-1", runId: "run-1",
    sessionId: "conv-1", target: { type: "run" }, revision: 1, generation: 0, decision: "approved", decidedBy: "human_operator",
    decidedAt: "2026-11-03T10:00:00.000Z", reason: "User approved", feedbackArtifacts: [], idempotencyKey: "cli-abc", ...overrides });
  const provenance = { kind: "cli_owner" as const, pid: 1, tty: false, at: "2026-11-03T10:00:00.000Z" };
  it("authenticateHuman accepts a cli_owner receipt like a hook receipt and replays it for recovery", async () => {
    const receipts = await journal();
    await receipts.recordHuman(decision(), provenance);
    expect(await receipts.authenticateHuman(decision())).toBe(true);
    expect(await receipts.authenticateHuman(decision({ reason: "other" }))).toBe(false);
    expect(await receipts.humanDecision("apr-1")).toEqual(decision());
    expect(await receipts.humanDecisions()).toEqual([decision()]);
  });
  it("refuses a cli_owner receipt for a non-human principal, a non-CLI key or malformed provenance", async () => {
    const receipts = await journal();
    await expect(receipts.recordHuman(decision({ decidedBy: "director" }), provenance)).rejects.toThrow("mismatched CLI owner provenance");
    await expect(receipts.recordHuman(decision({ idempotencyKey: "web-1" }), provenance)).rejects.toThrow("mismatched CLI owner provenance");
    await expect(receipts.recordHuman(decision(), { ...provenance, pid: 0 })).rejects.toThrow();
    await expect(receipts.recordHuman(decision(), { ...provenance, kind: "web" } as never)).rejects.toThrow();
  });
  it("still validates prompt-hook provenance", async () => {
    const receipts = await journal();
    const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "b-1", sessionId: "session-1", role: "conversation", paneGroup: "conversation",
      agentId: "a-1", workspaceId: "w-1", tabId: "t-1", paneId: "p-1", provider: "claude", agentKind: "claude", cwd: "/tmp", isolationMode: "dedicated_pane",
      readOnlyWorkspace: true, session: { source: "herdr:claude", kind: "id", value: "native-1" }, transportState: "idle", boundAt: "2026-11-03T10:00:00.000Z" });
    await expect(receipts.recordHuman(decision({ decidedBy: "local-user-1" }), { origin: "UserPromptSubmit", binding, nativeSessionId: "other",
      conversationSessionId: "conv-1", userId: "local-user-1", messageId: "m-1", promptDigest: "f".repeat(64) })).rejects.toThrow("mismatched trusted hook provenance");
  });
});
