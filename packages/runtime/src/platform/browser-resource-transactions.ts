import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentRoleSchema, IdentifierSchema, IsoDateTimeSchema, MCPClientRegistrationSchema, MCPResourceLeaseSchema,
  MCPResourceRequestSchema, MCPResourceRenewRequestSchema, MCPToolCallSchema, MCPToolCallResultSchema,
  Sha256DigestSchema, type AgentRole, type ContractError, type MCPClientRegistration, type MCPResourceLease,
  type MCPToolCall, type MCPToolCallResult, type OperationOptions, type OperationResult } from "@bflow/contracts";
import type { GatewayControlPort, PlatformSessionIdentity } from "./ports.js";
import { fail, failWith, ok } from "./errors.js";

/** Host-derived assignment identity and machine-approved resource key; never role tool arguments. */
export interface BrowserResourceTransaction { readonly id: string; readonly resourceKey: string; }
export interface GatewayToolOperationOptions extends OperationOptions { readonly browserTransaction?: BrowserResourceTransaction; }

const MAX_TRANSACTION_MS = 300_000;
const CallSchema = z.object({ callId: IdentifierSchema, requestDigest: Sha256DigestSchema, request: MCPToolCallSchema,
  lease: MCPResourceLeaseSchema, state: z.enum(["pending", "settled"]) }).strict();
const TransactionSchema = z.object({ id: IdentifierSchema, registrationId: IdentifierSchema, role: AgentRoleSchema,
  serviceId: IdentifierSchema, resourceKey: IdentifierSchema, startedAt: IsoDateTimeSchema,
  state: z.enum(["active", "closing", "closed"]), lease: MCPResourceLeaseSchema,
  calls: z.array(CallSchema) }).strict();
const LedgerSchema = z.object({ schemaVersion: z.literal(3), transactions: z.array(TransactionSchema) }).strict();
type Ledger = z.infer<typeof LedgerSchema>;
class TransactionError extends Error { constructor(readonly failure: ContractError) { super(failure.message); } }
function reject(message: string): never { throw new TransactionError({ code: "conflict", retryable: true, message }); }
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
}
function uncertain<T>(message: string): OperationResult<T> { return failWith({ code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message }); }
function unwrap<T>(result: OperationResult<T>): T { if (!result.ok) throw new TransactionError(result.error); return result.value; }

/** Serialized by GatewayRegistrationManager. Token-free durable intents retain the exact original lease for reconciliation. */
export class BrowserResourceTransactions {
  constructor(private readonly control: GatewayControlPort, private readonly now: () => Date) {}

