import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import {
  DIRECTOR_LIMITS, DirectorMessageSchema, DirectorPresenceSchema, DirectorProgressSnapshotSchema, ParkedIssueSchema,
  WebCommandKindSchema, WebCommandSchema, WebDirectorLaunchOptionSchema, WebDirectorLaunchOptionsSchema,
  WebDirectorLaunchRequestSchema, WebDirectorViewSchema, WebHttpContracts, WebIssueQueueViewSchema, WebOperationKindSchema,
  WebOperationSchema, WebActionSchema, WebEventSchema
} from "../src/web.js";
import { WebInteractionReceiptSchema, WebOperationIndexRecordSchema, canonicalWebJson, webCommandFingerprint } from "../src/web-host.js";

const now = "2026-11-04T10:00:00.000Z";
const later = "2026-11-04T10:00:30.000Z";
const projectId = "fixture-project";
const commandId = "00000000-0000-4000-8000-0000000000c1";
const vectors = JSON.parse(readFileSync(new URL("./fixtures/local-web/command-vectors.json", import.meta.url), "utf8"));
const bundle = JSON.parse(readFileSync(new URL("./fixtures/local-web/approval-bundle.json", import.meta.url), "utf8"));

const message = { schemaVersion: 1, seq: 1, messageId: "msg-1", author: "user", channel: "web", text: "Làm trang todo 🚀", at: now };
const issue = { schemaVersion: 1, issueId: "issue-1", runId: "run-1", kind: "verification_exhausted", status: "open",
  summary: "Verification exhausted", attempts: 3, evidence: ["artifact://sha256/abc"], createdAt: now, updatedAt: now };
const snapshot = { schemaVersion: 1, generatedAt: now, director: { presence: "waiting", provider: "claude", heartbeatAt: now },
  runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [issue] };
const view = { apiVersion: 1, projectId, layout: "director", sessionId: "host-session", snapshot, waitingSince: now,
  transcriptSeq: 3, cliCaptureMayBeIncomplete: false, observedAt: now };
const retry = { apiVersion: 1, commandId, projectId, kind: "issue_retry", runId: "run-1", issueId: "issue-1", expectedUpdatedAt: now };
const dismiss = { ...retry, kind: "issue_dismiss" };
const launchRequest = { apiVersion: 1, operationId: commandId, provider: "codex" };
const launchResult = { kind: "director_launch", provider: "codex", mode: "manual_command", manualCommand: "codex '$bflow-start'", launchedAt: now };
const session = { apiVersion: 1, projectId, sessionId: "s", state: "ready", pendingIntakes: [], blockers: [], updatedAt: now };
const operation = (patch: Record<string, unknown>) => ({ apiVersion: 1, operationId: commandId, projectId, state: "applied", updatedAt: now, ...patch });

function withoutBuffer<T>(fn: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  // Simulates the browser: no Node Buffer global during parse.
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe("undefined");
    return fn();
  } finally { if (saved) Object.defineProperty(globalThis, "Buffer", saved); }
}

