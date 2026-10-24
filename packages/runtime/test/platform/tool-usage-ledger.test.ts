import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileToolUsageLedger } from "../../src/platform/tool-usage-ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Runtime tool action ledger", () => {
  it("preserves an interrupted invocation as unknown and refuses automatic replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-"));
    roots.push(root);
    const path = join(root, "usage.json");
    const ledger = new FileToolUsageLedger(path);
    const intent = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-a", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    await ledger.begin(intent);
    const recovered = new FileToolUsageLedger(path);
    await recovered.recoverInterrupted();
    await expect(recovered.begin(intent)).rejects.toThrow(/unknown|already/);
    expect(await readFile(path, "utf8")).not.toContain("secret");
    expect((await recovered.list()).map(item => item.status)).toEqual(["unknown"]);
  });

  it("does not turn a live in-flight invocation into unknown during an ordinary read", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-live-"));
    roots.push(root);
    const ledger = new FileToolUsageLedger(join(root, "usage.json"));
    const intent = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-live", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    await ledger.begin(intent);

    expect((await ledger.list()).map(item => item.status)).toEqual(["started"]);
    expect(JSON.parse(await readFile(join(root, "usage.json"), "utf8")).records[0].status).toBe("started");
  });

  it("only recovers interrupted intents through an explicit startup recovery pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-recovery-"));
    roots.push(root);
    const path = join(root, "usage.json");
    const intent = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-recover", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    const ledger = new FileToolUsageLedger(path);
    await ledger.begin(intent);

    await new FileToolUsageLedger(path).recoverInterrupted();

    expect((await ledger.list()).map(item => item.status)).toEqual(["unknown"]);
    expect(JSON.parse(await readFile(path, "utf8")).records[0].status).toBe("unknown");
  });

  it("keeps invocation identity immutable and requires reconciliation to settle unknown delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-identity-"));
    roots.push(root);
    const path = join(root, "usage.json");
    const ledger = new FileToolUsageLedger(path);
    const started = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-immutable", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    await ledger.begin(started);
    await ledger.recoverInterrupted();
    const altered = { ...started, serviceId: "other-service", status: "completed" as const };
    await expect(ledger.put(altered)).rejects.toThrow(/identity/);
    await expect(ledger.put({ ...started, status: "completed" })).rejects.toThrow(/transition/);

    await expect(ledger.reconcileUnknown({ ...started, status: "completed" }, {
      schemaVersion: 3, callId: "another-call", status: "completed", output: null, observedAt: new Date().toISOString()
    })).rejects.toThrow(/invocation ID/);
    await expect(ledger.reconcileUnknown({ ...started, generation: 3, status: "completed" }, {
      schemaVersion: 3, callId: started.invocationId, status: "completed", output: { ok: true }, observedAt: new Date().toISOString()
    })).rejects.toThrow(/identity/);
    await ledger.reconcileUnknown({ ...started, status: "completed" }, {
      schemaVersion: 3, callId: started.invocationId, status: "completed", output: { ok: true }, observedAt: new Date().toISOString()
    });
    expect((await ledger.list())[0]).toMatchObject({ status: "completed", generation: 2, invocationId: started.invocationId });
  });

  it("records consumption only after a completed result is linked to stored task evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-consumed-"));
    roots.push(root);
    const ledger = new FileToolUsageLedger(join(root, "usage.json"));
    const started = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-consumed", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    await ledger.begin(started);
    const completed = { ...started, status: "completed" as const };
    await ledger.put(completed);
    const evidence = { trust: "stored" as const, artifactId: "memory-output", runId: "run-a", taskId: "task-a",
      kind: "agent-output" as const, uri: "artifact://store-a/memory-output", mediaType: "application/json",
      checksum: { algorithm: "sha256" as const, value: "a".repeat(64) }, createdAt: new Date().toISOString() };

    await ledger.consume({ ...completed, evidenceReferences: [evidence],
      consumption: { status: "consumed", source: "host_context", evidenceReferences: [evidence] } });

    expect((await ledger.list())[0]?.consumption).toMatchObject({ status: "consumed", source: "host_context" });
    await expect(ledger.put({ ...completed, consumption: { status: "consumed", source: "host_context", evidenceReferences: [evidence] } }))
      .rejects.toThrow(/transition/);
  });

  it("stores delivery uncertainty as not_used without claiming consumption", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-tool-ledger-not-used-"));
    roots.push(root);
    const ledger = new FileToolUsageLedger(join(root, "usage.json"));
    const started = { schemaVersion: 3 as const, runId: "run-a", taskId: "task-a", role: "developer" as const,
      sessionId: "session-a", generation: 2, invocationId: "action-delivery-pending", toolId: "memory", serviceId: "memory-service",
      operation: "search", status: "started" as const, observedAt: new Date().toISOString() };
    await ledger.begin(started);
    const completed = { ...started, status: "completed" as const };
    await ledger.put(completed);
    await ledger.notUsed({ ...completed, consumption: { status: "not_used", reasonCode: "provider_delivery_unconfirmed" } });
    expect((await ledger.list())[0]?.consumption).toEqual({ status: "not_used", reasonCode: "provider_delivery_unconfirmed" });
  });
});
