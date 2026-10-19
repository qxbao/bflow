import { describe, expect, it } from "vitest";
import { SessionManifestSchema, type AgentRole, type OperationResult } from "@bflow/contracts";
import { RoleStartupChecks } from "../src/role-startup-checks.js";

const roles: AgentRole[] = ["conversation", "coordinator", "planner", "reviewer", "qa"];
const ready: OperationResult<void> = { ok: true, value: undefined };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const flush = () => new Promise<void>(accept => setImmediate(accept));
function manifest() {
  const at = new Date().toISOString();
  return SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session", workspaceRoot: "/repo", projectName: "repo",
    herdrWorkspaceId: "w1", herdrTabId: "t1", status: "initializing", conversationSessionId: "chat", activeRunIds: [],
    attachTarget: { role: "conversation", paneId: "p0" }, createdAt: at, updatedAt: at,
    panes: roles.map((role, index) => ({ schemaVersion: 2, bindingId: `binding-${index}`, sessionId: "session", role, agentId: `agent-${index}`,
      paneId: `p${index}`, workspaceId: "w1", tabId: "t1", cwd: "/repo", provider: "codex", agentKind: "codex", readOnlyWorkspace: true,
      permanent: true, session: { source: "herdr:codex", kind: "id", value: `native-${index}` }, isolationMode: "dedicated_pane", transportState: "idle", boundAt: at })) });
}

describe("progressive role health publication queue", () => {
  it("bounds and deduplicates checks while publications remain synchronous, and drain waits for queued roles", async () => {
    const gates = roles.map(() => deferred<OperationResult<void>>());
    const started: AgentRole[] = [];
    const checks = new RoleStartupChecks(roles, async (_manifest, role) => { started.push(role); return gates[roles.indexOf(role)]!.promise; });
    const snapshot = manifest();
    checks.published(snapshot); checks.published(snapshot);
    await flush();
    expect(started).toEqual(["conversation", "coordinator", "planner"]);
    let drained = false;
    const draining = checks.drain().then(result => { drained = true; return result; });
    gates[1]!.resolve(ready); await flush();
    expect(started).toEqual(["conversation", "coordinator", "planner", "reviewer"]);
    expect(drained).toBe(false);
    for (const gate of gates) gate.resolve(ready);
    expect(await draining).toEqual(ready);
    expect(started).toEqual(roles);
    checks.published(snapshot); await flush();
    expect(started).toHaveLength(5);
  });

  it("stops queued checks after terminal failure, drains started work and reports configured-order failures", async () => {
    const gates = roles.map(() => deferred<OperationResult<void>>());
    const started: AgentRole[] = [];
    const checks = new RoleStartupChecks(roles, async (_manifest, role) => { started.push(role); return gates[roles.indexOf(role)]!.promise; });
    checks.published(manifest()); await flush();
    const draining = checks.drain();
    gates[2]!.resolve({ ok: false, error: { code: "validation", retryable: false, message: "planner failed" } });
    await flush();
    expect(started).toHaveLength(3);
    gates[0]!.resolve({ ok: false, error: { code: "validation", retryable: false, message: "conversation failed" } });
    gates[1]!.resolve(ready);
    expect(await draining).toMatchObject({ ok: false, error: { message: "conversation failed" } });
    checks.published(manifest()); await flush();
    expect(started).toHaveLength(3);
  });

  it("leaves pending native startup to final activation but preserves thrown health failures", async () => {
    const checks = new RoleStartupChecks(roles, async (_manifest, role) => {
      if (role === "conversation") return { ok: false, error: { code: "conflict", retryable: true, message: "hook pending", details: { stage: "native_startup" } } };
      if (role === "coordinator") throw new Error("health failed");
      return ready;
    });
    checks.published(manifest());
    expect(await checks.drain()).toMatchObject({ ok: false, error: { message: "Error: health failed" } });
  });

  it("does not run queued checks after cancellation and reports cancellation after started probes drain", async () => {
    const controller = new AbortController(), gate = deferred<OperationResult<void>>();
    const started: AgentRole[] = [];
    const checks = new RoleStartupChecks(roles, async (_manifest, role) => { started.push(role); return gate.promise; });
    checks.published(manifest(), { signal: controller.signal }); await flush();
    controller.abort();
    const draining = checks.drain();
    gate.resolve(ready);
    expect(await draining).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(started).toHaveLength(3);
  });

  it("drains in-flight health before stop completes and discards work not yet started", async () => {
    const gate = deferred<OperationResult<void>>();
    const started: AgentRole[] = [];
    const checks = new RoleStartupChecks(roles, async (_manifest, role) => { started.push(role); return gate.promise; });
    checks.published(manifest()); await flush();
    let stopped = false;
    const stop = checks.drain(true).then(result => { stopped = true; return result; });
    await flush(); expect(stopped).toBe(false);
    gate.resolve(ready); expect(await stop).toEqual(ready);
    checks.published(manifest()); await flush();
    expect(started).toHaveLength(3);
  });
});
