import { expect, it } from "vitest";
import { WebAgentTranscriptSchema, WebWorkforceExcerptsSchema, type SessionManifest } from "@bflow/contracts";
import { cleanTerminalText, excerptOf, readAgentTranscript, readWorkforceExcerpts, type TranscriptSources } from "../../src/interaction/transcript.js";
import { instanceIdOf, projectWorkforce } from "../../src/interaction/workforce.js";
import type { JournalState, Outbound } from "../../src/agentic/journal.js";
import { run, state, at } from "./fixtures.js";

const now = "2026-11-02T00:00:00.000Z";
type Pane = SessionManifest["panes"][number];
const pane = (role: string, n: string, extra: Record<string, unknown> = {}): Pane => ({
  schemaVersion: 2, bindingId: `binding-${n}`, sessionId: "host-1", role, agentId: `agent-id-${n}`,
  workspaceId: "ws-private", tabId: "tab-private", paneId: `pane-private-${n}`, provider: "claude", agentKind: "claude",
  cwd: "/home/secret/cwd-private", worktreePath: "/home/secret/worktree-private", isolationMode: "dedicated_pane",
  readOnlyWorkspace: false, transportState: "idle", boundAt: at, session: { kind: "claude", value: "native-session-secret" },
  metadata: { allocationStatus: "active" }, ...extra,
}) as unknown as Pane;
const manifestOf = (panes: Pane[]): SessionManifest => ({
  schemaVersion: 2, sessionId: "host-1", projectName: "P", workspaceRoot: "/repo", herdrWorkspaceId: "w", herdrTabId: "t",
  status: "up", conversationSessionId: "conversation-1", activeRunIds: [], panes, attachTarget: { role: "conversation", paneId: "p" },
  createdAt: at, updatedAt: at,
}) as unknown as SessionManifest;
const redact = (text: string) => text.replace(/tok-[A-Za-z0-9]+/g, "[redacted]").replace(/\/(?:[^\s/]+\/)+[^\s]*/gi, "[redacted]");
const sources = (panes: Pane[], readPane: TranscriptSources["readPane"], journal: Partial<JournalState> = {}): TranscriptSources => ({
  manifest: manifestOf(panes), state: { ...state([run()]), ...journal }, sessionId: "conversation-1", projectId: "project-test",
  observedAt: now, redact, readPane,
});
const assignment = (agentId: string): Outbound => ({
  message: { schema_version: 2, message_id: "msg-1", correlation_id: "corr", run_id: "run-1", sender: { role: "coordinator", agent_id: "agent-id-coord" },
    recipient: { role: "developer", agent_id: agentId }, type: "task.assignment", payload: {}, artifact_references: [] },
  status: "accepted", selector: "sel", taskId: "task-1", attemptId: "attempt-1", capabilities: [],
  handle: { executionId: "e", requestId: "r", attemptId: "attempt-1", runId: "run-1", taskId: "task-1", idempotencyKey: "k",
    target: { transport: "herdr", agentId, paneId: "pane-private-x" }, correlation: { token: "t", provenance: "transport", verified: true }, acceptedAt: at },
}) as unknown as Outbound;

const CLAUDE = [
  "\u001b[1m● Updated src/app.ts\u001b[0m", "  Wrote 14 lines", "", "╭────────────────────────────────────╮",
  "│ > Try \"fix the failing test\"        │", "╰────────────────────────────────────╯",
  "  ⏵⏵ accept edits on (shift+tab to cycle)", "  ? for shortcuts", "  esc to interrupt",
].join("\n");
const CODEX = ["• Ran pnpm test", "  all green", "", "› Ask Codex to do anything", "", "  gpt-5 high · 87% context left · ~/work/repo", "  ctrl+c to exit"].join("\n");

