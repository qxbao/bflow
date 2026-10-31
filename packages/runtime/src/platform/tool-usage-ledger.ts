import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MCPToolCallResultSchema, ToolUsageRecordSchema, type MCPToolCallResult, type ToolUsageRecord } from "@bflow/contracts";

const VERSION = 1;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
type State = { schemaVersion: 1; records: ToolUsageRecord[] };
const queues = new Map<string, Promise<unknown>>();

/** Private atomic Runtime action evidence. Stores metadata only, never inputs, outputs, credentials or memory bodies. */
export class FileToolUsageLedger {
  private readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  async list(): Promise<readonly ToolUsageRecord[]> {
    return this.exclusive(async () => (await this.read()).records.map(record => structuredClone(record)));
  }

  /** Called once when a host process opens the ledger; a live read never changes an in-flight record. */
  async recoverInterrupted(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.read();
      let changed = false;
      const records = state.records.map(record => {
        if (record.status !== "started") return record;
        changed = true;
        return ToolUsageRecordSchema.parse({ ...record, status: "unknown", reasonCode: "unknown_delivery", observedAt: new Date().toISOString() });
      });
      if (changed) await this.write({ schemaVersion: VERSION, records });
    });
  }

  async begin(record: ToolUsageRecord): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    if (checked.status !== "started") throw new TypeError("Tool usage intent must have started status");
    await this.exclusive(async () => {
      const state = await this.read();
      if (state.records.some(item => item.invocationId === checked.invocationId))
        throw new Error("Tool invocation ID already exists; reconcile the original invocation");
      await this.write({ schemaVersion: VERSION, records: [...state.records, checked] });
    });
  }

  async put(record: ToolUsageRecord): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    await this.exclusive(async () => {
      const state = await this.read();
      const index = state.records.findIndex(item => item.invocationId === checked.invocationId);
      if (index < 0) {
        if (checked.status !== "planned") throw new Error("Tool invocation has no durable intent");
        if (state.records.some(item => sameInvocation(item, checked))) throw new Error("Duplicate tool invocation identity");
        await this.write({ schemaVersion: VERSION, records: [...state.records, checked] });
        return;
      }
      const previous = state.records[index]!;
      if (!sameImmutableIdentity(previous, checked)) throw new Error("Tool invocation identity cannot change");
      if (isDeepStrictEqual(previous, checked)) return;
      if (!allowedTransition(previous.status, checked.status)) throw new Error(`Illegal tool usage transition ${previous.status} -> ${checked.status}`);
      const records = [...state.records]; records[index] = checked;
      await this.write({ schemaVersion: VERSION, records });
    });
  }

  /** An unknown call can settle only from an authenticated Gateway reconciliation result. */
  async reconcileUnknown(record: ToolUsageRecord, result: MCPToolCallResult): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    const proof = MCPToolCallResultSchema.parse(result);
    if (checked.invocationId !== proof.callId || checked.status !== proof.status)
      throw new TypeError("Reconciled usage status and invocation ID must match the authenticated Gateway result");
    await this.exclusive(async () => {
      const state = await this.read();
      const index = state.records.findIndex(item => item.invocationId === checked.invocationId);
      if (index < 0 || state.records[index]!.status !== "unknown") throw new Error("Only an existing unknown invocation can be reconciled");
      if (!sameImmutableIdentity(state.records[index]!, checked)) throw new Error("Tool invocation identity cannot change");
      const records = [...state.records]; records[index] = checked;
      await this.write({ schemaVersion: VERSION, records });
    });
  }

  /** Consumption is a separate durable assertion from an invocation result and can only attach stored evidence. */
  async consume(record: ToolUsageRecord): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    if (checked.status !== "completed" || checked.consumption?.status !== "consumed" || !checked.evidenceReferences?.length ||
        checked.consumption.evidenceReferences.some(reference => !checked.evidenceReferences!.some(item => item.uri === reference.uri && item.checksum.value === reference.checksum.value)))
      throw new TypeError("Consumption requires completed usage and matching stored evidence references");
    await this.exclusive(async () => {
      const state = await this.read();
      const index = state.records.findIndex(item => item.invocationId === checked.invocationId);
      if (index < 0) throw new Error("Tool invocation has no durable result");
      const previous = state.records[index]!;
      if (previous.status !== "completed" || previous.consumption !== undefined || !sameImmutableIdentity(previous, checked))
        throw new Error("Only an unconsumed completed invocation with the same identity can record consumption");
      const priorWithoutLinks = { ...previous, evidenceReferences: undefined, consumption: undefined };
      const checkedWithoutLinks = { ...checked, evidenceReferences: undefined, consumption: undefined };
      if (priorWithoutLinks.schemaVersion !== checkedWithoutLinks.schemaVersion || priorWithoutLinks.runId !== checkedWithoutLinks.runId ||
          priorWithoutLinks.taskId !== checkedWithoutLinks.taskId || priorWithoutLinks.role !== checkedWithoutLinks.role ||
          priorWithoutLinks.sessionId !== checkedWithoutLinks.sessionId || priorWithoutLinks.generation !== checkedWithoutLinks.generation ||
          priorWithoutLinks.invocationId !== checkedWithoutLinks.invocationId || priorWithoutLinks.toolId !== checkedWithoutLinks.toolId ||
          priorWithoutLinks.serviceId !== checkedWithoutLinks.serviceId || priorWithoutLinks.operation !== checkedWithoutLinks.operation ||
          priorWithoutLinks.status !== checkedWithoutLinks.status || priorWithoutLinks.reasonCode !== checkedWithoutLinks.reasonCode)
        throw new Error("Tool usage result cannot change when recording consumption");
      const links = previous.evidenceReferences;
      if (links && !isDeepStrictEqual(links, checked.evidenceReferences)) throw new Error("Consumption cannot replace existing evidence references");
      const records = [...state.records]; records[index] = checked;
      await this.write({ schemaVersion: VERSION, records });
    });
  }

  /** Authenticated role ACK that the exact stored result reached its current task context. */
  async acknowledgeDelivery(record: ToolUsageRecord): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    const consumption = checked.consumption;
    if (checked.status !== "completed" || consumption?.status !== "consumed" ||
        consumption.source !== "host_context" || !checked.evidenceReferences?.length ||
        !isDeepStrictEqual(consumption.evidenceReferences, checked.evidenceReferences))
      throw new TypeError("Delivery acknowledgement requires completed usage and its exact stored result evidence");
    await this.exclusive(async () => {
      const state = await this.read();
      const index = state.records.findIndex(item => item.invocationId === checked.invocationId);
      if (index < 0) throw new Error("Tool invocation has no durable result");
      const previous = state.records[index]!;
      if (previous.status !== "completed" || previous.generation !== checked.generation || !sameImmutableIdentity(previous, checked))
        throw new Error("Only the matching completed invocation can be acknowledged");
      if (!isDeepStrictEqual(previous.evidenceReferences, checked.evidenceReferences))
        throw new Error("Delivery acknowledgement cannot replace or extend result evidence");
      if (previous.consumption?.status === "consumed" && previous.consumption.source === "host_context" &&
          isDeepStrictEqual(previous.consumption.evidenceReferences, consumption.evidenceReferences)) return;
      if (isDeepStrictEqual(previous, checked)) return;
      const priorDisposition = previous.consumption;
      if (priorDisposition !== undefined &&
          (priorDisposition.status !== "not_used" || priorDisposition.reasonCode !== "provider_delivery_unconfirmed"))
        throw new Error("Only unconfirmed provider delivery can be acknowledged");
      const records = [...state.records]; records[index] = checked;
      await this.write({ schemaVersion: VERSION, records });
    });
  }

  /** Records that forwarding/use was not acknowledged; it must never be promoted to consumed on inference. */
  async notUsed(record: ToolUsageRecord): Promise<void> {
    const checked = ToolUsageRecordSchema.parse(record);
    if (checked.status !== "completed" || checked.consumption?.status !== "not_used")
      throw new TypeError("Unconfirmed provider delivery requires completed usage and a not_used disposition");
    await this.exclusive(async () => {
      const state = await this.read();
      const index = state.records.findIndex(item => item.invocationId === checked.invocationId);
      if (index < 0 || state.records[index]!.status !== "completed") throw new Error("Only a completed tool invocation can record not_used");
      const previous = state.records[index]!;
      if (!sameImmutableIdentity(previous, checked)) throw new Error("Tool invocation identity cannot change");
      if (previous.consumption?.status === "not_used" && isDeepStrictEqual(previous, checked)) return;
      if (previous.consumption !== undefined) throw new Error("Tool invocation consumption is already settled");
      const records = [...state.records]; records[index] = checked;
      await this.write({ schemaVersion: VERSION, records });
    });
  }

  private async read(): Promise<State> {
    try {
      const info = await lstat(this.path);
      assertPrivateFile(info, "Tool usage ledger");
      if (info.size > MAX_LEDGER_BYTES) throw new Error("Tool usage ledger exceeds its size limit");
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let parsed: unknown;
      try {
        const openedInfo = await file.stat(); assertPrivateFile(openedInfo, "Tool usage ledger");
        if (openedInfo.size > MAX_LEDGER_BYTES) throw new Error("Tool usage ledger exceeds its size limit");
        parsed = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
      if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || parsed.schemaVersion !== VERSION || !Array.isArray(parsed.records))
        throw new Error("Tool usage ledger is malformed");
      const records = parsed.records.map(item => ToolUsageRecordSchema.parse(item));
      if (records.length > 10_000 || new Set(records.map(item => item.invocationId)).size !== records.length)
        throw new Error("Tool usage ledger has duplicate or excessive invocation records");
      return { schemaVersion: VERSION, records };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: VERSION, records: [] };
      throw error;
    }
  }

  private async write(state: State): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()))
      throw new Error("Tool usage ledger directory must be a private current-user-owned directory");
    const temporary = join(directory, `.tool-usage-${randomUUID()}.tmp`);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_LEDGER_BYTES) throw new Error("Tool usage ledger exceeds its size limit");
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(serialized, "utf8"); await file.sync(); }
    finally { await file.close(); }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      const dir = await open(directory, "r");
      try {
        await dir.sync();
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
        await dir.close();
      }
    } finally { await rm(temporary, { force: true }); }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = queues.get(this.path) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid()))
        throw new Error("Tool usage ledger directory must be a private current-user-owned directory");
      const lock = await open(`${this.path}.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const info = await lock.stat();
        assertPrivateFile(info, "Tool usage lock");
        await new Promise<void>((resolveLock, rejectLock) => {
          const child = spawn("flock", ["--exclusive", "--timeout", "5", "3"], { stdio: ["ignore", "ignore", "ignore", lock.fd] });
          child.once("error", rejectLock);
          child.once("exit", code => code === 0 ? resolveLock() : rejectLock(new Error("Tool usage ledger is busy")));
        });
        return await operation();
      } finally { await lock.close(); }
    });
    queues.set(this.path, next);
    try { return await next; }
    finally { if (queues.get(this.path) === next) queues.delete(this.path); }
  }
}

function assertPrivateFile(info: Stats, name: string): void {
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error(`${name} must be a private current-user-owned regular file`);
}

function sameImmutableIdentity(left: ToolUsageRecord, right: ToolUsageRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.runId === right.runId && left.taskId === right.taskId &&
    left.role === right.role && left.sessionId === right.sessionId && left.generation === right.generation &&
    left.invocationId === right.invocationId && left.toolId === right.toolId && left.serviceId === right.serviceId &&
    left.operation === right.operation;
}
function sameInvocation(left: ToolUsageRecord, right: ToolUsageRecord): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation && left.invocationId === right.invocationId;
}
function allowedTransition(from: ToolUsageRecord["status"], to: ToolUsageRecord["status"]): boolean {
  if (from === "planned") return ["started", "denied", "skipped", "degraded", "blocked"].includes(to);
  if (from === "started") return ["completed", "failed", "unknown"].includes(to);
  return false;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
