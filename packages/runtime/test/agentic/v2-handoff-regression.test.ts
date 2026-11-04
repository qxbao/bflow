import { join } from "node:path";
import { access } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { buildAnalysisPack } from "../../src/analysis/pack.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { directorExtensionFixture, extensionDelegation } from "../helpers/director-extension.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const input = { key: "v2-handoff", title: "Health", objective: "Specify health", kind: "spike" as const,
  acceptanceCriteria: [{ description: "Traceable health specification", verificationMethod: "manual_review" }],
  sddLevel: "lightweight" as const, priority: "normal" as const, requestedAt: "2026-11-04T00:00:00.000Z" };

it("still admits a v2 Conversation handoff", async () => {
  const e = await directorExtensionFixture(), host = await e.create({ admissionOrigin: "conversation" });
  expect(await host.admit(extensionDelegation("run-native", false))).toBe("analysis");
});

it("creates no routes/state.json for implementation admission", async () => {
  const e = await directorExtensionFixture(); e.setPack(undefined);
  const host = await e.create({ admissionOrigin: "conversation" });
  expect(await host.admit(extensionDelegation("run-native", false))).toBe("implementation");
  await expect(access(join(e.options.journalDirectory, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps an implementation intake on its original path while its v2 handoff is still queued", async () => {
  const f = await fixture({ intake: false }), e = await directorExtensionFixture(); e.setPack(undefined);
  const extensions = await e.create({ sessionId: "session-1", admissionOrigin: "conversation",
    isLegacyImplementationRun: runId => f.runtime.hasDelegation(runId) });
  const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()),
    contextDirectory: join(f.root, "v2-freeze-conversation"), extensions });
  const first = await chat.delegateDirectorWork(input);
  expect(first.ok).toBe(true);
  const queued = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "delegation.request");
  e.setPack(buildAnalysisPack({ id: "later-analysis", version: "1" }));
  expect(await extensions.admit(queued.message.payload)).toBe("implementation");
  expect(await extensions.owns(queued.message.run_id)).toBe(false);
});

it.each([
  { error: new Error("Workflow pack digest mismatch"), code: "validation", retryable: false },
  { error: Object.assign(new Error("temporary pack read unavailable"), { code: "EIO" }), code: "transport_unavailable", retryable: true }
])("returns a coded admission result before enqueue for $code", async ({ error, code, retryable }) => {
  const f = await fixture({ intake: false }), e = await directorExtensionFixture();
  const extensions = await e.create({ admissionOrigin: "conversation" });
  vi.spyOn(extensions, "admit").mockRejectedValue(error);
  const queue = vi.spyOn(f.runtime, "queueHerdr");
  const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()),
    contextDirectory: join(f.root, "v2-conversation"), extensions });
  await expect(chat.delegateDirectorWork(input)).resolves.toMatchObject({ ok: false, error: { code, retryable } });
  expect(queue).not.toHaveBeenCalled();
});

it("cancels an existing v2 run without extension admission", async () => {
  const f = await fixture(), e = await directorExtensionFixture();
  const extensions = await e.create({ admissionOrigin: "conversation" }), admit = vi.spyOn(extensions, "admit");
  const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()),
    contextDirectory: join(f.root, "v2-cancel-conversation"), extensions });
  const result = await chat.handleUserTurn({ sessionId: "session-1", messageId: "cancel-existing-v2", content: "Hủy việc này",
    provenance: { origin: "user", authenticatedUser: true }, conversationDecision: { intent: "cancellation_request",
      cancellationInput: { runId: "run-1", reason: "Owner cancelled" } } });
  expect(result).toMatchObject({ ok: true }); expect(admit).not.toHaveBeenCalled();
});
