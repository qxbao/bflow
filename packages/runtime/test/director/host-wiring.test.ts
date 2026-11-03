import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { DirectorEndpoint } from "../../src/director/endpoint.js";
import { DIRECTOR_OWNER_METHODS, isDirectorCoordinatorTool, isDirectorCredential, parseDirectorCredentialCall } from "../../src/director/host-methods.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("director host wiring helpers", () => {
  it("rejects every method but director_call for Director credentials", () => {
    expect(() => parseDirectorCredentialCall("role_call", {})).toThrow("Director credentials can only call director tools");
    expect(() => parseDirectorCredentialCall("director_register", {})).toThrow("Director credentials can only call director tools");
    expect(parseDirectorCredentialCall("director_call", { name: "inspect" })).toEqual({ name: "inspect" });
    expect(() => parseDirectorCredentialCall("director_call", { name: "inspect", extra: 1 })).toThrow();
  });
  it("routes only dotted tokens to the Director branch", () => {
    const owner = "a".repeat(64);
    expect(isDirectorCredential("a".repeat(64), owner)).toBe(false);
    expect(isDirectorCredential("b".repeat(64), owner)).toBe(false);
    expect(isDirectorCredential(`${"t".repeat(12)}.${"s".repeat(43)}`, owner)).toBe(true);
    expect(isDirectorCredential(owner, owner)).toBe(false);
  });
  it("admits coordinator tools except report_progress", () => {
    expect(isDirectorCoordinatorTool("inspect")).toBe(true);
    expect(isDirectorCoordinatorTool("propose_workflow")).toBe(true);
    expect(isDirectorCoordinatorTool("planning_reference")).toBe(true);
    expect(isDirectorCoordinatorTool("report_progress")).toBe(false);
    expect(isDirectorCoordinatorTool("repository_read")).toBe(false);
  });
  it("validates owner method inputs strictly", () => {
    expect(() => DIRECTOR_OWNER_METHODS.director_register.parse({ provider: "claude", x: 1 })).toThrow();
    expect(() => DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "é".repeat(8193) })).toThrow();
    expect(DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "hi" }).prompt).toBe("hi");
    expect(DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "hi", sessionId: "s1" }).sessionId).toBe("s1");
    expect(() => DIRECTOR_OWNER_METHODS.director_hook_note.parse({ provider: "claude", prompt: "hi", sessionId: "s".repeat(201) })).toThrow();
    expect(() => DIRECTOR_OWNER_METHODS.director_issue_status.parse({ issueId: "i", status: "open" })).toThrow();
    expect(DIRECTOR_OWNER_METHODS.director_issue_status.parse({ issueId: "i", status: "dismissed" }).status).toBe("dismissed");
  });
  it("director_register yields a token the Director branch recognises", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-wiring-")); dirs.push(directory);
    const endpoint = new DirectorEndpoint({ directory, repositoryRoot: directory, feed: { read: () => ({ items: [] }) },
      inspect: async () => ({}), coordinator: { invoke: async () => null } });
    const { token } = await endpoint.register(DIRECTOR_OWNER_METHODS.director_register.parse({ provider: "claude" }));
    expect(isDirectorCredential(token, "f".repeat(64))).toBe(true);
  });
  it("presence() gates the Runtime director port and mailbox delivery is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-wiring-")); dirs.push(directory);
    const endpoint = new DirectorEndpoint({ directory, repositoryRoot: directory, feed: { read: () => ({ items: [] }) },
      inspect: async () => ({}), coordinator: { invoke: async () => null } });
    // The same composition the host passes as ports.director in a v3 session.
    const port = { deliver: (message: RoleMessage) => endpoint.deliverRuntimeMessage(message),
      present: async () => (await endpoint.presence()) !== "absent" };
    expect(await endpoint.presence()).toBe("absent");
    expect(await port.present()).toBe(false);
    await endpoint.register(DIRECTOR_OWNER_METHODS.director_register.parse({ provider: "claude" }));
    expect(await endpoint.presence()).toBe("active");
    expect(await port.present()).toBe(true);
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "status-1", correlation_id: "corr-1", run_id: "run-1",
      sender: { role: "planner" }, recipient: { role: "coordinator" }, type: "task.status", artifact_references: [],
      payload: { status: "blocked", taskId: "task-1" }, occurred_at: "2026-11-03T10:00:00.000Z", idempotency_key: "status-1" });
    await port.deliver(message); await port.deliver(message);
    expect(await endpoint.readMailbox({ audience: "director" })).toEqual([expect.objectContaining({ messageId: "status-1", audience: "director", taskId: "task-1" })]);
  });
});
