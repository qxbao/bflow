import { mkdtemp, readFile, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableGatewayCallLedger } from "../src/durable-ledger.js";
import { validateJsonSchema } from "../src/tool-definitions.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("durable Gateway call ledger", () => {
  it("rejects input that violates a discovered operation schema", () => {
    const schema = { type: "object", required: ["wing", "query"], additionalProperties: false,
      properties: { wing: { type: "string", enum: ["approved-wing"] }, query: { type: "string", minLength: 1 } } };
    expect(validateJsonSchema({ wing: "approved-wing", query: "context" }, schema)).toBe(true);
    expect(validateJsonSchema({ wing: "other-wing", query: "context" }, schema)).toBe(false);
    expect(validateJsonSchema({ wing: "approved-wing" }, schema)).toBe(false);
  });

  it("restarts an intent as unknown so the caller cannot replay the side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-"));
    roots.push(root);
    const path = join(root, "calls.jsonl");
    const call = {
      schemaVersion: 3 as const,
      registrationId: "reg-1",
      serviceId: "memory-service",
      tool: "search_memory",
      input: { wing: "approved-wing", query: "prior decision" },
      callId: "call-1",
      idempotencyKey: "idem-1",
    };
    new DurableGatewayCallLedger(path).recordIntent(call);

    const restarted = new DurableGatewayCallLedger(path);
    const recovered = restarted.get(call.callId);
    expect(recovered?.registrationId).toBe(call.registrationId);
    expect(recovered?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(recovered?.result.status).toBe("unknown");
    expect(await readFile(path, "utf8")).not.toContain("prior decision");
  });

  it("stores only result digests and reports response unavailable after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-output-"));
    roots.push(root);
    const path = join(root, "calls.jsonl");
    const ledger = new DurableGatewayCallLedger(path);
    const call = { schemaVersion: 3 as const, callId: "call-result", registrationId: "reg-1", serviceId: "memory-service",
      tool: "mempalace_search", input: { wing: "approved-wing", query: "private query" }, idempotencyKey: "idem-2" };
    ledger.recordIntent(call);
    ledger.recordResult(call.callId, { schemaVersion: 3, callId: call.callId, status: "completed",
      output: { content: "private memory body" }, observedAt: new Date().toISOString() });

    const persisted = await readFile(path, "utf8");
    expect(persisted).not.toContain("private query");
    expect(persisted).not.toContain("private memory body");
    expect(new DurableGatewayCallLedger(path).get(call.callId)?.result)
      .toMatchObject({ status: "unknown", output: { diagnosticCode: "gateway_response_unavailable_after_restart" } });
  });

  it("pins a service schema by revision and blocks same-revision drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-schema-"));
    roots.push(root);
    const path = join(root, "calls.jsonl");
    const ledger = new DurableGatewayCallLedger(path);
    const pin = { serviceId: "memory-service", revision: 1, serviceConfigDigest: "a".repeat(64), schemaDigest: "b".repeat(64) };
    expect(ledger.pinServiceSchema(pin)).toBe(true);
    expect(ledger.pinServiceSchema(pin)).toBe(true);
    expect(ledger.pinServiceSchema({ ...pin, schemaDigest: "c".repeat(64) })).toBe(false);
    expect(new DurableGatewayCallLedger(path).pinServiceSchema({ ...pin, schemaDigest: "c".repeat(64) })).toBe(false);
    expect(new DurableGatewayCallLedger(path).pinServiceSchema({ ...pin, revision: 2, schemaDigest: "c".repeat(64) })).toBe(true);
  });

  it("refuses a symlink ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-link-"));
    roots.push(root);
    const target = join(root, "target.jsonl");
    const path = join(root, "calls.jsonl");
    await writeFile(target, "");
    await symlink(target, path);
    expect(() => new DurableGatewayCallLedger(path)).toThrow();
  });

  it("atomically claims an intent even when a second ledger instance has a stale snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-two-instances-"));
    roots.push(root);
    const path = join(root, "calls.jsonl");
    const first = new DurableGatewayCallLedger(path);
    const second = new DurableGatewayCallLedger(path);
    const call = { schemaVersion: 3 as const, callId: "shared-call", registrationId: "reg-1", serviceId: "svc-1",
      tool: "query", input: { q: "same call" }, idempotencyKey: "idem-shared" };
    first.recordIntent(call);
    expect(() => second.recordIntent(call)).toThrow(/already durable/);
    expect((await readFile(path, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it.each(["", "{"])("recovers a legacy lock left %s by a crashed owner", async (contents) => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-crash-lock-"));
    roots.push(root);
    await chmod(root, 0o700);
    const path = join(root, "calls.jsonl");
    await writeFile(`${path}.lock`, contents, { mode: 0o600 });
    const ledger = new DurableGatewayCallLedger(path);
    expect(ledger.pinServiceSchema({ serviceId: "svc", revision: 1, serviceConfigDigest: "a".repeat(64), schemaDigest: "b".repeat(64) })).toBe(true);
  });

  it("does not steal a complete live owner lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-ledger-live-lock-"));
    roots.push(root);
    await chmod(root, 0o700);
    const path = join(root, "calls.jsonl");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }), { mode: 0o600 });
    expect(() => new DurableGatewayCallLedger(path)).toThrow(/EEXIST/);
  });
});
