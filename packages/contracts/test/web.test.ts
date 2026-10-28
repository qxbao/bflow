import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WebCommandSchema, WebOperationSchema, WebApiErrorSchema, WebApiErrorStatus,
  WebRunViewSchema, WebSessionBootstrapRequestSchema, WebChatSendSchema,
  WebPageQuerySchema, WebArtifactChunkSchema, WebArtifactReadSchema, WebHttpContracts, WebRunHttpQuerySchema
} from "../src/web.js";
import { WebPrincipalSchema, WebInteractionReceiptSchema, WebOperationIndexRecordSchema, canonicalWebJson } from "../src/web-host.js";

const bundle = JSON.parse(readFileSync(new URL("./fixtures/local-web/approval-bundle.json", import.meta.url), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("./fixtures/local-web/command-vectors.json", import.meta.url), "utf8"));
const now = "2026-10-28T00:00:00.000Z";
const create = vectors.validCreate;
const approval = bundle[0].proposedWebCommand;
const operation = { apiVersion: 1, operationId: create.commandId, projectId: create.projectId,
  owner: "host_interaction", operationKind: "create_request", state: "accepted", updatedAt: now };
const principal = { schemaVersion: 1, source: "local_web", issuerId: "issuer", keyId: "key", principalId: "user",
  browserSessionId: "browser", projectId: create.projectId, hostSessionId: "host", capability: "user_interaction",
  commandId: create.commandId, commandDigest: createHash("sha256").update(JSON.stringify(create, Object.keys(create).sort())).digest("hex"), issuedAt: now, expiresAt: "2026-10-28T00:01:00.000Z",
  nonce: "nonce", signature: { algorithm: "ed25519", value: "A".repeat(86) + "==" } };

