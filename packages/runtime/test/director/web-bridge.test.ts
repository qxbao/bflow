import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WebCommandSchema, WebOperationSchema, type JsonValue, type WebCommand } from "@bflow/contracts";
import { DirectorEndpoint, DirectorWebBridge, isDirectorWebMethod, openLocalDirectorServices } from "../../src/director/index.js";
import { isDirectorCredential, parseDirectorCredentialCall } from "../../src/director/host-methods.js";
import { ProjectionFeed } from "../../src/interaction/events.js";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { HostStructuredCommands } from "../../src/interaction/commands.js";
import { fixture, now } from "../interaction/web-command-fixtures.js";

const dirs: string[] = [];
const bridges: DirectorWebBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

interface Task { taskId: string; parked?: { episode: number; source: "director" | "auto"; episodeKey?: string }; parkHistory?: { episode: number; source: "director" | "auto" }[] }
interface Run { runId: string; delegation: { sessionId: string; requestedBy: string }; tasks: Task[] }

type UnparkMode = "ok" | "throw_before" | "throw_after" | "throw_hidden";

async function setup(options: { layout?: "director" | "legacy_v2"; clock?: { at: number } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-web-")); dirs.push(root);
  const directory = path.join(root, "director");
  const feed = new ProjectionFeed("project-1");
  const runs: Run[] = [{ runId: "run-1", delegation: { sessionId: "conv-1", requestedBy: "director" },
    tasks: [{ taskId: "implement", parked: { episode: 1, source: "director" } }] }];
  let ready = true;
  let unparkMode: UnparkMode = "ok";
  const coordinatorCalls: { name: string; input: unknown }[] = [];
  const published: { type: string; resourceIds: string[] }[] = [];
  const now = options.clock ? () => new Date(options.clock!.at) : () => new Date();
  const unpark = (runId: string, taskId: string) => {
    const task = runs.find(run => run.runId === runId)?.tasks.find(item => item.taskId === taskId);
    if (!task?.parked) throw new Error("Task chưa được treo");
    task.parkHistory = [...(task.parkHistory ?? []), task.parked];
    delete task.parked;
  };
  const endpoint = new DirectorEndpoint({
    directory, repositoryRoot: root, feed, inspect: async () => ({ runs }), now,
    inspectRun: async runId => runs.find(run => run.runId === runId),
    coordinator: { invoke: async (name, input) => {
      coordinatorCalls.push({ name, input });
      if (name !== "unpark_task") return null;
      const args = input as { runId: string; taskId: string };
      if (unparkMode === "throw_before") throw new Error("Runtime refused unpark");
      unpark(args.runId, args.taskId);
      if (unparkMode === "throw_after") throw new Error("Lost acknowledgement after unpark");
      if (unparkMode === "throw_hidden") {
        // The acknowledgement is lost and the task is no longer observable: neither outcome can be proven.
        const run = runs.find(item => item.runId === args.runId)!;
        run.tasks = run.tasks.filter(task => task.taskId !== args.taskId);
        throw new Error("Lost acknowledgement");
      }
      return { unparked: true, runStatus: "implementing" } as JsonValue;
    } },
    maxWaitMs: 2000,
    pollMs: 20
  });
  const bridge = new DirectorWebBridge({
    endpoint, projectId: "project-1", layout: () => options.layout ?? "director", ready: () => ready,
    sessionId: () => (ready ? "conv-1" : undefined), inspect: async () => ({ runs }),
    runSession: async runId => runs.find(run => run.runId === runId)?.delegation.sessionId,
    feed: { publish: (type, ids) => { published.push({ type, resourceIds: ids }); return feed.publish(type, ids); } }, now
  });
  bridges.push(bridge);
  const send = (content: string, messageId: string = randomUUID(), extra: Record<string, unknown> = {}) =>
    bridge.callWeb("interaction_director_send", { apiVersion: 1, messageId, projectId: "project-1", sessionId: "conv-1", content, ...extra });
  return { root, directory, endpoint, bridge, feed, published, runs, coordinatorCalls, send, unpark,
    setReady: (value: boolean) => { ready = value; }, setUnpark: (mode: UnparkMode) => { unparkMode = mode; } };
}

function signedCommands(f: Awaited<ReturnType<typeof setup>>, root: string) {
  const signer = fixture();
  const authority = new WebInteractionAuthority("project-1", "host-1", () => now);
  authority.registerOwnerKey(signer.registration);
  const store = new WebOperationStore({ directory: path.join(root, "web-ops"), repository: "/repo", sessionId: "host-1", projectId: "project-1" });
  let conversation = 0;
  const service = new HostStructuredCommands({
    authority, store, ready: () => true, conversationSessionId: () => "conv-1",
    run: async () => { throw new Error("issue commands do not read run views"); },
    session: async () => { throw new Error("issue commands do not read session views"); },
    // The production host refuses here too; reaching Conversation's generic branch would treat the command as resume.
    admit: async () => { conversation++; throw new Error("Conversation must never admit issue commands"); },
    reconcile: async () => { conversation++; throw new Error("Conversation must never reconcile issue commands"); },
    issues: {
      validate: command => f.bridge.validateIssueCommand(command),
      admit: command => f.bridge.admitIssueCommand(command),
      reconcile: command => f.bridge.reconcileIssueCommand(command)
    }
  });
  const command = (kind: "issue_retry" | "issue_dismiss", issueId: string, expectedUpdatedAt: string, runId = "run-1"): WebCommand =>
    WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind, runId, issueId, expectedUpdatedAt });
  return { service, store, command, proof: (body: WebCommand) => signer.proof(body as never), conversation: () => conversation };
}

