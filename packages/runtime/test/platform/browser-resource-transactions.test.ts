import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClientRegistrationSchema, MCPResourceLeaseSchema, type MCPResourceLease, type MCPToolCall,
  type MCPToolCallResult, type OperationResult } from "@bflow/contracts";
import { BrowserResourceTransactions } from "../../src/platform/browser-resource-transactions.js";
import type { GatewayControlPort, PlatformSessionIdentity } from "../../src/platform/ports.js";

const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
const scope = { kind: "session" as const, machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" };
const registration = (role = "tester", id = "registration-tester") => MCPClientRegistrationSchema.parse({ schemaVersion: 3,
  registrationId: id, role, provider: "codex", environmentId: `env-${role}`, scope, serviceIds: ["chrome-service"],
  allowedTools: ["list_pages", "navigate_page"], configDigest: "a".repeat(64), expiresAt: "2026-10-25T12:00:00.000Z",
  idempotencyKey: id, connection: { transport: "streamable_http", endpoint: "http://127.0.0.1:7777/mcp", token: "secret://bflow/test" } });

describe("browser resource transactions", () => {
  let root: string, identity: PlatformSessionIdentity, now: Date, active: MCPResourceLease | undefined;
  let acquired: number, released: number, renewed: number, dispatches: MCPToolCall[], reconciliations: MCPToolCall[];
  let outcome: "completed" | "unknown" | "throw" | "malformed";
  let control: GatewayControlPort;
  let transactions: BrowserResourceTransactions;
  const transaction = { id: "run-1-attempt-1", resourceKey: "actual-chrome-profile" };
  const call = (callId: string, registrationId = "registration-tester"): MCPToolCall => ({ schemaVersion: 3, callId,
    idempotencyKey: callId, registrationId, serviceId: "chrome-service", tool: "navigate_page", input: { url: "https://example.test" } });
  const invoke = (id: string, reconcile = false) => transactions.invoke(identity, registration(), call(id), transaction, reconcile);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bflow-browser-transactions-"));
    identity = { ...scope, generation: 1, stateDirectory: root };
    now = new Date("2026-10-25T10:00:00.000Z");
    acquired = released = renewed = 0; dispatches = []; reconciliations = []; outcome = "completed"; active = undefined;
    control = {
      async acquireResource(request) {
        if (active && Date.parse(active.expiresAt) > now.getTime()) {
          if (active.registrationId === request.registrationId) return ok(active);
          return { ok: false, error: { code: "conflict", retryable: true, message: "busy", details: { diagnosticCode: "resource_busy" } } };
        }
        acquired++;
        active = MCPResourceLeaseSchema.parse({ schemaVersion: 3, leaseId: `lease-${acquired}`,
          registrationId: request.registrationId, serviceId: request.serviceId, resourceKey: request.resourceKey,
          fencingToken: acquired, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + request.ttlMs).toISOString() });
        return ok(active);
      },
      async renewResource(request) {
        renewed++;
        if (!active || request.lease.leaseId !== active.leaseId) throw new Error("stale lease");
        active = MCPResourceLeaseSchema.parse({ ...active, expiresAt: new Date(now.getTime() + request.ttlMs).toISOString() });
        return ok(active);
      },
      async releaseResource(lease) { expect(lease.leaseId).toBe(active?.leaseId); released++; active = undefined; return ok(undefined); },
      async invokeTool(request) {
        // The durable intent and its exact lease must exist BEFORE any upstream side effect.
        const ledger = await readFile(join(root, "gen-1", "browser-resource-transactions.json"), "utf8");
        expect(ledger).toContain(request.callId); expect(ledger).toContain(request.resourceLease!.leaseId);
        expect(request.resourceLease).toEqual(active); dispatches.push(request);
        if (outcome === "throw") throw new Error("network lost");
        if (outcome === "malformed") return ok({ callId: "wrong" } as MCPToolCallResult);
        return ok({ schemaVersion: 3, callId: request.callId, status: outcome, output: {}, observedAt: now.toISOString() });
      },
      async reconcileToolCall(request) { reconciliations.push(request); return ok({ schemaVersion: 3,
        callId: request.callId, status: outcome === "unknown" ? "unknown" : "completed", output: {}, observedAt: now.toISOString() }); }
    } as GatewayControlPort;
    transactions = new BrowserResourceTransactions(control, () => now);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("holds the actual resource lease across operations and releases at transaction completion", async () => {
    expect((await invoke("first")).ok).toBe(true);
    expect(released).toBe(0);
    now = new Date(now.getTime() + 10_000);
    expect((await invoke("second")).ok).toBe(true);
    expect(acquired).toBe(1); expect(renewed).toBe(1);
    expect(dispatches[1]!.resourceLease!.resourceKey).toBe("actual-chrome-profile");
    expect(await transactions.finish(identity, "tester", transaction.id)).toEqual(ok(undefined));
    expect(released).toBe(1);
  });
  it("does not interleave another role's transaction on the same browser", async () => {
    await invoke("tester-first");
    const qa = registration("qa", "registration-qa");
    expect((await transactions.invoke(identity, qa, call("qa-first", qa.registrationId), { ...transaction, id: "qa-attempt" }, false)).ok).toBe(false);
    expect(dispatches).toHaveLength(1);
    await transactions.finish(identity, "tester", transaction.id);
    expect((await transactions.invoke(identity, qa, call("qa-first", qa.registrationId), { ...transaction, id: "qa-attempt" }, false)).ok).toBe(true);
  });
  it.each(["unknown", "throw", "malformed"] as const)("retains %s delivery and blocks new mutations until exact reconciliation", async status => {
    outcome = status;
    await invoke("uncertain");
    expect(released).toBe(0);
    expect((await invoke("next")).ok).toBe(false);
    expect((await invoke("uncertain")).ok).toBe(false);
    expect((await transactions.finish(identity, "tester", transaction.id)).ok).toBe(false);
    expect(dispatches).toHaveLength(1);
    outcome = "completed";
    expect((await invoke("uncertain", true)).ok).toBe(true);
    expect(reconciliations[0]).toEqual(dispatches[0]);
    expect((await invoke("next")).ok).toBe(true);
  });
  it("loads the original pending lease after restart without acquiring or resending", async () => {
    outcome = "unknown"; await invoke("before-restart");
    transactions = new BrowserResourceTransactions(control, () => now);
    expect((await invoke("another-call")).ok).toBe(false);
    outcome = "completed";
    expect((await invoke("before-restart", true)).ok).toBe(true);
    expect(reconciliations[0]).toEqual(dispatches[0]);
    expect(acquired).toBe(1); expect(dispatches).toHaveLength(1);
  });
  it("reconciles the original call lease even after a later renewal", async () => {
    outcome = "unknown"; await invoke("first");
    outcome = "completed"; await invoke("first", true);
    now = new Date(now.getTime() + 10_000); await invoke("second");
    await invoke("first", true);
    expect(reconciliations[1]).toEqual(dispatches[0]);
  });
  it("rejects changed input and a wrong principal for a known call ID", async () => {
    outcome = "unknown"; await invoke("known");
    expect((await transactions.invoke(identity, registration(), { ...call("known"), input: {} }, transaction, true)).ok).toBe(false);
    const qa = registration("qa", "registration-qa");
    expect((await transactions.invoke(identity, qa, call("known", qa.registrationId), transaction, true)).ok).toBe(false);
    expect(reconciliations).toHaveLength(0);
  });
  it("blocks a different attempt from reusing the same registration's browser lease", async () => {
    await invoke("first");
    expect((await transactions.invoke(identity, registration(), call("new-attempt"), { ...transaction, id: "attempt-2" }, false)).ok).toBe(false);
    expect(dispatches).toHaveLength(1);
  });
  it("settles a definitive pre-dispatch rejection so completion can release the lease", async () => {
    control.invokeTool = async () => ({ ok: false, error: { code: "validation", retryable: false, message: "input schema rejected" } });
    expect((await invoke("invalid")).ok).toBe(false);
    expect((await transactions.finish(identity, "tester", transaction.id)).ok).toBe(true);
    expect(released).toBe(1);
  });
  it("never reacquires an expired transaction or revives a closed transaction", async () => {
    await invoke("first");
    now = new Date(now.getTime() + 301_000);
    expect((await invoke("late")).ok).toBe(false); expect(acquired).toBe(1);
    await transactions.finish(identity, "tester", transaction.id);
    expect((await invoke("after-close")).ok).toBe(false);
  });
  it("lets another assignment acquire the browser after an abandoned transaction's lease expired", async () => {
    await invoke("first");
    const qa = registration("qa", "registration-qa");
    now = new Date(now.getTime() + 301_000);
    expect((await transactions.invoke(identity, qa, call("qa-late", qa.registrationId), { ...transaction, id: "qa-attempt" }, false)).ok).toBe(true);
    expect(acquired).toBe(2);
  });
  it("keeps an expired transaction with unresolved delivery as the browser owner", async () => {
    outcome = "unknown"; await invoke("pending");
    const qa = registration("qa", "registration-qa");
    now = new Date(now.getTime() + 301_000);
    expect((await transactions.invoke(identity, qa, call("qa-late", qa.registrationId), { ...transaction, id: "qa-attempt" }, false)).ok).toBe(false);
    expect(acquired).toBe(1);
  });
  it("rejects a mismatched lease response before dispatch", async () => {
    const acquire = control.acquireResource!;
    control.acquireResource = async (...args) => { const result = await acquire(...args); return result.ok ? ok({ ...result.value, resourceKey: "wrong-profile" }) : result; };
    expect((await invoke("forged")).ok).toBe(false); expect(dispatches).toHaveLength(0);
  });
  it("reports settlement storage failure as unknown delivery and recovers from the durable intent", async () => {
    const dispatch = control.invokeTool;
    control.invokeTool = async (...args) => {
      const result = await dispatch(...args);
      await rename(join(root, "gen-1"), join(root, "saved-gen-1"));
      // Force settlement I/O failure while retaining the original durable intent for recovery.
      await import("node:fs/promises").then(fs => fs.writeFile(join(root, "gen-1"), "blocked"));
      return result;
    };
    const result = await invoke("storage-failure");
    expect(result).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
    await rm(join(root, "gen-1")); await rename(join(root, "saved-gen-1"), join(root, "gen-1"));
    expect((await invoke("storage-failure", true)).ok).toBe(true);
    expect(dispatches).toHaveLength(1);
  });
  it("observes pending calls before lifecycle release and preserves authority while still unknown", async () => {
    outcome = "unknown"; await invoke("pending-shutdown");
    expect((await transactions.finish(identity, "tester", undefined, registration().registrationId, true)).ok).toBe(false);
    expect(released).toBe(0); expect(reconciliations[0]).toEqual(dispatches[0]);
    outcome = "completed";
    expect((await transactions.finish(identity, "tester", undefined, registration().registrationId, true)).ok).toBe(true);
    expect(released).toBe(1); expect(dispatches).toHaveLength(1);
  });
  it("does not treat missing reconciliation evidence as proof of non-delivery", async () => {
    outcome = "unknown"; await invoke("pending-reconcile");
    control.reconcileToolCall = async () => ({ ok: false, error: { code: "not_found", retryable: false, message: "call ledger unavailable" } });
    expect(await invoke("pending-reconcile", true)).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
    expect((await transactions.finish(identity, "tester", undefined, registration().registrationId, true)).ok).toBe(false);
    expect(released).toBe(0);
  });
  it("keeps release failure visible and blocks further calls", async () => {
    await invoke("first");
    control.releaseResource = async () => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost release" } });
    expect((await transactions.finish(identity, "tester", transaction.id)).ok).toBe(false);
    expect((await invoke("after-release")).ok).toBe(false);
  });
});
