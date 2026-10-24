import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContractError, MCPClientRegistration, MCPServiceObservation, OperationOptions, OperationResult, ResolvedToolGrant, ScopedOperation, TrustScope
} from "@bflow/contracts";
import { failWith, ok } from "../../src/platform/errors.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import type {
  GatewayControlPort, GatewayRegistrationGrant, GatewayRoleRequest, PlatformSessionIdentity
} from "../../src/platform/ports.js";

const ENDPOINT = "http://127.0.0.1:7777/mcp";
const CONFIG_DIGEST = "a".repeat(64);

/** In-memory Gateway with real registration state; failures are injected one call at a time. */
class FakeGatewayControl implements GatewayControlPort {
  readonly registrations = new Map<string, { registration: MCPClientRegistration; bearerToken: string }>();
  readonly revokeCalls: string[] = [];
  readonly registeredGrants: (readonly ResolvedToolGrant[])[] = [];
  services: MCPServiceObservation[] = [];
  registerCalls = 0;
  inspectCalls = 0;
  /** Stores the registration, then reports this error: the side effect happened but the reply was lost. */
  failNextRegisterAfterStore: ContractError | undefined;
  /** Returns a registration whose endpoint differs from what was sent. */
  mismatchNextRegister = false;
  /** Fails the next revoke with this error without touching state. */
  failNextRevoke: ContractError | undefined;
  onRegister: ((registration: MCPClientRegistration) => void) | undefined;
  /** Fails the next list with this error without touching state. */
  failNextList: ContractError | undefined;
  listCalls = 0;
  /** The real Gateway control answers `validation` for a registration it does not know (e.g. after its restart). */
  unknownRevokeCode: "not_found" | "validation" = "not_found";

  /** Simulates a Gateway daemon restart: every registration and its bearer token is gone. */
  restart(): void {
    this.registrations.clear();
  }

  async register(registration: MCPClientRegistration, _options?: OperationOptions, grants: readonly ResolvedToolGrant[] = []):
    Promise<OperationResult<GatewayRegistrationGrant>> {
    this.registerCalls += 1;
    this.onRegister?.(registration);
    this.registeredGrants.push(grants);
    if (this.registrations.has(registration.registrationId)) {
      return failWith({ code: "conflict", retryable: true, message: "registration already exists" });
    }
    const bearerToken = randomBytes(24).toString("hex");
    const echoed = this.mismatchNextRegister
      ? { ...registration, connection: { ...registration.connection, endpoint: "http://127.0.0.1:9999/mcp" } }
      : registration;
    this.mismatchNextRegister = false;
    this.registrations.set(registration.registrationId, { registration: echoed, bearerToken });
    const failure = this.failNextRegisterAfterStore;
    this.failNextRegisterAfterStore = undefined;
    if (failure) return failWith(failure);
    return ok({ registration: echoed, bearerToken });
  }

  async revoke(registrationId: string, _operation: ScopedOperation, _options?: OperationOptions):
    Promise<OperationResult<void>> {
    this.revokeCalls.push(registrationId);
    if (this.failNextRevoke) {
      const failure = this.failNextRevoke;
      this.failNextRevoke = undefined;
      return failWith(failure);
    }
    if (!this.registrations.has(registrationId)) {
      return failWith({ code: this.unknownRevokeCode, retryable: false, message: "registration not found" });
    }
    this.registrations.delete(registrationId);
    return ok(undefined);
  }

  async list(scope: TrustScope, _options?: OperationOptions): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    this.listCalls += 1;
    if (this.failNextList) {
      const failure = this.failNextList;
      this.failNextList = undefined;
      return failWith(failure);
    }
    const listed = [...this.registrations.values()].map(entry => entry.registration)
      .filter(registration => JSON.stringify(registration.scope) === JSON.stringify(scope));
    return ok(listed);
  }

  async inspectServices(_operation: ScopedOperation, _options?: OperationOptions):
    Promise<OperationResult<readonly MCPServiceObservation[]>> {
    this.inspectCalls += 1;
    return ok(this.services);
  }
}

function observation(serviceId: string, overrides: Partial<MCPServiceObservation> = {}): MCPServiceObservation {
  return {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    instanceId: `${serviceId}-instance`,
    status: "ready",
    protocolVersion: "2025-06-18",
    discoveredTools: ["search", "read"],
    ownership: "bflow",
    activeClientCount: 0,
    observedAt: "2026-10-18T00:00:00.000Z",
    diagnosticCode: "ok",
    ...overrides
  };
}

