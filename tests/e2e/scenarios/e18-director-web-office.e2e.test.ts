import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DirectorWaitResultSchema, WebCommandSchema, type ApprovalDecision, type DirectorMessage, type ParkedIssue } from "@bflow/contracts";
import { documentationSpecification, singleTaskWorkflow, createDirectorSession, type DirectorSession } from "../helpers/director-session.js";
import { HOST_CONVERSATION_SESSION, PROJECT_ID, createWebDirectorSession, directorWebBridge, issueCommand, projectionToken, seeded, webPrincipal } from "../helpers/director-web.js";

// Director C/D Task 9: cross-slice Web → Director → Runtime acceptance with the real Runtime/Core/RunStore/Registry/Git and fake
// specialists/transport. Evidence level: source + fake runner (no Local Server socket here; see apps/cli/test/director-web-host.test.ts).

const sessions: DirectorSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.cleanup(); });

const CRITERION = "The requested outcome is independently verifiable";
const ok = <T = any>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const webSend = (content: string, extra: Partial<{ messageId: string; sessionId: string; runId: string }> = {}) =>
  ({ apiVersion: 1 as const, messageId: extra.messageId ?? randomUUID(), projectId: PROJECT_ID, sessionId: extra.sessionId ?? HOST_CONVERSATION_SESSION, content,
    ...(extra.runId ? { runId: extra.runId } : {}) });

/** Answers the pending approval of `runId` through the structured gateway exactly as the Web decision path does (E17). */
async function webApproval(session: DirectorSession, runId: string, authorized: ApprovalDecision[]): Promise<void> {
  const waiting = await session.inspect(runId);
  expect(waiting.status).toBe("awaiting_approval");
  await session.chat.reconcileApprovals();
  const pending = (await session.chat.getContext() as any).pendingApprovals[waiting.approval.approvalId];
  expect(pending).toBeDefined();
  const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: PROJECT_ID, kind: "answer_decision", runId,
    decisionId: pending.approvalId, outcome: "approved",
    expectedVersion: { revisionToken: projectionToken(pending), approvalId: pending.approvalId, target: pending.target, revision: pending.revision,
      generation: pending.generation, evidenceDigest: projectionToken(pending.evidence) } });
  const before = session.humanDecisions.length;
  expect((await session.chat.handleStructuredInteraction(command, webPrincipal(command) as never)).ok).toBe(true);
  expect(session.humanDecisions).toHaveLength(before + 1);
  await session.runtime.flushOutbound();
  const decision = session.humanDecisions.at(-1)!;
  expect(authorized.some(item => item.approvalId === decision.approvalId)).toBe(true);
}

