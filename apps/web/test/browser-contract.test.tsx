import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WEB_API_VERSION, WebSessionBootstrapRequestSchema } from "@bflow/contracts/web";
afterEach(cleanup);
it("renders with the real browser-safe contract subpath", () => {
  const view = render(<p data-api-version={WEB_API_VERSION}>Contract import smoke</p>);
  expect(view.getByText("Contract import smoke").getAttribute("data-api-version")).toBe("1");
  expect(WebSessionBootstrapRequestSchema.safeParse({ apiVersion: 2, secret: "x" }).success).toBe(false);
});

// Compile-time compatibility for recovering pre-run clarifications over the port.
import { expectTypeOf } from "vitest";
import type { UserInteractionClient, WebProjectSession } from "@bflow/contracts/web";
it("reserves the project session query on the interaction port", () => {
  expectTypeOf<UserInteractionClient["readProjectSession"]>().parameter(0).toEqualTypeOf<string>();
  expectTypeOf<UserInteractionClient["readProjectSession"]>().returns.resolves.extract<{ ok: true }>().toHaveProperty("value").toEqualTypeOf<WebProjectSession>();
});

// D-CD-01: Director shapes reach the browser only through the /web subpath and parse without Node globals.
import { DIRECTOR_LIMITS, DirectorMessageSchema, ParkedIssueSchema, WebDirectorViewSchema, WebHttpContracts, WebOperationSchema } from "@bflow/contracts/web";
it("parses Director transcript/view shapes from /web without a Buffer global", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe("undefined");
    const at = "2026-11-04T10:00:00.000Z";
    const message = { schemaVersion: 1, seq: 1, messageId: "m-1", author: "director", channel: "cli", text: "Đã xong bước 1 ✅", at };
    expect(DirectorMessageSchema.parse(message)).toEqual(message);
    expect(WebHttpContracts.directorMessages.response.safeParse({ apiVersion: 1, items: [message] }).success).toBe(true);
    const limit = DIRECTOR_LIMITS.messageBytes;
    expect(DirectorMessageSchema.safeParse({ ...message, text: "ệ".repeat(5461) + "a" }).success).toBe(true);
    expect(DirectorMessageSchema.safeParse({ ...message, text: "😀".repeat(limit / 4) + "a" }).success).toBe(false);
    expect(DirectorMessageSchema.safeParse({ ...message, text: "a".repeat(limit - 2) + "\uD800" }).success).toBe(false);
    const issue = { schemaVersion: 1, issueId: "i-1", runId: "r-1", kind: "environment", status: "open", summary: "Thiếu quyền",
      attempts: 0, evidence: [], createdAt: at, updatedAt: at };
    expect(ParkedIssueSchema.parse(issue)).toEqual(issue);
    const view = { apiVersion: 1, projectId: "p", layout: "not_started", transcriptSeq: 0, cliCaptureMayBeIncomplete: true, observedAt: at,
      snapshot: { schemaVersion: 1, generatedAt: at, director: { presence: "absent" }, runs: [], pendingApprovals: 0, pendingQuestions: 0, issues: [issue] } };
    expect(WebDirectorViewSchema.parse(view)).toEqual(view);
    expect(WebDirectorViewSchema.safeParse({ ...view, tokenId: "t" }).success).toBe(false);
    expect(WebOperationSchema.safeParse({ apiVersion: 1, operationId: "00000000-0000-4000-8000-0000000000c1", projectId: "p",
      owner: "local_lifecycle", operationKind: "director_launch", state: "applied", updatedAt: at,
      result: { kind: "director_launch", provider: "claude", mode: "manual_command", manualCommand: "claude '/bflow-start'", launchedAt: at } }).success).toBe(true);
  } finally { if (saved) Object.defineProperty(globalThis, "Buffer", saved); }
  expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe("function");
});