function request(overrides: Partial<GatewayRoleRequest> = {}): GatewayRoleRequest {
  return {
    role: "developer",
    provider: "claude",
    taskId: "task-1",
    environmentId: "env-developer-task-1",
    serviceIds: ["svc-search"],
    allowedTools: ["search"],
    configDigest: CONFIG_DIGEST,
    ...overrides
  };
}

describe("GatewayRegistrationManager", () => {
  let root: string;
  let identity: PlatformSessionIdentity;
  let control: FakeGatewayControl;
  let now: Date;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bflow-gateway-registrations-"));
    identity = {
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot: "/work/repo",
      sessionId: "session-1",
      generation: 1,
      stateDirectory: join(root, "state")
    };
    control = new FakeGatewayControl();
    control.services = [observation("svc-search")];
    now = new Date("2026-10-18T00:00:00.000Z");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function manager(): GatewayRegistrationManager {
    return new GatewayRegistrationManager({ control, endpoint: ENDPOINT, now: () => now });
  }

  function ledgerPath(): string {
    return join(identity.stateDirectory, "gen-1", "gateway-registrations.json");
  }

  async function readLedger(): Promise<string> {
    return readFile(ledgerPath(), "utf8");
  }

  it("returns an empty access without calling the Gateway when no services are requested", async () => {
    const result = await manager().ensureForRole(identity, request({ serviceIds: [], allowedTools: [] }));

    expect(result).toEqual({ ok: true, value: { registrations: [], observations: [], tokenEnvironment: {} } });
    expect(control.inspectCalls).toBe(0);
    expect(control.registerCalls).toBe(0);
  });

  it("persists the intent entry before register is called", async () => {
    let stateAtRegister: string | undefined;
    control.onRegister = registration => {
      const ledger = JSON.parse(readFileSync(ledgerPath(), "utf8")) as { entries: Record<string, { state: string }> };
      stateAtRegister = ledger.entries[registration.registrationId]?.state;
    };

    const result = await manager().ensureForRole(identity, request());

    expect(result.ok).toBe(true);
    expect(stateAtRegister).toBe("intent");
  });

  it("passes only the exact resolved grant set with the registration request", async () => {
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-search", policyDigest: CONFIG_DIGEST,
      toolId: "memory-search", kind: "native_remote_mcp", requiredness: "optional", role: "developer",
      scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["prior_context"], serviceId: "svc-search", operations: ["search"] };
    const result = await manager().ensureForRole(identity, request({ toolGrants: [grant] }));

    expect(result.ok).toBe(true);
    expect(control.registeredGrants).toEqual([[grant]]);
  });

  it("returns the bearer token under a sanitized environment name and keeps it out of the ledger", async () => {
    const result = await manager().ensureForRole(identity, request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [registration] = result.value.registrations;
    expect(registration?.registrationId).toMatch(/^reg-[0-9a-f]{32}$/);
    expect(registration?.connection).toEqual({
      transport: "streamable_http",
      endpoint: ENDPOINT,
      token: `secret://bflow/session-1/${registration?.registrationId}`
    });
    expect(registration?.scope).toEqual({
      kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/work/repo", sessionId: "session-1"
    });

    const suffix = (registration?.registrationId ?? "").slice(4).toUpperCase();
    const names = Object.keys(result.value.tokenEnvironment);
    expect(names).toEqual([`BFLOW_MCP_TOKEN_${suffix}`]);
    expect(names[0]?.length).toBeLessThanOrEqual(64);
    expect(/^[A-Z0-9_]+$/.test(names[0] ?? "")).toBe(true);

    const bearer = [...control.registrations.values()][0]?.bearerToken ?? "";
    expect(result.value.tokenEnvironment[names[0] ?? ""]).toBe(bearer);
    expect(result.value.observations.map(item => item.serviceId)).toEqual(["svc-search"]);

    const ledger = await readLedger();
    expect(ledger).not.toContain(bearer);
    expect(JSON.parse(ledger).entries[registration?.registrationId ?? ""].state).toBe("registered");
    expect(JSON.parse(ledger).schemaVersion).toBe(3);
  });

  it("writes the ledger file with owner-only permissions", async () => {
    await manager().ensureForRole(identity, request());

    expect((await stat(ledgerPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(identity.stateDirectory, "gen-1"))).mode & 0o777).toBe(0o700);
  });

  it("returns the cached token without registering again while it is fresh", async () => {
    const gateway = manager();
    const first = await gateway.ensureForRole(identity, request());
    const second = await gateway.ensureForRole(identity, request());

    expect(control.registerCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it("fails before register when a requested service is not ready", async () => {
    control.services = [observation("svc-search", { status: "starting" })];

    const result = await manager().ensureForRole(identity, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.details).toEqual({ missingServices: ["svc-search"], missingTools: [] });
    expect(control.registerCalls).toBe(0);
  });

  it("fails before register when a requested tool is not discovered", async () => {
    control.services = [observation("svc-search", { discoveredTools: ["read"] })];

    const result = await manager().ensureForRole(identity, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.error.details).toEqual({ missingServices: [], missingTools: ["search"] });
    expect(control.registerCalls).toBe(0);
  });

  it("reconciles an uncertain register through list and revoke before registering again", async () => {
    const timeout: ContractError = { code: "timeout", retryable: true, retrySafety: "observation_only",
      message: "gateway reply lost" };
    control.failNextRegisterAfterStore = timeout;
    const gateway = manager();

    const first = await gateway.ensureForRole(identity, request());
    expect(first).toEqual({ ok: false, error: timeout });
    const failedId = [...control.registrations.keys()][0] ?? "";
    expect(JSON.parse(await readLedger()).entries[failedId].state).toBe("unknown");

    const second = await gateway.ensureForRole(identity, request());
    expect(second.ok).toBe(true);
    expect(control.revokeCalls).toEqual([failedId]);
    expect(control.registerCalls).toBe(2);
    expect(control.registrations.size).toBe(1);
    expect(JSON.parse(await readLedger()).entries[failedId].state).toBe("registered");
  });

  it("marks an acknowledged registration whose echo mismatches as unknown", async () => {
    control.mismatchNextRegister = true;
    const gateway = manager();

    const first = await gateway.ensureForRole(identity, request());
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe("corruption");
    expect(JSON.stringify(first.error)).not.toMatch(/[0-9a-f]{48}/);

    const id = [...control.registrations.keys()][0] ?? "";
    expect(JSON.parse(await readLedger()).entries[id].state).toBe("unknown");

    const second = await gateway.ensureForRole(identity, request());
    expect(second.ok).toBe(true);
    expect(control.revokeCalls).toEqual([id]);
  });

  it("revokes and registers again when a new manager instance finds a registration without its token", async () => {
    const first = await manager().ensureForRole(identity, request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldId = first.value.registrations[0]?.registrationId ?? "";
    const oldToken = first.value.tokenEnvironment[Object.keys(first.value.tokenEnvironment)[0] ?? ""];

    const restarted = await manager().ensureForRole(identity, request());

    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(control.revokeCalls).toEqual([oldId]);
    expect(control.registerCalls).toBe(2);
    expect(restarted.value.tokenEnvironment[Object.keys(restarted.value.tokenEnvironment)[0] ?? ""]).not.toBe(oldToken);
  });

  it("revokes every session registration and is idempotent", async () => {
    const gateway = manager();
    expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
    expect((await gateway.ensureForRole(identity, request({
      role: "coordinator", taskId: undefined, environmentId: "env-coordinator"
    }))).ok).toBe(true);
    expect(control.registrations.size).toBe(2);

    expect(await gateway.revokeSession(identity)).toEqual({ ok: true, value: undefined });
    expect(control.registrations.size).toBe(0);
    expect(control.revokeCalls).toHaveLength(2);

    expect(await gateway.revokeSession(identity)).toEqual({ ok: true, value: undefined });
    expect(control.revokeCalls).toHaveLength(2);
  });

  it("counts a Gateway not_found on revoke as revoked", async () => {
    const gateway = manager();
    const result = await gateway.ensureForRole(identity, request());
    expect(result.ok).toBe(true);
    const id = [...control.registrations.keys()][0] ?? "";
    control.registrations.delete(id);

    expect(await gateway.revokeRole(identity, "developer", "task-1")).toEqual({ ok: true, value: undefined });
    expect(JSON.parse(await readLedger()).entries[id].state).toBe("revoked");
  });

  it("marks an uncertain revoke as unknown and reports the failure", async () => {
    const gateway = manager();
    expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
    const id = [...control.registrations.keys()][0] ?? "";
    const failure: ContractError = { code: "transport_unavailable", retryable: true, message: "gateway unreachable" };
    control.failNextRevoke = failure;

    const result = await gateway.revokeSession(identity);

    expect(result).toEqual({ ok: false, error: failure });
    expect(JSON.parse(await readLedger()).entries[id].state).toBe("unknown");
  });

  it("refuses a corrupted ledger", async () => {
    await manager().ensureForRole(identity, request());
    await writeFile(ledgerPath(), "{not json", { mode: 0o600 });

    const result = await manager().ensureForRole(identity, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("corruption");
    expect(control.registerCalls).toBe(1);
  });

  it("refuses a ledger with a malformed entry", async () => {
    await manager().ensureForRole(identity, request());
    const raw = JSON.parse(await readLedger());
    const [id] = Object.keys(raw.entries);
    raw.entries[id ?? ""].state = "bogus";
    await writeFile(ledgerPath(), JSON.stringify(raw), { mode: 0o600 });

    const result = await manager().ensureForRole(identity, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("corruption");
  });

  it("rejects a non-positive registration lifetime at construction", () => {
    expect(() => new GatewayRegistrationManager({ control, endpoint: ENDPOINT, registrationTtlMs: 3_600_001 }))
      .toThrow(RangeError);
  });

  it("rejects an endpoint carrying credentials at construction", () => {
    expect(() => new GatewayRegistrationManager({ control, endpoint: "http://user:pw@127.0.0.1:7777/mcp" }))
      .toThrow(TypeError);
  });

  it("sends a fresh idempotency key per register attempt while keeping the registrationId deterministic", async () => {
    const sent: MCPClientRegistration[] = [];
    control.onRegister = registration => { sent.push(registration); };
    const gateway = manager();

    expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
    const firstId = sent[0]?.registrationId ?? "";
    expect((await gateway.revokeRole(identity, "developer", "task-1")).ok).toBe(true);
    expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);

    expect(sent).toHaveLength(2);
    const [first, second] = sent;
    expect(second?.registrationId).toBe(firstId);
    expect(first?.idempotencyKey).toMatch(new RegExp(`^${firstId}:[0-9a-f-]{36}$`));
    expect(second?.idempotencyKey).toMatch(new RegExp(`^${firstId}:[0-9a-f-]{36}$`));
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  describe("verifyRegistrations", () => {
    const coordinatorRequest = (): GatewayRoleRequest =>
      request({ role: "coordinator", taskId: undefined, environmentId: "env-coordinator" });

    it("reports healthy without calling the Gateway when no registrations are tracked", async () => {
      const result = await manager().verifyRegistrations(identity);

      expect(result).toEqual({ ok: true, value: { checkedAt: now.toISOString(), healthy: true, lost: [], uncertain: false } });
      expect(control.listCalls).toBe(0);
    });

    it("marks every registration lost after a Gateway restart, keeps the ledger free of tokens, and stays lost on re-read", async () => {
      const gateway = manager();
      const developer = await gateway.ensureForRole(identity, request());
      const coordinator = await gateway.ensureForRole(identity, coordinatorRequest());
      expect(developer.ok && coordinator.ok).toBe(true);
      const ids = [...control.registrations.keys()];
      const tokens = [...control.registrations.values()].map(entry => entry.bearerToken);

      control.restart();
      const verified = await gateway.verifyRegistrations(identity);

      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.healthy).toBe(false);
      expect(verified.value.uncertain).toBe(false);
      expect(verified.value.lost).toHaveLength(2);
      expect(verified.value.lost).toContainEqual({ registrationId: ids[0], role: "developer", taskId: "task-1" });
      expect(verified.value.lost).toContainEqual({ registrationId: ids[1], role: "coordinator" });

      const ledger = await readLedger();
      const entries = JSON.parse(ledger).entries;
      expect(entries[ids[0] ?? ""].state).toBe("lost");
      expect(entries[ids[1] ?? ""].state).toBe("lost");
      for (const token of tokens) {
        expect(ledger).not.toContain(token);
        expect(JSON.stringify(verified)).not.toContain(token);
      }

      // Re-reading the persisted `lost` state (backward-compatible parse) keeps reporting it.
      const reread = await manager().verifyRegistrations(identity);
      expect(reread.ok && reread.value.lost).toHaveLength(2);
      expect(reread.ok && reread.value.healthy).toBe(false);
    });

    it("keeps healthy registrations cached and marks only the missing one lost", async () => {
      const gateway = manager();
      const developer = await gateway.ensureForRole(identity, request());
      const coordinator = await gateway.ensureForRole(identity, coordinatorRequest());
      if (!developer.ok || !coordinator.ok) throw new Error("setup failed");
      const [developerId, coordinatorId] = [...control.registrations.keys()];
      control.registrations.delete(developerId ?? "");

      const verified = await gateway.verifyRegistrations(identity);

      expect(verified).toEqual({
        ok: true,
        value: {
          checkedAt: now.toISOString(),
          healthy: false,
          lost: [{ registrationId: developerId, role: "developer", taskId: "task-1" }],
          uncertain: false
        }
      });
      const entries = JSON.parse(await readLedger()).entries;
      expect(entries[developerId ?? ""].state).toBe("lost");
      expect(entries[coordinatorId ?? ""].state).toBe("registered");

      const cached = await gateway.ensureForRole(identity, coordinatorRequest());
      expect(cached).toEqual(coordinator);
      expect(control.registerCalls).toBe(2);
    });

    it("leaves the ledger unchanged and reports uncertain when the Gateway listing fails", async () => {
      const gateway = manager();
      const first = await gateway.ensureForRole(identity, request());
      if (!first.ok) throw new Error("setup failed");
      const id = [...control.registrations.keys()][0] ?? "";
      control.failNextList = { code: "timeout", retryable: true, retrySafety: "observation_only", message: "list timed out" };

      const verified = await gateway.verifyRegistrations(identity);

      expect(verified).toEqual({ ok: true, value: { checkedAt: now.toISOString(), healthy: false, lost: [], uncertain: true } });
      expect(JSON.parse(await readLedger()).entries[id].state).toBe("registered");
      expect(await gateway.ensureForRole(identity, request())).toEqual(first);
      expect(control.registerCalls).toBe(1);
    });

    it("counts an expired registration as lost even while the Gateway still lists it", async () => {
      const gateway = manager();
      expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
      const id = [...control.registrations.keys()][0] ?? "";
      now = new Date(now.getTime() + 3_600_000 + 1_000);

      const verified = await gateway.verifyRegistrations(identity);

      expect(verified.ok && verified.value.lost).toEqual([{ registrationId: id, role: "developer", taskId: "task-1" }]);
      expect(JSON.parse(await readLedger()).entries[id].state).toBe("lost");
    });

    it("retires lost registrations the restarted Gateway no longer lists without calling revoke", async () => {
      const gateway = manager();
      expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
      expect((await gateway.ensureForRole(identity, coordinatorRequest())).ok).toBe(true);
      const ids = [...control.registrations.keys()];
      control.restart();
      control.unknownRevokeCode = "validation";
      expect((await gateway.verifyRegistrations(identity)).ok).toBe(true);

      expect(await manager().revokeSession(identity)).toEqual({ ok: true, value: undefined });

      expect(control.revokeCalls).toEqual([]);
      const entries = JSON.parse(await readLedger()).entries;
      for (const id of ids) expect(entries[id].state).toBe("revoked");
    });

    it("keeps an unconfirmed entry when the Gateway listing is uncertain", async () => {
      const gateway = manager();
      expect((await gateway.ensureForRole(identity, request())).ok).toBe(true);
      const id = [...control.registrations.keys()][0] ?? "";
      control.restart();
      expect((await gateway.verifyRegistrations(identity)).ok).toBe(true);
      const failure: ContractError = { code: "transport_unavailable", retryable: true, message: "gateway unreachable" };
      control.failNextList = failure;

      expect(await manager().revokeSession(identity)).toEqual({ ok: false, error: failure });
      expect(JSON.parse(await readLedger()).entries[id].state).toBe("lost");
    });

    it("registers a lost entry again on the next launch with a new token, without revoking it", async () => {
      const gateway = manager();
      const first = await gateway.ensureForRole(identity, request());
      if (!first.ok) throw new Error("setup failed");
      const id = first.value.registrations[0]?.registrationId ?? "";
      const oldToken = first.value.tokenEnvironment[Object.keys(first.value.tokenEnvironment)[0] ?? ""];
      control.restart();
      expect((await gateway.verifyRegistrations(identity)).ok).toBe(true);

      const relaunched = await gateway.ensureForRole(identity, request());

      expect(relaunched.ok).toBe(true);
      if (!relaunched.ok) return;
      const newToken = relaunched.value.tokenEnvironment[Object.keys(relaunched.value.tokenEnvironment)[0] ?? ""];
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(oldToken);
      expect(control.registerCalls).toBe(2);
      expect(control.revokeCalls).toEqual([]);
      expect(JSON.parse(await readLedger()).entries[id].state).toBe("registered");
      expect(await gateway.verifyRegistrations(identity)).toEqual({
        ok: true, value: { checkedAt: now.toISOString(), healthy: true, lost: [], uncertain: false }
      });
    });
  });
});