describe("D-CD-01 portable Director message byte limit", () => {
  afterEach(() => expect(typeof Buffer).toBe("function"));

  it("parses valid Vietnamese/emoji messages without a Buffer global", () => {
    withoutBuffer(() => {
      expect(DirectorMessageSchema.parse(message)).toEqual(message);
      expect(root.DirectorMessageSchema.safeParse(message).success).toBe(true);
    });
  });

  it("counts UTF-8 bytes at the 16384 boundary for ASCII, Vietnamese, emoji and lone surrogates", () => {
    const limit = DIRECTOR_LIMITS.messageBytes;
    expect(limit).toBe(16384);
    const cases: Array<[string, boolean]> = [
      ["a".repeat(limit), true],
      ["a".repeat(limit + 1), false],
      // "ệ" (U+1EC7) is 3 UTF-8 bytes: 5461*3 = 16383, +1 ASCII = 16384.
      ["ệ".repeat(5461) + "a", true],
      ["ệ".repeat(5461) + "ab", false],
      // Emoji is 4 bytes and 2 UTF-16 units: 4096*4 = 16384.
      ["😀".repeat(4096), true],
      ["😀".repeat(4095) + "aaaaa", false],
      // A lone surrogate encodes as U+FFFD (3 bytes), matching the previous Node count.
      ["a".repeat(limit - 3) + "\uD800", true],
      ["a".repeat(limit - 2) + "\uD800", false],
      ["\uDC00" + "a".repeat(limit - 3), true]
    ];
    for (const [text, ok] of cases) {
      const expected = new TextEncoder().encode(text).byteLength <= limit;
      expect(expected).toBe(ok);
      expect(Buffer.byteLength(text, "utf8") <= limit).toBe(ok); // legacy server count agrees
      withoutBuffer(() => expect(DirectorMessageSchema.safeParse({ ...message, text }).success, `${text.length}`).toBe(ok));
      expect(DirectorMessageSchema.safeParse({ ...message, text }).success).toBe(ok);
    }
  });

  it("keeps the legacy message shape and version", () => {
    for (const patch of [{ schemaVersion: 2 }, { text: "   " }, { channel: "herdr" }, { author: "conversation" }, { extra: true }, { seq: 0 }]) {
      expect(DirectorMessageSchema.safeParse({ ...message, ...patch }).success).toBe(false);
    }
    expect(DirectorMessageSchema.parse({ ...message, runId: "run-1" }).runId).toBe("run-1");
  });
});

describe("D-CD-01 browser-safe Director re-exports from /web", () => {
  it("re-exports the same Director schemas as the root entry", () => {
    expect(DirectorMessageSchema).toBe(root.DirectorMessageSchema);
    expect(DirectorPresenceSchema).toBe(root.DirectorPresenceSchema);
    expect(DirectorProgressSnapshotSchema).toBe(root.DirectorProgressSnapshotSchema);
    expect(ParkedIssueSchema).toBe(root.ParkedIssueSchema);
    expect(DIRECTOR_LIMITS).toBe(root.DIRECTOR_LIMITS);
  });
});

