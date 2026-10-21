import { open, mkdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactString } from "../resilience/redaction.js";

export type TaskActivityKind = "admission" | "planning" | "assignment" | "progress" | "tool" | "specification" | "tdd" | "verification" | "review" | "approval" | "recovery" | "cancellation" | "result" | "error" | "transport";
export interface TaskActivityInput {
  readonly kind: TaskActivityKind; readonly role: string; readonly action: string;
  readonly runId?: string; readonly taskId?: string; readonly attemptId?: string;
  readonly outcome?: string; readonly durationMs?: number;
}
export interface TaskActivityEntry extends TaskActivityInput { readonly at: string; readonly id?: string; }
type ScopeField = "runId" | "taskId" | "attemptId";
interface StoredTaskActivityEntry extends TaskActivityEntry { readonly scopes?: Partial<Record<ScopeField, string>>; }
const SCOPE_FIELDS: readonly ScopeField[] = ["runId", "taskId", "attemptId"];
const scopeKey = (value: string): string => createHash("sha256").update(value).digest("hex");
export interface TaskActivityFilter { readonly runId?: string; readonly taskId?: string; readonly lines?: number; readonly maxBytes?: number; }
const DEFAULT_ENTRIES = 1000, DEFAULT_BYTES = 512 * 1024, MAX_LINE_BYTES = 4096;
const KINDS = new Set<TaskActivityKind>(["admission", "planning", "assignment", "progress", "tool", "specification", "tdd", "verification", "review", "approval", "recovery", "cancellation", "result", "error", "transport"]);
function clean(value: string, limit = 240): string {
  return Array.from(redactString(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, limit).join("");
}
function parseEntry(value: unknown): StoredTaskActivityEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task activity entry");
  const item = value as Record<string, unknown>;
  if (typeof item.at !== "string" || !Number.isFinite(Date.parse(item.at)) || typeof item.kind !== "string" || !KINDS.has(item.kind as TaskActivityKind) ||
      typeof item.role !== "string" || typeof item.action !== "string") throw new Error("Invalid task activity entry");
  for (const field of ["runId", "taskId", "attemptId", "outcome"]) if (item[field] !== undefined && typeof item[field] !== "string") throw new Error("Invalid task activity field");
  if (item.durationMs !== undefined && (typeof item.durationMs !== "number" || !Number.isFinite(item.durationMs) || item.durationMs < 0)) throw new Error("Invalid task activity duration");
  if (item.id !== undefined && (typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id))) throw new Error("Invalid task activity identity");
  if (item.scopes !== undefined) {
    if (!item.scopes || typeof item.scopes !== "object" || Array.isArray(item.scopes) ||
      Object.entries(item.scopes).some(([key, hash]) => !SCOPE_FIELDS.includes(key as ScopeField) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid task activity scope");
  }
  return item as unknown as StoredTaskActivityEntry;
}

/** A best-effort private diagnostic journal. It never participates in Runtime's authoritative transaction. */
export class TaskActivityLog {
  private static readonly queues = new Map<string, Promise<unknown>>();
  private constructor(readonly path: string, private readonly maxEntries: number, private readonly maxBytes: number) {}
  static open(path: string, options: { maxEntries?: number; maxBytes?: number } = {}): TaskActivityLog {
    return new TaskActivityLog(path, options.maxEntries ?? DEFAULT_ENTRIES, options.maxBytes ?? DEFAULT_BYTES);
  }
  async record(input: TaskActivityInput): Promise<boolean> {
    const previous = TaskActivityLog.queues.get(this.path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    TaskActivityLog.queues.set(this.path, current);
    await previous.catch(() => undefined);
    try { return await this.recordLocked(input); } finally {
      release();
      if (TaskActivityLog.queues.get(this.path) === current) TaskActivityLog.queues.delete(this.path);
    }
  }
  private async recordLocked(input: TaskActivityInput): Promise<boolean> {
    try {
      const scopes: Partial<Record<ScopeField, string>> = {};
      for (const field of SCOPE_FIELDS) if (input[field]) scopes[field] = scopeKey(input[field]);
      const entry = parseEntry({ id: randomUUID(), at: new Date().toISOString(), kind: input.kind, role: clean(input.role, 32), action: clean(input.action, 80), scopes,
        ...(input.runId ? { runId: clean(input.runId, 200) } : {}), ...(input.taskId ? { taskId: clean(input.taskId, 200) } : {}),
        ...(input.attemptId ? { attemptId: clean(input.attemptId, 200) } : {}), ...(input.outcome ? { outcome: clean(input.outcome, 240) } : {}),
        ...(input.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(input.durationMs)) }) });
      let line = JSON.stringify(entry);
      let outcome = Array.from(entry.outcome ?? ""), action = Array.from(entry.action), role = Array.from(entry.role);
      while (Buffer.byteLength(line) > MAX_LINE_BYTES && (outcome.length > 0 || action.length > 16 || role.length > 8)) {
        if (outcome.length > 0) {
          const nextLength = Math.max(0, Math.min(outcome.length - 1, Math.floor(outcome.length * 0.7)));
          outcome = outcome.slice(0, nextLength); Object.assign(entry, { outcome: outcome.join("") });
        } else if (action.length > 16) {
          action = action.slice(0, Math.max(16, Math.floor(action.length * 0.7))); Object.assign(entry, { action: action.join("") });
        } else {
          role = role.slice(0, Math.max(8, Math.floor(role.length * 0.7))); Object.assign(entry, { role: role.join("") });
        }
        line = JSON.stringify(entry);
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return false;
      const entries = await this.readStored(); entries.push(entry);
      let selected = entries.slice(-this.maxEntries);
      while (selected.length > 1 && Buffer.byteLength(selected.map(item => JSON.stringify(item)).join("\n") + "\n") > this.maxBytes) selected.shift();
      const body = selected.map(item => JSON.stringify(item)).join("\n") + "\n";
      if (Buffer.byteLength(body) > this.maxBytes) return false;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return true;
    } catch { return false; }
  }
  private async readStored(): Promise<StoredTaskActivityEntry[]> {
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let contents: string;
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size > this.maxBytes) return []; contents = await file.readFile("utf8"); }
      finally { await file.close(); }
      return contents.split(/\r?\n/).filter(Boolean).map(line => parseEntry(JSON.parse(line))).slice(-this.maxEntries);
    } catch { return []; }
  }
  async read(filter: TaskActivityFilter = {}): Promise<TaskActivityEntry[]> {
    try {
      const entries = (await this.readStored()).filter(entry => (["runId", "taskId"] as const).every(field =>
        filter[field] === undefined || (entry.scopes?.[field] !== undefined ? entry.scopes[field] === scopeKey(filter[field]) : entry[field] === filter[field])))
        .map(({ scopes: _scopes, ...entry }) => entry);
      const maxBytes = Math.min(this.maxBytes, filter.maxBytes ?? 16 * 1024), lines = Math.min(this.maxEntries, filter.lines ?? 100);
      const selected: TaskActivityEntry[] = [];
      let used = 0;
      for (const entry of entries.slice(-lines).reverse()) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (used + size > maxBytes) break;
        selected.unshift(entry); used += size;
      }
      return selected;
    } catch { return []; }
  }
}