describe("local web version-1 contracts", () => {
  it("roundtrips commands including exact approval target and evidence", () => {
    expect(WebCommandSchema.parse(create)).toEqual(create);
    for (const item of bundle) expect(WebCommandSchema.parse(item.proposedWebCommand)).toEqual(item.proposedWebCommand);
  });
  it("rejects unknown versions, unknown keys and browser authority", () => {
    for (const extra of [{ apiVersion: 2 }, { authenticatedUser: true }, { decidedBy: "me" }, { binding: {} }]) {
      expect(WebCommandSchema.safeParse({ ...create, ...extra }).success).toBe(false);
    }
    expect(WebSessionBootstrapRequestSchema.safeParse({ apiVersion: 1, secret: "secret", token: "host-token" }).success).toBe(false);
  });
  it("never drops stale target values or evidence binding", () => {
    for (const key of ["approvalId", "target", "revision", "generation", "evidenceDigest", "revisionToken"]) {
      const expectedVersion = { ...approval.expectedVersion };
      delete expectedVersion[key];
      expect(WebCommandSchema.safeParse({ ...approval, expectedVersion }).success).toBe(false);
    }
    const stale = { ...approval, expectedVersion: { ...approval.expectedVersion, generation: 0 } };
    expect(WebCommandSchema.parse(stale)).toEqual(stale); // only the host knows current generation
    expect(WebCommandSchema.safeParse({ ...approval, decisionId: "different" }).success).toBe(false);
  });
  it("requires reasons for rejected and changes_requested decisions", () => {
    const { reason: _reason, ...input } = approval;
    for (const outcome of ["rejected", "changes_requested"]) expect(WebCommandSchema.safeParse({ ...input, outcome }).success).toBe(false);
  });
  it("supports pre-run intake clarification without a fabricated run", () => {
    const input = { apiVersion: 1, commandId: create.commandId, projectId: create.projectId, kind: "answer_clarification",
      intakeId: "intake", questionId: "q", expectedVersion: { revisionToken: "token" }, answer: "Do the full check" };
    expect(WebCommandSchema.parse(input)).toEqual(input);
    expect(WebCommandSchema.safeParse({ ...input, runId: "run" }).success).toBe(false);
    const { intakeId: _id, ...missing } = input;
    expect(WebCommandSchema.safeParse(missing).success).toBe(false);
    expect(WebCommandSchema.parse({ ...missing, runId: "run" }).runId).toBe("run");
    expect(WebOperationSchema.parse({ ...operation, state: "applied", result: { kind: "intake", intakeId: "intake" } }).result).toEqual({ kind: "intake", intakeId: "intake" });
  });
  it("enforces operation owner/kind/state/result consistency", () => {
    expect(WebOperationSchema.parse(operation)).toEqual(operation);
    for (const patch of [{ owner: "local_lifecycle" }, { state: "applied" }, { state: "failed" }, { result: { kind: "interaction", runId: "r", currentRunId: "r" } }]) {
      expect(WebOperationSchema.safeParse({ ...operation, ...patch }).success).toBe(false);
    }
    expect(WebOperationSchema.safeParse({ ...operation, state: "applied", result: { kind: "lifecycle", session: {} } }).success).toBe(false);
  });
  it("retains separate domains and lineage in historical run snapshots", () => {
    const view = { apiVersion: 1, runId: "parent", sessionId: "s", revisionToken: "v", title: "Original",
      originRunId: "parent", continuedAsRunId: "child", currentRunId: "child", sdlcStatus: "awaiting_approval", coreStatus: null,
      transportSummary: { states: ["done"], observedAt: now }, tasks: [], blockers: [], decisions: [], clarifications: [], availableActions: [], updatedAt: now };
    expect(WebRunViewSchema.parse(view)).toEqual(view);
    expect(WebRunViewSchema.safeParse({ ...view, sdlcStatus: "done" }).success).toBe(false);
  });
  it("bounds page inputs, UTF-8 chat and stream chunks", () => {
    expect(WebPageQuerySchema.parse({})).toEqual({ limit: 25 });
    for (const query of [{ limit: 101 }, { cursor: "" }, { unknown: "x" }]) expect(WebPageQuerySchema.safeParse(query).success).toBe(false);
    const send = { apiVersion: 1, messageId: create.commandId, projectId: create.projectId, sessionId: "s", content: "a".repeat(16384) };
    expect(WebChatSendSchema.safeParse(send).success).toBe(true);
    expect(WebChatSendSchema.safeParse({ ...send, content: "界".repeat(5462) }).success).toBe(false);
    expect(WebArtifactChunkSchema.safeParse(new Uint8Array(65537)).success).toBe(false);
    expect(WebArtifactChunkSchema.safeParse(new Uint8Array(65536)).success).toBe(true);
  });
  it("maps only safe API errors and rejects arbitrary details", () => {
    for (const [code, status] of Object.entries(WebApiErrorStatus)) {
      expect([400, 401, 403, 404, 409, 413, 422, 503]).toContain(status);
      expect(WebApiErrorSchema.parse({ apiVersion: 1, code, message: "Safe error", retryable: code === "unavailable", correlationId: "c" }).code).toBe(code);
    }
    expect(WebApiErrorSchema.safeParse({ apiVersion: 1, code: "forbidden", message: "No", retryable: false, correlationId: "c", details: { token: "private" } }).success).toBe(false);
  });
  it("checks web proof shape and receipt identity without claiming signature authentication", () => {
    expect(WebPrincipalSchema.parse(principal)).toEqual(principal);
    expect(WebPrincipalSchema.safeParse({ ...principal, source: "UserPromptSubmit" }).success).toBe(false);
    expect(WebPrincipalSchema.safeParse({ ...principal, expiresAt: "2026-10-28T00:02:00.000Z" }).success).toBe(false);
    const proof = { ...principal, commandDigest: createHash("sha256").update(canonicalWebJson(create)).digest("hex") };
    const receipt = { version: 2, repository: "/fixture", sessionId: "host", kind: "web-interaction", id: create.commandId,
      payload: { principal: proof, command: create, fingerprint: proof.commandDigest, operation }, checksum: "" };
    const { checksum: _checksum, ...body } = receipt;
    receipt.checksum = createHash("sha256").update(canonicalWebJson(body)).digest("hex");
    expect(WebInteractionReceiptSchema.parse(receipt)).toEqual(receipt);
    const malformed = { ...receipt, payload: { ...receipt.payload, command: { ...create, title: "" } } };
    expect(() => WebInteractionReceiptSchema.safeParse(malformed)).not.toThrow();
    expect(WebInteractionReceiptSchema.safeParse(malformed).success).toBe(false);
    expect(WebInteractionReceiptSchema.safeParse({ ...receipt, checksum: "0".repeat(64) }).success).toBe(false);
    expect(WebInteractionReceiptSchema.safeParse({ ...receipt, version: 1 }).success).toBe(false);
    expect(WebInteractionReceiptSchema.safeParse({ ...receipt, sessionId: "other-host" }).success).toBe(false);
    expect(WebInteractionReceiptSchema.safeParse({ ...receipt, payload: { ...receipt.payload, command: { ...create, projectId: "foreign" } } }).success).toBe(false);
    expect(canonicalWebJson({ z: 1, a: ["x", { c: true, b: null }] })).toBe('{"a":["x",{"b":null,"c":true}],"z":1}');
  });
  it("pins operation lookup to the original host session across restarts", () => {
    const index = { schemaVersion: 1, projectId: create.projectId, principalId: "user", commandId: create.commandId,
      owner: "host_interaction", operationKind: "create_request", fingerprint: "a".repeat(64), hostSessionId: "original-host",
      receiptId: create.commandId, createdAt: now };
    expect(WebOperationIndexRecordSchema.parse(index)).toEqual(index);
    const { hostSessionId: _host, ...missing } = index;
    expect(WebOperationIndexRecordSchema.safeParse(missing).success).toBe(false);
    expect(WebOperationIndexRecordSchema.safeParse({ ...index, receiptId: "00000000-0000-4000-8000-000000000099" }).success).toBe(false);
    expect(WebOperationIndexRecordSchema.safeParse({ ...index, owner: "local_lifecycle", operationKind: "session_start" }).success).toBe(false);
  });
  it("exports exact HTTP bodies/statuses and strict URL query limits", () => {
    expect(WebHttpContracts.command.statuses).toEqual([202]);
    expect(WebHttpContracts.unregisterProject.response.safeParse(undefined).success).toBe(true);
    expect(WebHttpContracts.unregisterProject.body.safeParse({ apiVersion: 1 }).success).toBe(false);
    expect(WebHttpContracts.bootstrap.body.safeParse({ apiVersion: 1, secret: "s" }).success).toBe(true);
    expect(WebHttpContracts.run.body.safeParse({}).success).toBe(false);
    expect(WebRunHttpQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    for (const limit of ["0", "101", "1e2", " 25", "2.5"]) expect(WebRunHttpQuerySchema.safeParse({ limit }).success).toBe(false);
    expect(WebArtifactReadSchema.safeParse({ metadata: {}, chunks: [] }).success).toBe(false);
  });
  it("has a browser-safe transitive source closure, not just a safe entry file", () => {
    const visited = new Set<string>();
    function visit(path: string) {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/(?:node:|\bBuffer\b|\bprocess\b|web-host|role-profile|receipts\.js)/);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.startsWith(".")) visit(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")));
        else expect(specifier).toBe("zod");
      }
    }
    const temporary = mkdtempSync(join(tmpdir(), "bflow web closure "));
    try {
      cpSync(fileURLToPath(new URL("../src/", import.meta.url)), temporary, { recursive: true });
      visit(fileURLToPath(pathToFileURL(join(temporary, "web.ts"))));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    expect(visited.size).toBeGreaterThan(1);
  });
});