describe("D-CD-01 WebDirectorView", () => {
  it("roundtrips the strict view without session secrets or machine paths", () => {
    expect(WebDirectorViewSchema.parse(view)).toEqual(view);
    const { sessionId: _s, waitingSince: _w, ...minimal } = view;
    expect(WebDirectorViewSchema.parse({ ...minimal, layout: "not_started" })).toEqual({ ...minimal, layout: "not_started" });
    expect(WebDirectorViewSchema.parse({ ...view, layout: "legacy_v2", transcriptSeq: 0 }).layout).toBe("legacy_v2");
    for (const extra of [{ tokenId: "token-1" }, { directorId: "d" }, { repositoryRoot: "/repo" }, { session: {} }]) {
      expect(WebDirectorViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
    }
  });
  it("rejects invalid version, layout, sequence and snapshot", () => {
    for (const patch of [{ apiVersion: 2 }, { layout: "director_v3" }, { transcriptSeq: -1 }, { transcriptSeq: 1.5 },
      { cliCaptureMayBeIncomplete: "no" }, { observedAt: "yesterday" }, { snapshot: { ...snapshot, schemaVersion: 2 } },
      { snapshot: { ...snapshot, director: { presence: "stale" } } }, { snapshot: { ...snapshot, director: { presence: "active", provider: "gemini" } } }]) {
      expect(WebDirectorViewSchema.safeParse({ ...view, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    const { snapshot: _snapshot, ...missing } = view;
    expect(WebDirectorViewSchema.safeParse(missing).success).toBe(false);
  });
});

describe("D-CD-01 issue queue and transcript pages", () => {
  it("bounds issue and transcript pages to the Web page maximum", () => {
    const page = { apiVersion: 1, items: [issue], nextCursor: "c1" };
    expect(WebIssueQueueViewSchema.parse(page)).toEqual(page);
    expect(WebIssueQueueViewSchema.safeParse({ apiVersion: 1, items: Array(101).fill(issue) }).success).toBe(false);
    expect(WebIssueQueueViewSchema.safeParse({ ...page, items: [{ ...issue, extra: 1 }] }).success).toBe(false);
    const transcript = WebHttpContracts.directorMessages.response;
    expect(transcript.parse({ apiVersion: 1, items: [message, { ...message, seq: 2, author: "director", channel: "cli" }] }).items).toHaveLength(2);
    expect(transcript.safeParse({ apiVersion: 1, items: Array(101).fill(message) }).success).toBe(false);
    expect(transcript.safeParse({ apiVersion: 2, items: [] }).success).toBe(false);
  });
});

describe("D-CD-01 launch options and request", () => {
  const option = { provider: "claude", state: "available", manualCommand: "claude '/bflow-start'" };
  const options = { apiVersion: 1, projectId, terminal: { available: false, reason: "No desktop session" },
    providers: [option, { provider: "codex", state: "unverified", reason: "Version probe timed out", manualCommand: "codex '$bflow-start'" },
      { provider: "agy", state: "unavailable", reason: "Binary not found", manualCommand: "agy /bflow-start" }], observedAt: now };
  it("roundtrips strict options and rejects unknown provider/state/oversized command", () => {
    expect(WebDirectorLaunchOptionsSchema.parse(options)).toEqual(options);
    expect(WebDirectorLaunchOptionSchema.parse(option)).toEqual(option);
    for (const patch of [{ provider: "gemini" }, { state: "installed" }, { state: "ready" }, { manualCommand: "x".repeat(4097) }, { argv: ["claude"] }]) {
      expect(WebDirectorLaunchOptionSchema.safeParse({ ...option, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    expect(WebDirectorLaunchOptionSchema.parse({ ...option, manualCommand: "x".repeat(4096) }).manualCommand).toHaveLength(4096);
    for (const patch of [{ apiVersion: 2 }, { providers: [...options.providers, option] }, { terminal: { available: true, command: "x" } },
      { cwd: "/repo" }, { providers: [option, option] }]) {
      expect(WebDirectorLaunchOptionsSchema.safeParse({ ...options, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
  it("accepts only provider/replaceActive from the browser; server builds argv/cwd", () => {
    expect(WebDirectorLaunchRequestSchema.parse(launchRequest)).toEqual({ ...launchRequest, replaceActive: false });
    expect(WebDirectorLaunchRequestSchema.parse({ ...launchRequest, replaceActive: true }).replaceActive).toBe(true);
    for (const patch of [{ apiVersion: 2 }, { operationId: "not-a-uuid" }, { provider: "gemini" }, { command: "rm -rf /" },
      { env: { PATH: "/tmp" } }, { cwd: "/tmp" }, { argv: ["sh"] }, { replaceActive: "yes" }]) {
      expect(WebDirectorLaunchRequestSchema.safeParse({ ...launchRequest, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("D-CD-01 issue commands", () => {
  it("roundtrips strict issue_retry and issue_dismiss commands", () => {
    expect(WebCommandSchema.parse(retry)).toEqual(retry);
    expect(WebCommandSchema.parse(dismiss)).toEqual(dismiss);
    for (const patch of [{ apiVersion: 2 }, { commandId: "c" }, { expectedUpdatedAt: "now" }, { issueId: "" }, { reason: "x" },
      { expectedVersion: { revisionToken: "t" } }, { status: "dismissed" }]) {
      expect(WebCommandSchema.safeParse({ ...retry, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    const { runId: _r, ...noRun } = retry;
    const { issueId: _i, ...noIssue } = retry;
    const { expectedUpdatedAt: _e, ...noVersion } = retry;
    for (const value of [noRun, noIssue, noVersion]) expect(WebCommandSchema.safeParse(value).success).toBe(false);
  });
  it("does not advertise issue kinds through the existing action kind list", () => {
    expect(WebCommandKindSchema.options).toEqual(["create_request", "revise_request", "answer_clarification", "answer_decision", "resume", "cancel"]);
    expect(WebActionSchema.safeParse({ actionId: "a", kind: "issue_retry", enabled: true, expectedVersion: { revisionToken: "t" } }).success).toBe(false);
    expect(WebOperationKindSchema.options).toEqual([...WebCommandKindSchema.options, "issue_retry", "issue_dismiss", "session_start", "session_stop", "director_launch"]);
    expect(WebEventSchema.shape.type.options).toEqual(["invalidate", "operation", "notice", "chat", "reset"]);
  });
});

describe("D-CD-01 operation ownership and per-kind results", () => {
  it("accepts each kind only with its owner and result kind", () => {
    const accepted = [
      operation({ owner: "host_interaction", operationKind: "issue_retry", result: { kind: "issue", issueId: "issue-1", status: "retrying" } }),
      operation({ owner: "host_interaction", operationKind: "issue_dismiss", result: { kind: "issue", issueId: "issue-1", status: "dismissed" } }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: launchResult }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", state: "running" }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", state: "reconciliation_required",
        error: { apiVersion: 1, code: "reconciliation_required", message: "Launch outcome unknown", retryable: false, correlationId: "c" } }),
      operation({ owner: "local_lifecycle", operationKind: "session_start", result: { kind: "lifecycle", session } }),
      operation({ owner: "host_interaction", operationKind: "create_request", result: { kind: "intake", intakeId: "i" } }),
      operation({ owner: "host_interaction", operationKind: "resume", result: { kind: "interaction", runId: "r", currentRunId: "r" } })
    ];
    for (const value of accepted) expect(WebOperationSchema.parse(value), JSON.stringify(value)).toEqual(value);
  });
  it("rejects cross-call owner/result combinations", () => {
    const rejected = [
      operation({ owner: "local_lifecycle", operationKind: "issue_retry", result: { kind: "issue", issueId: "issue-1", status: "retrying" } }),
      operation({ owner: "host_interaction", operationKind: "director_launch", result: launchResult }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: { kind: "lifecycle", session } }),
      operation({ owner: "local_lifecycle", operationKind: "session_start", result: launchResult }),
      operation({ owner: "local_lifecycle", operationKind: "session_stop", result: { kind: "issue", issueId: "issue-1", status: "open" } }),
      operation({ owner: "host_interaction", operationKind: "issue_retry", result: { kind: "interaction", runId: "r", currentRunId: "r" } }),
      operation({ owner: "host_interaction", operationKind: "issue_dismiss", result: { kind: "intake", intakeId: "i" } }),
      operation({ owner: "host_interaction", operationKind: "issue_retry", result: launchResult }),
      operation({ owner: "host_interaction", operationKind: "answer_decision", result: { kind: "issue", issueId: "issue-1", status: "resolved" } }),
      operation({ owner: "host_interaction", operationKind: "create_request", result: launchResult }),
      operation({ owner: "host_interaction", operationKind: "resume", result: { kind: "intake", intakeId: "i" } }),
      operation({ owner: "host_interaction", operationKind: "cancel", result: { kind: "lifecycle", session } }),
      operation({ owner: "host_interaction", operationKind: "issue_retry", result: { kind: "issue", issueId: "issue-1", status: "parked" } }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: { ...launchResult, mode: "headless" } }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: { ...launchResult, manualCommand: "x".repeat(4097) } }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: { ...launchResult, provider: "gemini" } }),
      operation({ owner: "local_lifecycle", operationKind: "director_launch", result: { ...launchResult, argv: ["codex"] } })
    ];
    for (const value of rejected) expect(WebOperationSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

const principalFor = (command: { commandId: string; projectId: string }, digest: string) => ({ schemaVersion: 1, source: "local_web",
  issuerId: "issuer", keyId: "key", principalId: "user", browserSessionId: "browser", projectId: command.projectId, hostSessionId: "host",
  capability: "user_interaction", commandId: command.commandId, commandDigest: digest, issuedAt: now, expiresAt: later, nonce: "nonce",
  signature: { algorithm: "ed25519", value: "A".repeat(86) + "==" } });
function receiptFor(command: { commandId: string; projectId: string; kind: string }, op: Record<string, unknown>) {
  const fingerprint = webCommandFingerprint(command);
  const receipt = { version: 2, repository: "/fixture", sessionId: "host", kind: "web-interaction", id: command.commandId,
    payload: { principal: principalFor(command, fingerprint), command, fingerprint, operation: op }, checksum: "" };
  const { checksum: _checksum, ...body } = receipt;
  receipt.checksum = createHash("sha256").update(canonicalWebJson(body)).digest("hex");
  return receipt;
}

describe("D-CD-01 host receipts and operation index", () => {
  it("round-trips pre-existing command receipts and index records unchanged", () => {
    const commands = [vectors.validCreate, ...bundle.map((item: { proposedWebCommand: unknown }) => item.proposedWebCommand)];
    for (const command of commands) {
      expect(WebCommandSchema.parse(command)).toEqual(command);
      const receipt = receiptFor(command, { apiVersion: 1, operationId: command.commandId, projectId: command.projectId,
        owner: "host_interaction", operationKind: command.kind, state: "accepted", updatedAt: now });
      expect(WebInteractionReceiptSchema.parse(receipt)).toEqual(receipt);
      const index = { schemaVersion: 1, projectId: command.projectId, principalId: "user", commandId: command.commandId, owner: "host_interaction",
        operationKind: command.kind, fingerprint: receipt.payload.fingerprint, hostSessionId: "host", receiptId: command.commandId, createdAt: now };
      expect(WebOperationIndexRecordSchema.parse(index)).toEqual(index);
    }
    const lifecycle = { schemaVersion: 1, projectId, principalId: "user", commandId, owner: "local_lifecycle", operationKind: "session_stop",
      fingerprint: "b".repeat(64), receiptId: commandId, createdAt: now };
    expect(WebOperationIndexRecordSchema.parse(lifecycle)).toEqual(lifecycle);
  });
  it("signs issue commands through the existing host receipt path", () => {
    const applied = receiptFor(retry, operation({ owner: "host_interaction", operationKind: "issue_retry",
      result: { kind: "issue", issueId: "issue-1", status: "retrying" } }));
    expect(WebInteractionReceiptSchema.parse(applied)).toEqual(applied);
    const accepted = receiptFor(dismiss, operation({ owner: "host_interaction", operationKind: "issue_dismiss", state: "accepted" }));
    expect(WebInteractionReceiptSchema.parse(accepted)).toEqual(accepted);
    const foreignIssue = receiptFor(retry, operation({ owner: "host_interaction", operationKind: "issue_retry",
      result: { kind: "issue", issueId: "issue-2", status: "retrying" } }));
    expect(WebInteractionReceiptSchema.safeParse(foreignIssue).success).toBe(false);
    const wrongKind = receiptFor(retry, operation({ owner: "host_interaction", operationKind: "issue_dismiss", state: "accepted" }));
    expect(WebInteractionReceiptSchema.safeParse(wrongKind).success).toBe(false);
    const launch = receiptFor(retry, operation({ owner: "local_lifecycle", operationKind: "director_launch", state: "accepted" }));
    expect(WebInteractionReceiptSchema.safeParse(launch).success).toBe(false);
  });
  it("indexes director_launch as local lifecycle and issue commands as host interaction", () => {
    const launch = { schemaVersion: 1, projectId, principalId: "user", commandId, owner: "local_lifecycle", operationKind: "director_launch",
      fingerprint: "c".repeat(64), receiptId: commandId, createdAt: now };
    expect(WebOperationIndexRecordSchema.parse(launch)).toEqual(launch);
    expect(WebOperationIndexRecordSchema.safeParse({ ...launch, owner: "host_interaction", hostSessionId: "host" }).success).toBe(false);
    expect(WebOperationIndexRecordSchema.safeParse({ ...launch, hostSessionId: "host" }).success).toBe(false);
    const issueIndex = { ...launch, owner: "host_interaction", operationKind: "issue_retry", hostSessionId: "host" };
    expect(WebOperationIndexRecordSchema.parse(issueIndex)).toEqual(issueIndex);
    expect(WebOperationIndexRecordSchema.safeParse({ ...issueIndex, owner: "local_lifecycle", hostSessionId: undefined }).success).toBe(false);
  });
});

describe("D-CD-01 HTTP routes", () => {
  it("adds exactly six Director routes under /api/v1/projects/:id without changing existing ones", () => {
    const routes = {
      director: ["GET", "/api/v1/projects/:id/director", [200]],
      directorMessages: ["GET", "/api/v1/projects/:id/director/messages", [200]],
      sendDirectorMessage: ["POST", "/api/v1/projects/:id/director/messages", [202]],
      directorIssues: ["GET", "/api/v1/projects/:id/director/issues", [200]],
      directorLaunchOptions: ["GET", "/api/v1/projects/:id/director/launch-options", [200]],
      launchDirector: ["POST", "/api/v1/projects/:id/director/launch", [202]]
    } as const;
    for (const [name, [method, path, statuses]] of Object.entries(routes)) {
      const contract = WebHttpContracts[name as keyof typeof routes];
      expect(contract, name).toBeDefined();
      expect([contract.method, contract.path, contract.statuses]).toEqual([method, path, statuses]);
      expect("stream" in contract).toBe(false);
    }
    expect(Object.keys(WebHttpContracts)).toHaveLength(28 + 6);
    expect(WebHttpContracts.command.body).toBe(WebCommandSchema);
    expect(WebHttpContracts.sendMessage.path).toBe("/api/v1/projects/:id/sessions/:sessionId/messages");
    expect(WebHttpContracts.events.response).toBe(WebEventSchema);
  });
  it("binds request/response schemas for the Director routes", () => {
    expect(WebHttpContracts.director.response).toBe(WebDirectorViewSchema);
    expect(WebHttpContracts.directorIssues.response.parse({ apiVersion: 1, items: [issue] }).items).toHaveLength(1);
    expect(WebHttpContracts.directorLaunchOptions.response).toBe(WebDirectorLaunchOptionsSchema);
    expect(WebHttpContracts.launchDirector.body).toBe(WebDirectorLaunchRequestSchema);
    expect(WebHttpContracts.launchDirector.response).toBe(WebOperationSchema);
    expect(WebHttpContracts.sendDirectorMessage.response).toBe(DirectorMessageSchema);
    const send = { apiVersion: 1, messageId: commandId, projectId, sessionId: "host-session", content: "Xin chào 👋" };
    expect(WebHttpContracts.sendDirectorMessage.body.parse(send)).toEqual(send);
    expect(WebHttpContracts.sendDirectorMessage.body.safeParse({ ...send, author: "director" }).success).toBe(false);
    for (const name of ["directorMessages", "directorIssues"] as const) {
      const query = WebHttpContracts[name].query;
      expect(query.parse({})).toEqual({});
      expect(query.parse({ cursor: "abc" })).toEqual({ cursor: "abc" });
      expect(query.safeParse({ cursor: "" }).success).toBe(false);
      expect(query.safeParse({ limit: "10" }).success).toBe(false);
    }
    for (const name of ["director", "directorLaunchOptions"] as const) {
      expect(WebHttpContracts[name].body.safeParse(undefined).success).toBe(true);
      expect(WebHttpContracts[name].query.safeParse({ cursor: "x" }).success).toBe(false);
    }
  });
});