const unparks = (f: { coordinatorCalls: { name: string }[] }) => f.coordinatorCalls.filter(call => call.name === "unpark_task").length;

describe("Director Web bridge: chat", () => {
  it("Web send → director_wait → director_say → transcript read and SSE chat event", async () => {
    const f = await setup();
    const session = await f.endpoint.register({ provider: "claude" });
    await f.bridge.refresh();
    const first = (await f.endpoint.call(session.token, "director_wait", { cursor: session.cursor, timeoutMs: 1 })) as { cursor: string };
    const pending = f.endpoint.call(session.token, "director_wait", { cursor: first.cursor, timeoutMs: 2000 }) as Promise<unknown>;
    await new Promise(resolve => setTimeout(resolve, 50));
    const sent = await f.send("Làm giúp tính năng báo cáo");
    expect(sent).toMatchObject({ ok: true, value: { author: "user", channel: "web", seq: 1 } });
    const woken = (await pending) as { cursor: string; messages: { text: string; channel: string; author: string }[]; runtimeEvents: unknown[] };
    expect(woken.messages).toEqual([expect.objectContaining({ text: "Làm giúp tính năng báo cáo", channel: "web", author: "user" })]);
    const said = (await f.endpoint.call(session.token, "director_say", { text: "Đã nhận, tôi sẽ lập kế hoạch." })) as { messageId: string };
    await f.bridge.refresh();
    const events = f.published;
    expect(events.filter(event => event.type === "chat").flatMap(event => event.resourceIds)).toContain(said.messageId);
    const history = await f.bridge.callWeb("interaction_director_history", { projectId: "project-1" });
    expect(history).toMatchObject({ ok: true, value: { items: [
      { author: "user", channel: "web", text: "Làm giúp tính năng báo cáo" },
      { author: "director", channel: "cli", text: "Đã nhận, tôi sẽ lập kế hoạch." }], nextCursor: "a2" } });
    // The Director's own refresh signals (chat / director invalidate) never wake director_wait as Runtime events.
    const quiet = (await f.endpoint.call(session.token, "director_wait", { cursor: woken.cursor, timeoutMs: 300 })) as { timedOut: boolean; runtimeEvents: unknown[] };
    expect(quiet).toMatchObject({ timedOut: true, runtimeEvents: [] });
  });

  it("is idempotent per messageId and reports a conflict for a different payload", async () => {
    const f = await setup();
    const id = randomUUID();
    const a = await f.send("một", id), b = await f.send("một", id);
    expect(b).toEqual(a);
    expect(await f.send("hai", id)).toMatchObject({ ok: false, error: { code: "conflict", details: { reason: "stale_version" } } });
    expect((await f.endpoint.transcript()).length).toBe(1);
  });

  it("queues while the Director is absent but refuses while infrastructure is not ready, without writing", async () => {
    const f = await setup();
    expect(await f.endpoint.presence()).toBe("absent");
    expect(await f.send("Director vắng vẫn nhận")).toMatchObject({ ok: true });
    f.setReady(false);
    expect(await f.send("Host chưa sẵn sàng")).toMatchObject({ ok: false, error: { code: "transport_unavailable", details: { reason: "unavailable" } } });
    expect((await f.endpoint.transcript()).map(m => m.text)).toEqual(["Director vắng vẫn nhận"]);
    // Reads still work through the host; the view reports not_started.
    expect(await f.bridge.view("project-1")).toMatchObject({ ok: true, value: { layout: "not_started", transcriptSeq: 1 } });
  });

  it("refuses legacy layouts, foreign project/session/run and malformed bodies", async () => {
    const legacy = await setup({ layout: "legacy_v2" });
    expect(await legacy.send("x")).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    expect(await legacy.bridge.history("project-1")).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    const f = await setup();
    expect(await f.send("x", randomUUID(), { projectId: "project-2" })).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
    expect(await f.send("x", randomUUID(), { sessionId: "conv-old" })).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
    expect(await f.send("x", randomUUID(), { runId: "run-foreign" })).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
    expect(await f.send("x", randomUUID(), { runId: "run-1" })).toMatchObject({ ok: true, value: { runId: "run-1" } });
    expect(await f.bridge.callWeb("interaction_director_send", { content: "x" })).toMatchObject({ ok: false, error: { details: { reason: "invalid_request" } } });
    expect(await f.bridge.callWeb("interaction_director_history", { projectId: "project-1", cursor: "x1" })).toMatchObject({ ok: false });
    expect(await f.bridge.history("project-2")).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
  });

  it("pages the transcript with after/before cursors", async () => {
    const f = await setup();
    for (let index = 1; index <= 105; index += 1) await f.endpoint.appendWebMessage({ messageId: randomUUID(), text: `m${index}` });
    const latest = await f.bridge.history("project-1");
    if (!latest.ok) throw new Error("history failed");
    expect(latest.value.items.map(m => m.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 6));
    expect(latest.value.nextCursor).toBe("a105");
    const older = await f.bridge.history("project-1", "b6");
    expect(older.ok && older.value.items.map(m => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(older.ok && older.value.nextCursor).toBeUndefined();
    const newer = await f.bridge.history("project-1", "a103");
    expect(newer.ok && newer.value.items.map(m => m.seq)).toEqual([104, 105]);
  });
});

describe("Director Web bridge: redaction and view", () => {
  it("redacts secrets and Director-token shapes in transcript, issues and view; exposes no session metadata", async () => {
    const f = await setup();
    const session = await f.endpoint.register({ provider: "claude" });
    const secret = "sk-ant-api03-" + "A".repeat(40);
    await f.endpoint.call(session.token, "director_say", { text: `token ${session.token} và khóa ${secret}` });
    await f.endpoint.upsertIssue({ issueId: "park:run-1:implement:1", runId: "run-1", taskKey: "implement", kind: "other", summary: `lỗi với ${secret}` });
    const history = JSON.stringify(await f.bridge.history("project-1"));
    const issues = JSON.stringify(await f.bridge.issues("project-1"));
    const view = await f.bridge.view("project-1");
    for (const text of [history, issues, JSON.stringify(view)]) {
      expect(text).not.toContain(session.token);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(f.root);
      expect(text).not.toContain(session.session.tokenId);
      expect(text).not.toContain(session.session.directorId);
    }
    expect(history).toContain("[REDACTED]");
    expect(issues).toContain("[REDACTED]");
    expect(view).toMatchObject({ ok: true, value: { layout: "director", sessionId: "conv-1", transcriptSeq: 1, cliCaptureMayBeIncomplete: true,
      snapshot: { director: { presence: "active", provider: "claude" } } } });
  });

  it("caps redacted text at the UTF-8 message limit", async () => {
    const f = await setup();
    await f.endpoint.appendWebMessage({ messageId: randomUUID(), text: "ệ".repeat(5461) });
    const page = await f.bridge.history("project-1");
    if (!page.ok) throw new Error("history failed");
    expect(new TextEncoder().encode(page.value.items[0]!.text).byteLength).toBeLessThanOrEqual(16384);
  });

  it("reports CLI capture as complete only after this host bound the Director hook session", async () => {
    const f = await setup();
    await f.endpoint.noteHookPrompt({ provider: "claude", prompt: "/bflow-start", sessionId: "native-1" });
    await f.endpoint.register({ provider: "claude" });
    expect(await f.bridge.view("project-1")).toMatchObject({ ok: true, value: { cliCaptureMayBeIncomplete: false } });
    await f.endpoint.register({ provider: "codex" });
    expect(await f.bridge.view("project-1")).toMatchObject({ ok: true, value: { cliCaptureMayBeIncomplete: true } });
  });

  it("publishes invalidate when presence goes stale on a clock-driven poll, not on every heartbeat", async () => {
    const clock = { at: Date.parse("2026-11-04T10:00:00.000Z") };
    const f = await setup({ clock });
    const session = await f.endpoint.register({ provider: "claude" });
    await f.bridge.refresh();
    clock.at += 30_000;
    await f.endpoint.call(session.token, "list_issues", {});
    await f.bridge.refresh();
    expect(f.published.filter(event => event.type === "invalidate")).toEqual([]);
    clock.at += 121_000;
    await f.bridge.refresh();
    expect(f.published.filter(event => event.type === "invalidate").map(event => event.resourceIds)).toEqual([["director"]]);
    expect(await f.bridge.view("project-1")).toMatchObject({ ok: true, value: { snapshot: { director: { presence: "absent" } } } });
  });

  it("refreshes the feed from store changes without any browser poll", async () => {
    const f = await setup();
    f.bridge.start(10_000);
    await new Promise(resolve => setTimeout(resolve, 30));
    const message = await f.endpoint.appendWebMessage({ messageId: randomUUID(), text: "không cần trình duyệt" });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(f.published.filter(event => event.type === "chat").flatMap(event => event.resourceIds)).toEqual([message.messageId]);
  });
});

describe("Director Web bridge: credential separation", () => {
  it("keeps Web, Director and owner authority apart; chat never reaches decision or Runtime tools", async () => {
    expect(() => parseDirectorCredentialCall("interaction_director_send", {})).toThrow("Director credentials can only call director tools");
    expect(() => parseDirectorCredentialCall("interaction_director_history", {})).toThrow("Director credentials can only call director tools");
    expect(isDirectorWebMethod("interaction_director_send")).toBe(true);
    expect(isDirectorWebMethod("director_call")).toBe(false);
    expect(isDirectorWebMethod("director_issue_status")).toBe(false);
    expect(isDirectorWebMethod("interaction_query")).toBe(false);
    const f = await setup();
    const session = await f.endpoint.register({ provider: "claude" });
    expect(isDirectorCredential(session.token, "f".repeat(64))).toBe(true);
    await expect(f.bridge.callWeb("director_call", { name: "start_work" })).rejects.toThrow("cannot call owner or role methods");
    await expect(f.bridge.callWeb("director_issue_status", { issueId: "x", status: "dismissed" })).rejects.toThrow("cannot call owner or role methods");
    await expect(f.bridge.callWeb("human_decision_cli", {})).rejects.toThrow("cannot call owner or role methods");
    expect(await f.send("duyệt #1")).toMatchObject({ ok: true, value: { channel: "web", author: "user" } });
    expect(await f.send("approve all")).toMatchObject({ ok: true });
    expect(f.coordinatorCalls).toEqual([]);
    expect(await f.endpoint.listIssues()).toEqual([]);
  });
});

describe("Director Web bridge: issue commands", () => {
  const issueId = "park:run-1:implement:1";

  it("admits retry through the issue port only, unparks once and replays the durable receipt", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    const command = c.command("issue_retry", issueId, issue.updatedAt);
    const first = await c.service.execute(command, c.proof(command));
    expect(first).toMatchObject({ ok: true, value: { state: "applied", operationKind: "issue_retry", result: { kind: "issue", issueId, status: "retrying" } } });
    expect(WebOperationSchema.safeParse(first.ok && first.value).success).toBe(true);
    expect(await c.service.execute(command, c.proof(command))).toEqual(first);
    expect(unparks(f)).toBe(1);
    expect(c.conversation()).toBe(0);
    // A repeated retry (Director tool / CLI path) never unparks twice nor resets the issue to open; the issue is unchanged.
    const retrying = await f.endpoint.inspectIssue(issueId);
    expect(await f.endpoint.setIssueStatus(issueId, "retrying")).toEqual(retrying);
    expect(unparks(f)).toBe(1);
    // A new command with the old expectedUpdatedAt is stale before any receipt.
    const stale = c.command("issue_retry", issueId, issue.updatedAt);
    expect(await c.service.execute(stale, c.proof(stale))).toMatchObject({ ok: false, error: { code: "conflict", details: { reason: "stale_version" } } });
    expect(await c.store.read("local-user-1", stale.commandId)).toBeUndefined();
    expect(unparks(f)).toBe(1);
  });

  it("refuses a retry for an older park episode or a foreign run before any receipt or effect", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const old = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "lần 1" });
    // Runtime reopened episode 1 and parked the task again (episode 2): the old issue must not unpark episode 2.
    f.runs[0]!.tasks[0] = { taskId: "implement", parkHistory: [{ episode: 1, source: "director" }], parked: { episode: 2, source: "director" } };
    const command = c.command("issue_retry", issueId, old.updatedAt);
    expect(await c.service.execute(command, c.proof(command))).toMatchObject({ ok: false, error: { details: { reason: "stale_version" } } });
    const foreign = c.command("issue_retry", issueId, old.updatedAt, "run-foreign");
    expect(await c.service.execute(foreign, c.proof(foreign))).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
    expect(await c.store.read("local-user-1", command.commandId)).toBeUndefined();
    expect(unparks(f)).toBe(0);
    expect((await f.endpoint.inspectIssue(issueId)).status).toBe("open");
  });

  it("dismisses without Runtime effect and refuses dismissing a closed issue", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    const command = c.command("issue_dismiss", issueId, issue.updatedAt);
    const result = await c.service.execute(command, c.proof(command));
    expect(result).toMatchObject({ ok: true, value: { state: "applied", result: { kind: "issue", status: "dismissed" } } });
    const dismissed = await f.endpoint.inspectIssue(issueId);
    const again = c.command("issue_dismiss", issueId, dismissed.updatedAt);
    expect(await c.service.execute(again, c.proof(again))).toMatchObject({ ok: false, error: { details: { reason: "operation_not_allowed" } } });
    expect(f.coordinatorCalls).toEqual([]);
    expect(c.conversation()).toBe(0);
  });

  it("classifies an error after the effect by observation and never resends the unpark", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    f.setUnpark("throw_after");
    const command = c.command("issue_retry", issueId, issue.updatedAt);
    expect(await c.service.execute(command, c.proof(command))).toMatchObject({ ok: true, value: { state: "applied", result: { status: "retrying" } } });
    expect(unparks(f)).toBe(1);
  });

  it("settles a definitive Runtime refusal as failed while the task is still parked", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    f.setUnpark("throw_before");
    const command = c.command("issue_retry", issueId, issue.updatedAt);
    expect(await c.service.execute(command, c.proof(command))).toMatchObject({ ok: true, value: { state: "failed", error: { code: "operation_not_allowed" } } });
    expect((await f.endpoint.inspectIssue(issueId)).status).toBe("open");
  });

  it("keeps an unprovable outcome reconciliation_required and only observes on reread", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    f.setUnpark("throw_hidden");
    const command = c.command("issue_retry", issueId, issue.updatedAt);
    expect(await c.service.execute(command, c.proof(command))).toMatchObject({ ok: true, value: { state: "reconciliation_required" } });
    expect(await c.service.readOperation("local-user-1", command.commandId)).toMatchObject({ ok: true, value: { state: "reconciliation_required" } });
    expect(unparks(f)).toBe(1);
    expect(c.conversation()).toBe(0);
    expect((await f.endpoint.inspectIssue(issueId)).status).toBe("open");
  });

  it("reconcile of an unparked retry never resurrects a concurrently dismissed issue", async () => {
    const f = await setup();
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    // Runtime already reopened this episode (the retry effect happened) but the local status record is still open.
    f.runs[0]!.tasks[0] = { taskId: "implement", parkHistory: [{ episode: 1, source: "director" }] };
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "issue_retry",
      runId: "run-1", issueId, expectedUpdatedAt: issue.updatedAt });
    // The reconcile observation is queued first; a dismiss lands in the issue serial before reconcile's status write.
    const reconciled = f.bridge.reconcileIssueCommand(command);
    const dismissed = f.endpoint.setIssueStatus(issueId, "dismissed");
    const [outcome] = await Promise.all([reconciled, dismissed]);
    expect((await f.endpoint.inspectIssue(issueId)).status).toBe("dismissed");
    expect(outcome === undefined || !outcome.ok || outcome.value.kind !== "issue" || outcome.value.status !== "retrying").toBe(true);
    expect(unparks(f)).toBe(0);
  });

  it("reconcile of an unparked retry still records retrying when nothing changed concurrently", async () => {
    const f = await setup();
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    f.runs[0]!.tasks[0] = { taskId: "implement", parkHistory: [{ episode: 1, source: "director" }] };
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "issue_retry",
      runId: "run-1", issueId, expectedUpdatedAt: issue.updatedAt });
    expect(await f.bridge.reconcileIssueCommand(command)).toMatchObject({ ok: true, value: { kind: "issue", status: "retrying" } });
    expect(unparks(f)).toBe(0);
  });

  it("reconcile of an unparked retry reports applied when retrying was recorded concurrently", async () => {
    const f = await setup();
    const issue = await f.endpoint.upsertIssue({ issueId, runId: "run-1", taskKey: "implement", kind: "other", summary: "Treo" });
    f.runs[0]!.tasks[0] = { taskId: "implement", parkHistory: [{ episode: 1, source: "director" }] };
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "issue_retry",
      runId: "run-1", issueId, expectedUpdatedAt: issue.updatedAt });
    const reconciled = f.bridge.reconcileIssueCommand(command);
    const recorded = f.endpoint.setIssueStatus(issueId, "retrying");
    const [outcome] = await Promise.all([reconciled, recorded]);
    expect(outcome).toMatchObject({ ok: true, value: { kind: "issue", status: "retrying" } });
    expect(unparks(f)).toBe(0);
  });

  it("refuses an issue command whose run belongs to another host session before any receipt or effect", async () => {
    const f = await setup();
    const c = signedCommands(f, f.root);
    f.runs.push({ runId: "run-2", delegation: { sessionId: "conv-other", requestedBy: "director" },
      tasks: [{ taskId: "implement", parked: { episode: 1, source: "director" } }] });
    const foreignIssue = "park:run-2:implement:1";
    const issue = await f.endpoint.upsertIssue({ issueId: foreignIssue, runId: "run-2", taskKey: "implement", kind: "other", summary: "Treo" });
    for (const kind of ["issue_retry", "issue_dismiss"] as const) {
      const command = c.command(kind, foreignIssue, issue.updatedAt, "run-2");
      expect(await c.service.execute(command, c.proof(command))).toMatchObject({ ok: false, error: { details: { reason: "forbidden" } } });
      expect(await c.store.read("local-user-1", command.commandId)).toBeUndefined();
    }
    expect(unparks(f)).toBe(0);
    expect((await f.endpoint.inspectIssue(foreignIssue)).status).toBe("open");
  });
});

describe("LocalDirectorServices adapter", () => {
  it("reports an absent host as unavailable and a send as not written", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "director-nohost-")); dirs.push(repo);
    const services = await openLocalDirectorServices({ repositoryPath: repo, sessionId: "session-1", interaction: { credential: "c".repeat(64) } });
    const { interactionProjectId } = await import("../../src/interaction/client.js");
    const projectId = interactionProjectId(await fs.realpath(repo));
    expect(await services.readDirector(projectId)).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    expect(await services.listDirectorIssues(projectId)).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    const messageId = randomUUID();
    expect(await services.sendDirectorMessage({ apiVersion: 1, messageId, projectId, sessionId: "conv-1", content: "xin chào" }))
      .toMatchObject({ ok: false, error: { code: "transport_unavailable", details: { messageId } } });
    expect(await services.readDirector("project-other")).toMatchObject({ ok: false, error: { code: "validation" } });
    const readOnly = await openLocalDirectorServices({ repositoryPath: repo, sessionId: "session-1" });
    expect(await readOnly.sendDirectorMessage({ apiVersion: 1, messageId, projectId, sessionId: "conv-1", content: "x" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await readOnly.listDirectorMessages(projectId)).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