  async invoke(identity: PlatformSessionIdentity, registration: MCPClientRegistration, rawCall: MCPToolCall,
    transaction: BrowserResourceTransaction, reconcile: boolean, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>> {
    return this.guard(async () => {
      const reg = MCPClientRegistrationSchema.parse(registration), call = MCPToolCallSchema.parse(rawCall);
      IdentifierSchema.parse(transaction.id); IdentifierSchema.parse(transaction.resourceKey);
      if (call.registrationId !== reg.registrationId || !reg.serviceIds.includes(call.serviceId) || !reg.allowedTools.includes(call.tool) ||
          digest(reg.scope) !== digest({ kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
            workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId })) reject("Browser transaction principal or scope mismatch");
      const ledger = await this.read(identity);
      let entry = ledger.transactions.find(item => item.id === transaction.id && item.registrationId === reg.registrationId && item.serviceId === call.serviceId);
      const requestDigest = digest(call);
      const known = ledger.transactions.flatMap(item => item.calls.map(record => ({ owner: item, record }))).find(item => item.record.callId === call.callId);
      if (known && (known.owner !== entry || known.record.requestDigest !== requestDigest)) reject("Browser call ID is bound to another principal or request");
      if (entry && (entry.role !== reg.role || entry.resourceKey !== transaction.resourceKey)) reject("Browser transaction resource identity changed");
      // An expired transaction without unresolved delivery no longer holds the Gateway lease, so it must not block reassignment.
      const nowMs = this.now().getTime();
      if (!entry && !reconcile && ledger.transactions.some(item => item.state !== "closed" && item.serviceId === call.serviceId &&
          item.resourceKey === transaction.resourceKey &&
          (Date.parse(item.lease.expiresAt) > nowMs || item.calls.some(record => record.state === "pending"))))
        reject("Browser resource is owned by another transaction; finish or reconcile it before reassignment");
      if (reconcile) {
        if (!entry || !known) reject("No durable browser call exists for reconciliation");
      } else {
        if (known) reject("Browser call already has an intent; reconcile instead of resending");
        if (entry && (entry.state !== "active" || entry.calls.some(item => item.state === "pending")))
          reject("Browser transaction is closed or has unresolved delivery; reconcile before another call");
        if (!this.control.acquireResource || !this.control.renewResource || !this.control.releaseResource)
          reject("Gateway control endpoint does not support browser resource leases");
        const timestamp = this.now().getTime();
        if (entry && (Date.parse(entry.lease.expiresAt) <= timestamp || timestamp - Date.parse(entry.startedAt) >= MAX_TRANSACTION_MS))
          reject("Browser transaction expired; start a new authorized assignment instead of reacquiring shared state");
        const ttlMs = Math.min(MAX_TRANSACTION_MS, Math.max(1, Date.parse(reg.expiresAt) - timestamp),
          entry ? MAX_TRANSACTION_MS - (timestamp - Date.parse(entry.startedAt)) : MAX_TRANSACTION_MS);
        if (ttlMs <= (options?.timeoutMs ?? 5_000)) reject("Browser lease has insufficient remaining lifetime");
        let lease: MCPResourceLease;
        if (entry) {
          lease = this.checkedLease(unwrap(await this.control.renewResource(MCPResourceRenewRequestSchema.parse({ schemaVersion: 3,
            lease: entry.lease, ttlMs, idempotencyKey: `browser-renew-${call.callId}` }), options)), reg, call.serviceId, transaction.resourceKey);
          if (lease.leaseId !== entry.lease.leaseId || lease.fencingToken !== entry.lease.fencingToken || lease.acquiredAt !== entry.lease.acquiredAt)
            reject("Gateway changed browser lease ownership during renewal");
          entry.lease = lease;
        } else {
          lease = this.checkedLease(unwrap(await this.control.acquireResource(MCPResourceRequestSchema.parse({ schemaVersion: 3,
            scope: reg.scope, registrationId: reg.registrationId, serviceId: call.serviceId, resourceKey: transaction.resourceKey,
            ttlMs, idempotencyKey: `browser-acquire-${call.callId}` }), options)), reg, call.serviceId, transaction.resourceKey);
          entry = { id: transaction.id, registrationId: reg.registrationId, role: reg.role, serviceId: call.serviceId,
            resourceKey: transaction.resourceKey, startedAt: this.now().toISOString(), state: "active", lease, calls: [] };
          ledger.transactions.push(entry);
        }
        entry.calls.push({ callId: call.callId, requestDigest, request: call, lease, state: "pending" });
        await this.write(identity, ledger); // Crash from this point is observation-only, never automatic resend.
      }
      const record = entry!.calls.find(item => item.callId === call.callId)!;
      const dispatched = MCPToolCallSchema.parse({ ...call, resourceLease: record.lease });
      let result: OperationResult<MCPToolCallResult>;
      try {
        result = await (reconcile ? this.control.reconcileToolCall(dispatched, options) : this.control.invokeTool(dispatched, options));
      } catch {
        return uncertain("Browser tool delivery is uncertain; reconcile the original call");
      }
      if (!result.ok) {
        const isUncertain = ["timeout", "unknown_delivery", "transport_unavailable", "cancelled", "corruption"].includes(result.error.code) ||
          ("retrySafety" in result.error && result.error.retrySafety === "observation_only");
        if (isUncertain || reconcile) return uncertain("Browser delivery is uncertain; reconcile the original call");
        record.state = "settled";
        try { await this.write(identity, ledger); } catch { return uncertain("Browser call settlement could not be persisted; reconcile the original call"); }
        return result;
      }
      const checked = MCPToolCallResultSchema.safeParse(result.value);
      if (!checked.success || checked.data.callId !== call.callId)
        return uncertain("Gateway browser result is malformed or mismatched; reconcile the original call");
      if (checked.data.status !== "unknown") { record.state = "settled";
        try { await this.write(identity, ledger); } catch { return uncertain("Browser call settlement could not be persisted; reconcile the original call"); } }
      return ok(checked.data);
    });
  }

  async finish(identity: PlatformSessionIdentity, role: AgentRole, transactionId?: string, registrationId?: string, recoverPending = false): Promise<OperationResult<void>> {
    return this.guard(async () => {
      const ledger = await this.read(identity);
      const entries = ledger.transactions.filter(entry => entry.role === role && (registrationId === undefined || entry.registrationId === registrationId) && (transactionId === undefined || entry.id === transactionId) && entry.state !== "closed");
      let failure: ContractError | undefined;
      for (const entry of entries) {
        if (recoverPending) for (const call of entry.calls.filter(item => item.state === "pending")) {
          // One bounded observation during lifecycle recovery, never a replay or a new lease.
          try {
            const result = await this.control.reconcileToolCall(MCPToolCallSchema.parse({ ...call.request, resourceLease: call.lease }), { timeoutMs: 5_000 });
            if (result.ok) {
              const checked = MCPToolCallResultSchema.safeParse(result.value);
              if (checked.success && checked.data.callId === call.callId && checked.data.status !== "unknown") {
                call.state = "settled";
                await this.write(identity, ledger);
              }
            }
          } catch {
            return uncertain("Browser recovery observation or settlement could not complete; registration must be retained");
          }
        }
        if (entry.calls.some(call => call.state === "pending")) {
          failure ??= { code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "Browser transaction retains unresolved delivery; reconcile before release" };
          continue;
        }
        entry.state = "closing";
        await this.write(identity, ledger); // A lost release response must not revive the transaction.
        if (!this.control.releaseResource) reject("Gateway control endpoint does not support resource release");
        const result = await this.control.releaseResource(entry.lease, { schemaVersion: 3,
          scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
            workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId }, idempotencyKey: `browser-release-${entry.lease.leaseId}` });
        if (result.ok) { entry.state = "closed"; await this.write(identity, ledger); } else failure ??= result.error;
      }
      return failure ? failWith(failure) : ok(undefined);
    });
  }