it("cleans ANSI, control sequences and trailing spaces but keeps line breaks", () => {
  expect(cleanTerminalText("\u001b[31mred\u001b[0m   \r\nnext\u001b]0;title\u0007\u0007line\u0000\n")).toBe("red\nnextline\n");
});
it("filters Claude Code chrome from an excerpt", () => {
  expect(excerptOf(cleanTerminalText(CLAUDE))).toBe("● Updated src/app.ts\nWrote 14 lines");
});
it("filters Codex chrome from an excerpt", () => {
  expect(excerptOf(cleanTerminalText(CODEX))).toBe("• Ran pnpm test\nall green");
});
it("keeps only the last four meaningful lines and cuts to 600 characters keeping the tail", () => {
  expect(excerptOf("a\nb\nc\nd\ne\nf")).toBe("c\nd\ne\nf");
  const long = excerptOf("x".repeat(900) + "END")!;
  expect(long).toHaveLength(600);
  expect(long.endsWith("END")).toBe(true);
  const emoji = excerptOf("𝒜".repeat(400))!;
  expect(emoji.length).toBeLessThanOrEqual(600);
  expect(emoji.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
});
it("yields undefined when nothing is meaningful", () => {
  expect(excerptOf("\n───────\n> \n❯\n? for shortcuts\n")).toBeUndefined();
});

it("excerpts cover working panes, open work and the Conversation pane only, redacted", async () => {
  const panes = [pane("conversation", "conv", { permanent: true }), pane("coordinator", "coord", { permanent: true }),
    pane("developer", "a"), pane("developer", "b", { transportState: "working" }), pane("developer", "c")];
  const reads: string[] = [];
  const result = await readWorkforceExcerpts(sources(panes, async (paneId, lines) => {
    reads.push(`${paneId}:${lines}`);
    return `finished with tok-SECRET1 in /home/user/project/file.ts`;
  }, { outbound: [assignment("agent-id-a")] }));
  const value = WebWorkforceExcerptsSchema.parse(result.value);
  expect(reads.sort()).toEqual(["pane-private-a:60", "pane-private-b:60", "pane-private-conv:60"]);
  expect(value.items.map(i => i.instanceId).sort()).toEqual(["a", "b", "conv"].map(n => instanceIdOf(`binding-${n}`)).sort());
  const blob = JSON.stringify(value);
  expect(blob).not.toContain("tok-SECRET1");
  expect(blob).not.toContain("/home/user");
  expect(blob).not.toContain("pane-private");
  expect(value.items[0]!.text).toContain("[redacted]");
});
it("a failing pane read is omitted and never fails the page", async () => {
  const panes = [pane("conversation", "conv", { permanent: true }), pane("developer", "b", { transportState: "working" })];
  const result = await readWorkforceExcerpts(sources(panes, async paneId => {
    if (paneId.endsWith("b")) throw new Error("herdr exploded at /home/secret");
    return "hello there";
  }));
  expect(result.value.items.map(i => i.text)).toEqual(["hello there"]);
});
it("bounds concurrent pane reads to four", async () => {
  const panes = [pane("conversation", "conv", { permanent: true }),
    ...Array.from({ length: 9 }, (_, i) => pane("developer", String(i), { transportState: "working" }))];
  let live = 0, peak = 0;
  const result = await readWorkforceExcerpts(sources(panes, async () => {
    peak = Math.max(peak, ++live);
    await new Promise(resolve => setTimeout(resolve, 5));
    live--;
    return "work";
  }));
  expect(peak).toBe(4);
  expect(result.value.items).toHaveLength(10);
});
it("excerpt ids match the workforce projection", async () => {
  const panes = [pane("conversation", "conv", { permanent: true })];
  const view = projectWorkforce({ ...sources(panes, async () => ""), core: new Map(), ready: true });
  const result = await readWorkforceExcerpts(sources(panes, async () => "hi"));
  expect(result.value.items[0]!.instanceId).toBe(view.agents[0]!.instanceId);
});

it("transcript reads 400 lines, redacts and keeps the tail when truncated", async () => {
  const panes = [pane("developer", "a")];
  let lines = 0;
  const raw = "x".repeat(70000) + "\nauth tok-ABC123 /Users/x/y/z\nTAIL";
  const result = await readAgentTranscript(sources(panes, async (_id, n) => { lines = n; return raw; }), instanceIdOf("binding-a"));
  expect(lines).toBe(400);
  expect(result.ok).toBe(true);
  const value = WebAgentTranscriptSchema.parse((result as { value: unknown }).value);
  expect(value.truncated).toBe(true);
  expect(value.text).toHaveLength(64000);
  expect(value.text.endsWith("TAIL")).toBe(true);
  expect(value.text).not.toContain("tok-ABC123");
  expect(value.text).not.toContain("/Users/x");
  expect(value.source).toBe("terminal_snapshot");
});
it("unknown instance id is not_found and a released-too-long pane is not listed", async () => {
  const old = pane("developer", "old", { metadata: { allocationStatus: "released", releasedAt: "2026-11-01T00:00:00.000Z" } });
  const s = sources([pane("developer", "a"), old], async () => "x");
  for (const id of ["agent-unknown", instanceIdOf("binding-old")]) {
    const result = await readAgentTranscript(s, id);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
  }
});
it("a read failure returns a safe unavailable error without the raw message", async () => {
  const result = await readAgentTranscript(sources([pane("developer", "a", { metadata: { allocationStatus: "released" } })],
    async () => { throw new Error("pane pane-private-a gone at /home/secret"); }), instanceIdOf("binding-a"));
  expect(result).toMatchObject({ ok: false, error: { code: "transport_unavailable", retryable: true } });
  expect(JSON.stringify(result)).not.toMatch(/secret|pane-private/);
});

it("hostInteractionQuery answers unsupported without a pane reader and serves both kinds with one", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { hostInteractionQuery } = await import("../../src/interaction/views.js");
  const { interactionProjectId } = await import("../../src/interaction/client.js");
  const repositoryPath = await mkdtemp(join(tmpdir(), "web-transcript-"));
  try {
    const manifestDirectory = join(repositoryPath, "m"), directory = join(repositoryPath, "a/b/c");
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, "host-1.manifest.json"),
      JSON.stringify({ ...manifestOf([{ schemaVersion: 2, bindingId: "binding-conv", sessionId: "host-1", role: "conversation", agentId: "agent-id-conv",
        workspaceId: "w", tabId: "t", paneId: "pane-private-conv", provider: "claude", agentKind: "claude", cwd: repositoryPath,
        isolationMode: "dedicated_pane", readOnlyWorkspace: true, transportState: "idle", boundAt: at, permanent: true } as unknown as Pane,
      { schemaVersion: 2, bindingId: "binding-coord", sessionId: "host-1", role: "coordinator", agentId: "agent-id-coord",
        workspaceId: "w", tabId: "t", paneId: "pane-private-coord", provider: "claude", agentKind: "claude", cwd: repositoryPath,
        isolationMode: "dedicated_pane", readOnlyWorkspace: true, transportState: "idle", boundAt: at, permanent: true } as unknown as Pane]),
      workspaceRoot: repositoryPath, attachTarget: { role: "conversation", paneId: "pane-private-conv" } }));
    const configuration = { repositoryPath, sessionId: "host-1", directory, manifestDirectory } as never;
    const projectId = await interactionProjectId(repositoryPath);
    const id = instanceIdOf("binding-conv");
    for (const q of [{ kind: "workforce_excerpts", projectId }, { kind: "agent_transcript", projectId, instanceId: id }])
      expect(await hostInteractionQuery(configuration, q, { ready: true })).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    const readPane = async () => "hello\n> typed";
    const excerpts = await hostInteractionQuery(configuration, { kind: "workforce_excerpts", projectId }, { ready: true, readPane }) as never as { value: { items: { text: string }[] } };
    expect(excerpts.value.items.map(i => i.text)).toEqual(["hello"]);
    const transcript = await hostInteractionQuery(configuration, { kind: "agent_transcript", projectId, instanceId: id }, { ready: true, readPane }) as never as { value: { text: string } };
    expect(transcript.value.text).toBe("hello\n> typed");
  } finally { await rm(repositoryPath, { recursive: true, force: true }); }
});
