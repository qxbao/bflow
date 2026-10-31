import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OperationResult } from "@bflow/contracts";
import {
  ConversationContextSnapshotSchema,
  type ConversationContextSnapshot
} from "./types.js";

/**
 * Persistence interface for Conversation Agent session context & pending state recovery.
 *
 * Rule 6: Cho phép lưu ngữ cảnh hội thoại và trạng thái pending để khôi phục.
 * Rule 5 (Invariant): KHÔNG dùng file hoặc database như mailbox thay thế Herdr.
 * This store is strictly used by the Conversation Agent itself for local crash recovery
 * and restart continuity. It is NEVER polled or inspected by Coordinator or other agents.
 */
export interface ConversationContextStore {
  load(sessionId: string): Promise<OperationResult<ConversationContextSnapshot | null>>;
  save(snapshot: ConversationContextSnapshot): Promise<OperationResult<ConversationContextSnapshot>>;
  delete(sessionId: string): Promise<OperationResult<boolean>>;
}

/**
 * Validates a ConversationContextSnapshot using strict ConversationContextSnapshotSchema.
 */
function validateSnapshot(
  snapshot: unknown,
  expectedSessionId?: string
): OperationResult<ConversationContextSnapshot> {
  if (typeof snapshot !== "object" || snapshot === null) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: "Conversation context snapshot must be a non-null object"
      }
    };
  }

  const s = snapshot as Record<string, unknown>;

  if (s["schemaVersion"] !== 2) {
    const received = typeof s["schemaVersion"] === "number" ? s["schemaVersion"] : -1;
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [2],
        receivedVersion: received,
        message: `Unsupported snapshot schemaVersion: ${String(s["schemaVersion"])} (expected 2)`
      }
    };
  }

  const parseResult = ConversationContextSnapshotSchema.safeParse(snapshot);
  if (!parseResult.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid conversation context snapshot: ${parseResult.error.message}`,
        details: JSON.parse(JSON.stringify(parseResult.error.issues))
      }
    };
  }

  const data = parseResult.data;

  if (expectedSessionId !== undefined && data.session.sessionId !== expectedSessionId) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Session ID mismatch in snapshot: expected '${expectedSessionId}', got '${data.session.sessionId}'`
      }
    };
  }

  return { ok: true, value: data };
}

/**
 * Deep clones any plain JS object or structure safely.
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory implementation of ConversationContextStore for testing and transient sessions.
 */
export class InMemoryConversationContextStore implements ConversationContextStore {
  private readonly storage = new Map<string, ConversationContextSnapshot>();

  async load(sessionId: string): Promise<OperationResult<ConversationContextSnapshot | null>> {
    const existing = this.storage.get(sessionId);
    if (!existing) {
      return { ok: true, value: null };
    }

    const validation = validateSnapshot(existing, sessionId);
    if (!validation.ok) {
      return validation;
    }

    return { ok: true, value: deepClone(validation.value) };
  }

  async save(snapshot: ConversationContextSnapshot): Promise<OperationResult<ConversationContextSnapshot>> {
    const validation = validateSnapshot(snapshot);
    if (!validation.ok) {
      return validation;
    }

    const sessionId = validation.value.session.sessionId;
    const cloned = deepClone(validation.value);
    this.storage.set(sessionId, cloned);
    return { ok: true, value: deepClone(cloned) };
  }

  async delete(sessionId: string): Promise<OperationResult<boolean>> {
    const deleted = this.storage.delete(sessionId);
    return { ok: true, value: deleted };
  }

  clear(): void {
    this.storage.clear();
  }
}

/**
 * File-backed implementation of ConversationContextStore for crash recovery.
 *
 * Persists session state to `<storageDir>/<sessionId>.context.json` via atomic rename.
 * Strictly prevents path traversal attacks in sessionId.
 */
export class FileConversationContextStore implements ConversationContextStore {
  readonly storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = path.resolve(storageDir);
  }

  private resolveFilePath(sessionId: string): OperationResult<string> {
    if (!sessionId || typeof sessionId !== "string") {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: "Session ID must be a non-empty string"
        }
      };
    }

    // Path traversal prevention: strictly disallow slash, backslash, and directory navigation
    if (
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      sessionId.includes("..") ||
      sessionId.trim() !== sessionId
    ) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Path traversal attempt detected in sessionId: '${sessionId}'`
        }
      };
    }

    const filename = `${sessionId}.context.json`;
    const resolvedPath = path.join(this.storageDir, filename);

    // Ensure resolved path is strictly within storageDir
    if (!resolvedPath.startsWith(this.storageDir)) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid session path: resolved target is outside storageDir`
        }
      };
    }

    return { ok: true, value: resolvedPath };
  }

  async load(sessionId: string): Promise<OperationResult<ConversationContextSnapshot | null>> {
    const pathResult = this.resolveFilePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }
    const filePath = pathResult.value;

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, value: null };
      }
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Failed to read conversation context file at ${filePath}: ${String(err)}`
        }
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Corrupted JSON in conversation context file at ${filePath}: ${String(err)}`
        }
      };
    }

    const validation = validateSnapshot(parsed, sessionId);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Corrupted conversation snapshot data: ${validation.error.message}`,
          details: validation.error.details
        }
      };
    }

    return { ok: true, value: validation.value };
  }

  private readonly writeQueues = new Map<string, Promise<unknown>>();

  private async syncDirectorySafe(dirPath: string): Promise<void> {
    let dirHandle: fs.FileHandle | undefined;
    try {
      dirHandle = await fs.open(dirPath, "r");
      await dirHandle.sync();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (!["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EBADF", "EISDIR", "EROFS"].includes(code)) {
        throw err;
      }
    } finally {
      await dirHandle?.close().catch(() => {});
    }
  }

  async save(snapshot: ConversationContextSnapshot): Promise<OperationResult<ConversationContextSnapshot>> {
    const validation = validateSnapshot(snapshot);
    if (!validation.ok) {
      return validation;
    }

    const sessionId = validation.value.session.sessionId;
    const pathResult = this.resolveFilePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }
    const targetFilePath = pathResult.value;
    const validatedValue = deepClone(validation.value);
    const serialized = JSON.stringify(validatedValue, null, 2);

    const previous = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async (): Promise<OperationResult<ConversationContextSnapshot>> => {
      const tmpFilePath = path.join(
        this.storageDir,
        `${sessionId}.context.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      );
      let handle: fs.FileHandle | undefined;
      try {
        await fs.mkdir(this.storageDir, { recursive: true });
        handle = await fs.open(tmpFilePath, "wx", 0o600);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(tmpFilePath, targetFilePath);
        await this.syncDirectorySafe(this.storageDir);
      } catch (err: unknown) {
        await handle?.close().catch(() => {});
        try {
          await fs.unlink(tmpFilePath).catch(() => {});
        } catch {
          // ignore cleanup error
        }
        return {
          ok: false,
          error: {
            code: "transport_unavailable",
            retryable: true,
            message: `Failed to save conversation context atomically: ${String(err)}`
          }
        };
      }
      return { ok: true, value: deepClone(validatedValue) };
    });
    this.writeQueues.set(sessionId, run);
    return run;
  }

  async delete(sessionId: string): Promise<OperationResult<boolean>> {
    const pathResult = this.resolveFilePath(sessionId);
    if (!pathResult.ok) {
      return pathResult;
    }
    const filePath = pathResult.value;

    try {
      await fs.unlink(filePath);
      return { ok: true, value: true };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, value: false };
      }
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: `Failed to delete conversation context file: ${String(err)}`
        }
      };
    }
  }
}