  private checkedLease(raw: unknown, reg: MCPClientRegistration, serviceId: string, resourceKey: string): MCPResourceLease {
    const parsed = MCPResourceLeaseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.registrationId !== reg.registrationId || parsed.data.serviceId !== serviceId ||
        parsed.data.resourceKey !== resourceKey || Date.parse(parsed.data.expiresAt) <= this.now().getTime() ||
        Date.parse(parsed.data.expiresAt) > Date.parse(reg.expiresAt)) reject("Gateway browser lease is malformed or mismatched");
    return parsed.data;
  }

  private async guard<T>(work: () => Promise<OperationResult<T>>): Promise<OperationResult<T>> {
    try { return await work(); }
    catch (error) {
      if (error instanceof TransactionError) return failWith(error.failure);
      return fail("corruption", "Browser resource transaction ledger or control operation failed; reconcile before continuing");
    }
  }

  private async read(identity: PlatformSessionIdentity): Promise<Ledger> {
    await this.directory(identity);
    const path = join(identity.stateDirectory, `gen-${identity.generation}`, "browser-resource-transactions.json");
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return { schemaVersion: 3, transactions: [] };
    if (!info.isFile() || info.isSymbolicLink()) reject("Refusing non-regular browser resource ledger");
    const ledger = LedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const ids = ledger.transactions.map(entry => [entry.id, entry.registrationId, entry.serviceId].join(":"));
    const callIds = ledger.transactions.flatMap(entry => entry.calls.map(call => call.callId));
    if (new Set(ids).size !== ids.length || new Set(callIds).size !== callIds.length) reject("Duplicate browser transaction or call identity");
    for (const entry of ledger.transactions) {
      for (const lease of [entry.lease, ...entry.calls.map(call => call.lease)])
        if (lease.registrationId !== entry.registrationId || lease.serviceId !== entry.serviceId || lease.resourceKey !== entry.resourceKey)
          reject("Browser transaction ledger lease ownership mismatch");
      for (const call of entry.calls)
        if (call.requestDigest !== digest(call.request) || call.request.callId !== call.callId || call.request.registrationId !== entry.registrationId ||
            call.request.serviceId !== entry.serviceId || call.request.resourceLease !== undefined)
          reject("Browser transaction ledger request identity mismatch");
    }
    return ledger;
  }
  private async directory(identity: PlatformSessionIdentity): Promise<string> {
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) reject("Invalid browser transaction generation");
    const directory = join(identity.stateDirectory, `gen-${identity.generation}`);
    for (const path of [identity.stateDirectory, directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) reject("Refusing symlinked browser transaction directory");
    }
    return directory;
  }
  private async write(identity: PlatformSessionIdentity, ledger: Ledger): Promise<void> {
    const directory = await this.directory(identity), path = join(directory, "browser-resource-transactions.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(LedgerSchema.parse(ledger))); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (
          code !== "EINVAL" &&
          code !== "ENOSYS" &&
          code !== "ENOTSUP" &&
          code !== "EOPNOTSUPP" &&
          code !== "EROFS" &&
          code !== "EPERM" &&
          code !== "EISDIR" &&
          code !== "EBADF"
        ) {
          throw error;
        }
      } finally {
        await parent.close();
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