/** Three-task workflow of E17 scenario 2: `implement`, `after` (depends on implement) and `independent`. */
function threeTaskPlan(runId: string, specificationId: string) {
  const spec = documentationSpecification(runId, specificationId);
  spec.affectedPaths = ["guide.md", "after.md", "independent.md"]; spec.traceabilityTaskIds = ["implement", "after", "independent"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = spec.traceabilityTaskIds;
  const definition = singleTaskWorkflow();
  definition.tasks = [definition.tasks[0]!, ...["after", "independent"].map(id => ({ ...structuredClone(definition.tasks[0]!), id, title: id,
    metadata: { ownedPaths: [id === "after" ? "after.md" : "independent.md"] } }))];
  (definition.dependencies as any[]) = [{ taskId: "after", dependsOnTaskId: "implement", condition: "succeeded" }];
  return { specification: spec, definition };
}

/** Parks `implement` through the Runtime's own stall → escalation → auto-park path (no Director authority involved). */
async function stallAndAutoPark(session: DirectorSession, runId: string) {
  const assigned = (await session.state()).outbound.find((out: any) => out.taskId === "implement" && out.message.type === "task.assignment" && out.message.run_id === runId);
  expect(assigned.status).toBe("accepted");
  const binding = session.panes.bindings.find(pane => pane.paneId === assigned.handle.target.paneId)!;
  binding.metadata = { runId, taskId: `${runId}-implement` };
  session.ports.stopDeveloperExecutionScope = async handle => ({ source: "linux_pid_namespace", handle, observedAt: new Date().toISOString(),
    scopeId: randomUUID(), bootId: randomUUID(), initPid: 123, initStartTime: "1", namespace: "pid:[123]", receiptDigest: "a".repeat(64) });
  await session.runtime.reportRunStalled(runId, "stall-reminder"); await session.runtime.flushOutbound();
  await session.runtime.reportRunStalled(runId, "stall-escalated");
  const reduced = { enabled: true, maxAutoResumesBeforePark: 0 };
  expect(await session.runtime.resumeRecoverableRuns(reduced)).toEqual({ resumed: 0 });
  expect(await session.runtime.autoParkPass(reduced)).toMatchObject({ parked: [{ taskId: "implement", kind: "transport_failure" }] });
}

const parkHistory = async (session: DirectorSession, runId: string) =>
  ((await session.inspect(runId)).tasks.find((task: any) => task.taskId === "implement")?.parkHistory ?? []).length;

describe("Scenario E18 — Director Web × Runtime × issue queue (manifest v3, fake runner)", () => {
  it("Web message → director_wait → director_say → transcript/feed → start_work → Web approval → park → independent → restart → Web retry → completed", async () => {
    const { session, authorized } = await createWebDirectorSession({ humanApproval: true, inspectRun: true });
    sessions.push(session);
    let { bridge, feed } = directorWebBridge(session);
    await bridge.refresh();

    // 1. The Web sends while no Director is present: the host queues it (written, absent ≠ refused).
    expect(ok(await bridge.view(PROJECT_ID))).toMatchObject({ layout: "director", sessionId: HOST_CONVERSATION_SESSION, snapshot: { director: { presence: "absent" } } });
    const request = webSend("Cập nhật guide.md, after.md và independent.md theo yêu cầu");
    const queued = ok(await bridge.send(request));
    expect(queued).toMatchObject({ seq: 1, messageId: request.messageId, author: "user", channel: "web" });
    await bridge.refresh();
    expect(feed.filter(event => event.type === "chat").flatMap(event => event.resourceIds)).toEqual([request.messageId]);

    // 2. The CLI Director opens and director_wait delivers the queued Web message (durable ack, pre-registration replay).
    const registered = await session.endpoint.register({ provider: "claude" });
    const waited = DirectorWaitResultSchema.parse(await session.endpoint.call(registered.token, "director_wait", { cursor: registered.cursor, timeoutMs: 1000 }));
    expect(waited.messages.map(message => message.messageId)).toEqual([request.messageId]);
    // Web history reads are read-only: no ack and no heartbeat. A reopened Director still gets the same message (at-least-once).
    for (let read = 0; read < 3; read++) ok(await bridge.history(PROJECT_ID));
    const reopened = await session.endpoint.register({ provider: "claude" });
    const replayed = DirectorWaitResultSchema.parse(await session.endpoint.call(reopened.token, "director_wait", { cursor: reopened.cursor, timeoutMs: 1000 }));
    expect(replayed.messages.map(message => message.messageId)).toEqual([request.messageId]);
    // The returned cursor is the ack: after it, a reopened Director starts past the message.
    await session.endpoint.call(reopened.token, "director_wait", { cursor: replayed.cursor, timeoutMs: 50 });
    const token = (await session.endpoint.register({ provider: "claude" })).token;
    const past = DirectorWaitResultSchema.parse(await session.endpoint.call(token, "director_wait", { cursor: "", timeoutMs: 50 }));
    expect(past.messages).toEqual([]);

    // 3. director_say reaches the Web transcript (author director, channel cli) and the feed; Director token text is redacted.
    await session.endpoint.call(token, "director_say", { text: `Đã nhận, bắt đầu công việc (token ${token})` });
    await bridge.refresh();
    const transcript = ok(await bridge.history(PROJECT_ID));
    expect(transcript.items).toMatchObject([{ seq: 1, author: "user", channel: "web" }, { seq: 2, author: "director", channel: "cli" }]);
    expect(JSON.stringify(transcript)).not.toContain(token);
    expect(feed.filter(event => event.type === "chat").flatMap(event => event.resourceIds)).toEqual(transcript.items.map((item: DirectorMessage) => item.messageId));
    expect(feed.some(event => event.type === "invalidate" && event.resourceIds.includes("director"))).toBe(true);

    // 4. start_work with the Web message as the user's evidence of intent; propose the three-task workflow.
    const started = await session.endpoint.call(token, "start_work", { title: "Cập nhật hướng dẫn", objective: "Ba tệp hướng dẫn phản ánh yêu cầu",
      acceptanceCriteria: [{ description: CRITERION, verificationMethod: "manual_review" }], sddLevel: "lightweight", userMessageSeq: queued.seq }) as
      { runId: string; correlationId: string; status: string };
    expect(started.status).toBe("queued");
    session.trackRun(started.runId, started.correlationId);
    const runId = started.runId;
    expect(await session.inspect(runId)).toMatchObject({ delegation: { requestedBy: "director", sessionId: HOST_CONVERSATION_SESSION } });
    const plan = threeTaskPlan(runId, (await session.inspect(runId)).delegation.specificationId);
    await session.endpoint.call(token, "propose_workflow", { runId, ...plan });
    expect((await session.inspect(runId)).status).toBe("awaiting_approval");

    // 5. Chat text is never an approval: "duyệt" on the Web chat leaves the design approval pending.
    ok(await bridge.send(webSend("duyệt #1", { runId })));
    await session.runtime.tick();
    expect((await session.inspect(runId)).status).toBe("awaiting_approval");
    expect(session.humanDecisions).toHaveLength(0);
    // A Web message bound to a foreign run is refused before any write.
    const foreign = await bridge.send(webSend("không thuộc phiên", { runId: "run-foreign" }));
    expect(foreign).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });

    // 6. Human approval through the authenticated Web decision path.
    await webApproval(session, runId, authorized);
    expect((await session.inspect(runId)).status).toBe("implementing");
    await session.runtime.tick();

    // 7. Fault: `implement` stalls and is auto-parked; the Web issue queue shows exactly one open issue for this run.
    await stallAndAutoPark(session, runId);
    const issuesAfterPark = ok(await bridge.issues(PROJECT_ID)).items;
    expect(issuesAfterPark).toMatchObject([{ runId, taskKey: "implement", status: "open", kind: "transport_failure" }]);
    const parkedIssue: ParkedIssue = issuesAfterPark[0]!;

    // 8. Independent work finishes while A is parked and B (depends on A) stays pending.
    await session.runtime.tick();
    await session.evidence(runId, "independent"); await session.submit(runId, "independent", "independent.md");
    for (let pass = 0; pass < 5 && (await session.inspect(runId)).status !== "completed_with_parked"; pass++) await session.tickWithReviewer();
    expect((await session.inspect(runId)).status).toBe("completed_with_parked");
    const partial = (ok(await session.ports.engine.getSnapshot(runId)) as any);
    expect(partial.tasks.map((task: any) => [task.taskId, task.status])).toEqual([["implement", "parked"], ["after", "pending"], ["independent", "succeeded"]]);

    // 9. Down/up barrier on the same actual manifest: quiesce, checkpoint, close; reopen every durable store and resume.
    await session.runtime.quiesce();
    const stored = (ok(await session.store.get(runId)) as any);
    const checkpoint = await session.runtime.checkpoint({ runId, expectedVersion: stored.snapshot.version, checkpointId: `e18-${randomUUID()}`, createdAt: new Date().toISOString() });
    expect(checkpoint).toMatchObject({ runId });
    const before = { status: (await session.inspect(runId)).status, issues: ok(await bridge.issues(PROJECT_ID)).items, transcript: ok(await bridge.history(PROJECT_ID)).items };
    session.close(); sessions.splice(sessions.indexOf(session), 1);
    const restarted = await createWebDirectorSession({ humanApproval: true, inspectRun: true, root: session.root, panes: session.panes });
    const next = restarted.session; sessions.push(next);
    next.trackRun(runId, started.correlationId);
    ({ bridge, feed } = directorWebBridge(next));
    await bridge.refresh();
    // The reopened durable journal is bound to the manifest's Conversation session (manifest file durability across a real
    // host restart is covered by apps/cli/test/director-web-host.test.ts and the Linux-only E16-D lifecycle variant).
    expect((await next.inspect(runId)).delegation.sessionId).toBe(next.panes.manifest().conversationSessionId);
    expect((await next.inspect(runId)).status).toBe(before.status);
    expect(ok(await bridge.issues(PROJECT_ID)).items).toEqual(before.issues);
    expect(ok(await bridge.history(PROJECT_ID)).items).toEqual(before.transcript);
    // Director runs are not auto-resumed with no Director present after restart; the parked task stays parked.
    await next.endpoint.revoke();
    expect(await next.runtime.resumeRecoverableRuns()).toEqual({ resumed: 0 });
    const directorToken = (await next.endpoint.register({ provider: "claude" })).token;
    expect((ok(await next.ports.engine.getSnapshot(runId)) as any).tasks.find((task: any) => task.taskId === "implement").status).toBe("parked");

    // 10. Web retry: stale/foreign commands are refused before any effect; the current episode is retried exactly once.
    expect(await bridge.validateIssueCommand(issueCommand("issue_retry", parkedIssue, { expectedUpdatedAt: new Date(Date.parse(parkedIssue.updatedAt) - 1000).toISOString() }))).toBe("stale_version");
    expect(await bridge.validateIssueCommand(issueCommand("issue_retry", parkedIssue, { runId: "run-foreign" }))).toBe("forbidden");
    expect(await bridge.validateIssueCommand(issueCommand("issue_retry", parkedIssue, { projectId: "project-other" }))).toBe("forbidden");
    expect((await next.inspect(runId)).status).toBe("completed_with_parked");
    const retry = issueCommand("issue_retry", parkedIssue);
    expect(await bridge.validateIssueCommand(retry)).toBeUndefined();
    const historyBefore = await parkHistory(next, runId);
    expect(ok(await bridge.admitIssueCommand(retry))).toEqual({ kind: "issue", issueId: parkedIssue.issueId, status: "retrying" });
    // A replay of the same command (e.g. lost ACK before the receipt) is refused definitively: no second unpark.
    // (the issue's updatedAt moved with the retry, so the pinned version is stale before the status rule is even reached).
    expect(await bridge.admitIssueCommand(retry)).toMatchObject({ ok: false, error: { details: { reason: "stale_version" } } });
    expect(await bridge.reconcileIssueCommand(retry)).toEqual({ ok: true, value: { kind: "issue", issueId: parkedIssue.issueId, status: "retrying" } });
    // The stale episode (old updatedAt) cannot dismiss the issue now that it is retrying.
    expect(await bridge.validateIssueCommand(issueCommand("issue_dismiss", parkedIssue))).toBe("stale_version");
    await bridge.refresh();
    // Exactly one unpark: the episode moved to the task's park history once, and nothing is parked now.
    expect(await parkHistory(next, runId)).toBe(historyBefore + 1);
    expect((await next.inspect(runId)).tasks.find((task: any) => task.taskId === "implement").parked).toBeUndefined();

    // 11. The retried A, then B, verify independently; the delivery approval goes through the Web decision path.
    await next.runtime.tick();
    await next.evidence(runId); await next.submit(runId);
    for (let pass = 0; pass < 4 && !(await next.state()).outbound.some((out: any) => out.taskId === "after" && out.status === "accepted"); pass++) await next.tickWithReviewer();
    await next.evidence(runId, "after"); await next.submit(runId, "after", "after.md");
    for (let pass = 0; pass < 8 && !["completed", "awaiting_approval"].includes((await next.inspect(runId)).status); pass++) await next.tickWithReviewer();
    expect((await next.inspect(runId)).status).toBe("awaiting_approval");
    await webApproval(next, runId, restarted.authorized);
    await next.runtime.tick(); await next.runtime.flushOutbound();
    expect((await next.inspect(runId)).status).toBe("completed");
    expect((ok(await next.ports.engine.getSnapshot(runId)) as any).tasks.every((task: any) => task.status === "succeeded")).toBe(true);
    expect(ok(await bridge.view(PROJECT_ID)).snapshot.issues.filter(issue => issue.status === "open")).toEqual([]);
    expect(directorToken).toMatch(/\./);
    // No Herdr submission was addressed to the replaced Coordinator/Conversation roles, before or after the restart.
    for (const s of [session, next]) expect(s.transport.sentRequests.some(item => ["coordinator", "conversation"].includes(item.role))).toBe(false);
    expect(JSON.parse(await readFile(join(next.journalDirectory, "state.json"), "utf8")).version).toBe(8);
  }, 180_000);

  it("seeded stateful Web send/timeout/replay/not-ready/session-change sequence never duplicates a seq or loses a queued message", async () => {
    const { session } = await createWebDirectorSession();
    sessions.push(session);
    let ready = true, hostSession = HOST_CONVERSATION_SESSION;
    const panes = session.panes;
    const { bridge, feed } = directorWebBridge(session, { ready: () => ready });
    // Session change is modelled through the manifest the bridge reads (a new `up` with a new Conversation session).
    const originalManifest = panes.manifest.bind(panes);
    panes.manifest = () => ({ ...originalManifest(), conversationSessionId: hostSession });
    await bridge.refresh();
    const random = seeded(0x18d1ec7);
    /** Model: messageId → {seq, content} for every message the host stored. */
    const model = new Map<string, { seq: number; content: string }>();
    const pendingInClient: { messageId: string; content: string; sessionId: string }[] = [];
    let director: { token: string; cursor: string } | undefined;
    /** Durable ack: the message position of the last cursor the Director passed back to director_wait. */
    let durableAck = 0;
    const cursorSeq = (cursor: string) => Number(/^m(\d+)\./.exec(cursor)![1]);
    const ops = ["send", "send", "lost_ack", "replay", "conflict", "not_ready", "session_change", "director_open", "director_wait", "history"] as const;
    const trace: string[] = [];
    for (let step = 0; step < 120; step++) {
      const op = random.pick(ops); trace.push(op);
      if (op === "send" || op === "lost_ack") {
        const input = webSend(`tin ${step} ${random.int(1000)}`, { sessionId: hostSession });
        const result = await bridge.send(input);
        if (!ready) { expect(result).toMatchObject({ ok: false, error: { details: { reason: "unavailable" } } }); continue; }
        const message = ok(result); model.set(input.messageId, { seq: message.seq, content: input.content });
        // lost_ack: the host wrote it, the browser never saw the answer and keeps it pending for a same-ID resend.
        if (op === "lost_ack") pendingInClient.push({ messageId: input.messageId, content: input.content, sessionId: input.sessionId });
      } else if (op === "replay" && pendingInClient.length > 0) {
        const pending = pendingInClient.shift()!;
        const result = await bridge.send(webSend(pending.content, { messageId: pending.messageId, sessionId: pending.sessionId }));
        if (!ready) expect(result).toMatchObject({ ok: false, error: { details: { reason: "unavailable" } } });
        else if (pending.sessionId !== hostSession) expect(result).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
        else expect(ok(result).seq).toBe(model.get(pending.messageId)!.seq);
        if (!ready) pendingInClient.push(pending);
      } else if (op === "conflict" && model.size > 0 && ready) {
        const keys = [...model.keys()];
        // Same ID, other content, in the current session (a stale-session conflict is refused as forbidden first).
        const result = await bridge.send(webSend("nội dung khác", { messageId: keys[random.int(keys.length)]!, sessionId: hostSession }));
        expect(result).toMatchObject({ ok: false, error: { details: { reason: "stale_version" } } });
      } else if (op === "not_ready") ready = !ready;
      else if (op === "session_change") hostSession = hostSession === HOST_CONVERSATION_SESSION ? "session-2" : HOST_CONVERSATION_SESSION;
      else if (op === "director_open") {
        // A (re)opened Director starts at the durable ack: everything not proven delivered is replayed (at-least-once).
        director = await session.endpoint.register({ provider: "claude" });
        expect(cursorSeq(director.cursor)).toBe(durableAck);
      } else if (op === "director_wait" && director) {
        const from = cursorSeq(director.cursor);
        const waited = DirectorWaitResultSchema.parse(await session.endpoint.call(director.token, "director_wait", { cursor: director.cursor, timeoutMs: 20 }));
        durableAck = Math.max(durableAck, from);
        // Every user message after the cursor position is delivered (no loss), in seq order.
        const expected = [...model.values()].map(value => value.seq).filter(seq => seq > from).sort((a, b) => a - b).slice(0, 100);
        expect(waited.messages.map(message => message.seq)).toEqual(expected);
        director = { token: director.token, cursor: waited.cursor };
      } else if (op === "history") {
        // Paging with the private a/b cursors reconstructs the whole transcript; reads change nothing.
        const latest = ok(await bridge.history(PROJECT_ID));
        const items = [...latest.items];
        for (let cursor = items[0] ? `b${items[0].seq}` : undefined; cursor;) {
          const page = ok(await bridge.history(PROJECT_ID, cursor)); items.unshift(...page.items); cursor = page.nextCursor;
        }
        expect(ok(await bridge.history(PROJECT_ID, latest.nextCursor)).items).toEqual([]);
        expect(items.map(item => item.seq)).toEqual([...model.values()].map(value => value.seq).sort((a, b) => a - b));
      }
      // Invariants after every step: contiguous seqs, one seq per messageId, stored content unchanged.
      const transcript = await session.endpoint.transcript();
      expect(transcript.map(item => item.seq)).toEqual(transcript.map((_, index) => index + 1));
      expect(new Set(transcript.map(item => item.messageId)).size).toBe(transcript.length);
      for (const item of transcript) expect(model.get(item.messageId)).toEqual({ seq: item.seq, content: item.text });
    }
    await bridge.refresh();
    const chatIds = feed.filter(event => event.type === "chat").flatMap(event => event.resourceIds);
    expect(new Set(chatIds).size).toBe(chatIds.length);
    expect(new Set(chatIds)).toEqual(new Set(model.keys()));
    expect(trace.filter(op => op === "replay").length).toBeGreaterThan(0);
  }, 120_000);

  it("seeded stale issue episodes: retry/dismiss commands bound to an older updatedAt or another run never change the issue", async () => {
    const { session, authorized } = await createWebDirectorSession({ humanApproval: true, inspectRun: true });
    sessions.push(session);
    const { bridge } = directorWebBridge(session);
    /** Host admission order (interaction/commands.ts execute): validate (pre-receipt and again pre-effect), admit only if it passes. */
    const hostAdmit = async (command: ReturnType<typeof issueCommand>) => {
      const reason = await bridge.validateIssueCommand(command);
      return reason !== undefined ? { ok: false as const, reason } : bridge.admitIssueCommand(command);
    };
    const registered = await session.endpoint.register({ provider: "claude" });
    const noted = await session.endpoint.call(registered.token, "director_note_user_message", { text: "Cập nhật ba tệp" }) as { seq: number };
    const started = await session.endpoint.call(registered.token, "start_work", { title: "Ba tệp", objective: "Ba tệp phản ánh yêu cầu",
      acceptanceCriteria: [{ description: CRITERION, verificationMethod: "manual_review" }], sddLevel: "lightweight", userMessageSeq: noted.seq }) as { runId: string; correlationId: string };
    session.trackRun(started.runId, started.correlationId);
    const runId = started.runId;
    await session.endpoint.call(registered.token, "propose_workflow", { runId, ...threeTaskPlan(runId, (await session.inspect(runId)).delegation.specificationId) });
    // Human approval is required in this session: the design approval is pinned, then given through the Web decision path.
    expect((await session.inspect(runId)).status).toBe("awaiting_approval");
    await webApproval(session, runId, authorized);
    expect((await session.inspect(runId)).status).toBe("implementing");
    await session.runtime.tick();
    await stallAndAutoPark(session, runId);
    const current = ok(await bridge.issues(PROJECT_ID)).items[0]!;
    const random = seeded(0x51a1e);
    for (let step = 0; step < 40; step++) {
      const kind = random.pick(["issue_retry", "issue_dismiss"] as const);
      const shape = random.pick(["older", "newer", "foreign_run", "foreign_project"] as const);
      const at = Date.parse(current.updatedAt) + (shape === "newer" ? 1 + random.int(5000) : -1 - random.int(5000));
      // foreign_project keeps the current run and updatedAt: only the project differs.
      const command = issueCommand(kind, current, shape === "foreign_run" ? { runId: `run-${random.int(9)}` } : shape === "foreign_project" ? { projectId: "project-other" }
        : { expectedUpdatedAt: new Date(at).toISOString() });
      const expected = shape === "older" || shape === "newer" ? "stale_version" : "forbidden";
      expect(await bridge.validateIssueCommand(command)).toBe(expected);
      // Through the host admission order every shape is refused before any effect.
      expect(await hostAdmit(command)).toEqual({ ok: false, reason: expected });
      // The bridge effect step alone re-checks run identity and the pinned version (not the project: see report).
      if (shape !== "foreign_project") expect((await bridge.admitIssueCommand(command)).ok).toBe(false);
      expect(ok(await bridge.issues(PROJECT_ID)).items).toEqual([current]);
    }
    expect((ok(await session.ports.engine.getSnapshot(runId)) as any).tasks.find((task: any) => task.taskId === "implement").status).toBe("parked");

    // A real, existing run owned by another host session: after the host's Conversation session changes, the same run and issue
    // (current updatedAt) are foreign to the host and refused before any effect; a Web message bound to that run too.
    const original = session.panes.manifest.bind(session.panes);
    session.panes.manifest = () => ({ ...original(), conversationSessionId: "session-other" });
    try {
      expect((await session.inspect(runId)).delegation.sessionId).toBe(HOST_CONVERSATION_SESSION);
      for (const kind of ["issue_retry", "issue_dismiss"] as const) expect(await hostAdmit(issueCommand(kind, current))).toEqual({ ok: false, reason: "forbidden" });
      expect(await bridge.send(webSend("việc của phiên khác", { sessionId: "session-other", runId }))).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
      expect(ok(await bridge.issues(PROJECT_ID)).items).toEqual([current]);
    } finally { session.panes.manifest = original; }

    // Retrying-status rule with the CURRENT updatedAt: a retrying issue cannot be retried again (status rule, not a stale
    // version) and stays retrying; it can still be dismissed (Runtime rule: dismiss allowed for open or retrying).
    expect(ok(await hostAdmit(issueCommand("issue_retry", current)) as never)).toEqual({ kind: "issue", issueId: current.issueId, status: "retrying" });
    const retrying = ok(await bridge.issues(PROJECT_ID)).items[0]!;
    expect(retrying).toMatchObject({ issueId: current.issueId, status: "retrying" });
    expect(Date.parse(retrying.updatedAt)).toBeGreaterThan(Date.parse(current.updatedAt));
    const again = issueCommand("issue_retry", retrying);
    expect(await bridge.validateIssueCommand(again)).toBe("operation_not_allowed");
    expect(await bridge.admitIssueCommand(again)).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    expect(ok(await bridge.issues(PROJECT_ID)).items).toEqual([retrying]);
    const dismiss = issueCommand("issue_dismiss", retrying);
    expect(await bridge.validateIssueCommand(dismiss)).toBeUndefined();
    expect(ok(await hostAdmit(dismiss) as never)).toEqual({ kind: "issue", issueId: current.issueId, status: "dismissed" });
    expect(ok(await bridge.issues(PROJECT_ID)).items[0]).toMatchObject({ issueId: current.issueId, status: "dismissed" });
    // Closed: neither command is admitted any more.
    const closed = ok(await bridge.issues(PROJECT_ID)).items[0]!;
    for (const kind of ["issue_retry", "issue_dismiss"] as const) expect(await bridge.validateIssueCommand(issueCommand(kind, closed))).toBe("operation_not_allowed");
  }, 120_000);

  it("legacy v2 layout: the Director chat, transcript and issue commands are unavailable, never silently enabled", async () => {
    const session = await createDirectorSession();
    sessions.push(session);
    const { bridge } = directorWebBridge(session, { layout: () => "legacy_v2" });
    expect(await bridge.send(webSend("xin chào"))).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    expect(await bridge.history(PROJECT_ID)).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    expect(ok(await bridge.view(PROJECT_ID)).layout).toBe("legacy_v2");
    expect(await bridge.validateIssueCommand(issueCommand("issue_retry", { runId: "run-1", issueId: "park:run-1:implement:1", updatedAt: new Date().toISOString() })))
      .toBe("operation_not_allowed");
    expect(await session.endpoint.transcript()).toEqual([]);
  }, 60_000);
});
