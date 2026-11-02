import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type ContractError,
  type OperationOptions,
  type OperationResult,
  type SessionManifest,
  SessionManifestSchema,
  canonicalReceiptJson
} from "@bflow/contracts";
import type { SessionManifestStore } from "./types.js";

function validateSafeSessionId(sessionId: string): ContractError | null {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..") ||
    sessionId.includes("\0")
  ) {
    return {
      code: "validation",
      retryable: false,
      message: `Invalid or unsafe session ID: "${sessionId}"`
    };
  }
  return null;
}

/** Profile snapshots are append-only for this session, including after pane cleanup. */
function snapshotConflict(previous: SessionManifest | null | undefined, next: SessionManifest): ContractError | null {
  for (const snapshot of previous?.roleProfiles ?? []) {
    const retained = next.roleProfiles?.find(item => item.pin.profileId === snapshot.pin.profileId && item.pin.version === snapshot.pin.version);
    if (!retained || canonicalReceiptJson(retained) !== canonicalReceiptJson(snapshot)) {
      return { code: "conflict", retryable: true, message: "Session role profile snapshots are immutable; create a new session generation" };
    }
  }
  return null;
}

export class InMemorySessionManifestStore implements SessionManifestStore {
  readonly #records = new Map<string, SessionManifest>();

  async load(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest | null>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const item = this.#records.get(sessionId);
    if (item === undefined) {
      return { ok: true, value: null };
    }

    const parsed = SessionManifestSchema.safeParse(item);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Stored manifest for session "${sessionId}" is corrupt: ${parsed.error.message}`
        }
      };
    }

    return { ok: true, value: structuredClone(parsed.data) };
  }

  async save(
    manifest: SessionManifest,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const parsed = SessionManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Invalid session manifest: ${parsed.error.message}`
        }
      };
    }

    const validated = parsed.data;
    const conflict = snapshotConflict(this.#records.get(validated.sessionId), validated);
    if (conflict) return { ok: false, error: conflict };
    const cloned = structuredClone(validated);
    this.#records.set(cloned.sessionId, cloned);
    return { ok: true, value: structuredClone(cloned) };
  }

  async delete(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<boolean>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const existed = this.#records.delete(sessionId);
    return { ok: true, value: existed };
  }
}

const BENIGN_FILE_SYNC_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EROFS",
  "EPERM",
  "EACCES"
]);
const BENIGN_DIR_SYNC_CODES = new Set([...BENIGN_FILE_SYNC_CODES, "EISDIR", "EBADF"]);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

async function safeFileSync(handle: { sync: () => Promise<void> }): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !BENIGN_FILE_SYNC_CODES.has(code)) throw error;
  }
}

async function safeDirectorySync(dirPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(dirPath, constants.O_RDONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && BENIGN_DIR_SYNC_CODES.has(code)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !BENIGN_DIR_SYNC_CODES.has(code)) throw error;
  } finally {
    await handle.close();
  }
}

export class FileSessionManifestStore implements SessionManifestStore {
  readonly #queues = new Map<string, Promise<void>>();

  constructor(private readonly baseDir: string) {}

  #enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const pending = previous.then(action);
    const tail = pending.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(sessionId, tail);
    void tail.then(() => {
      if (this.#queues.get(sessionId) === tail) {
        this.#queues.delete(sessionId);
      }
    });
    return pending;
  }

  private resolvePath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.manifest.json`);
  }

  async load(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest | null>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const validationError = validateSafeSessionId(sessionId);
    if (validationError !== null) {
      return { ok: false, error: validationError };
    }

    const filePath = this.resolvePath(sessionId);
    let content: string;
    try {
      const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          return {
            ok: false,
            error: {
              code: "corruption",
              retryable: false,
              message: `Session manifest path at ${filePath} is not a regular file`
            }
          };
        }
        if (info.size > MAX_MANIFEST_BYTES) {
          return {
            ok: false,
            error: {
              code: "corruption",
              retryable: false,
              message: `Session manifest file at ${filePath} exceeds size limit`
            }
          };
        }
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        return { ok: true, value: null };
      }
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Failed to read session manifest from ${filePath}: ${nodeErr.message}`
        }
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (err: unknown) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Session manifest file at ${filePath} contains malformed JSON: ${(err as Error).message}`
        }
      };
    }

    const schemaResult = SessionManifestSchema.safeParse(parsedJson);
    if (!schemaResult.success) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: `Session manifest file at ${filePath} violates schema: ${schemaResult.error.message}`
        }
      };
    }

    return { ok: true, value: schemaResult.data };
  }

  async save(
    manifest: SessionManifest,
    options?: OperationOptions
  ): Promise<OperationResult<SessionManifest>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const schemaResult = SessionManifestSchema.safeParse(manifest);
    if (!schemaResult.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: schemaResult.error.message
        }
      };
    }

    const validatedManifest = schemaResult.data;
    const validationError = validateSafeSessionId(validatedManifest.sessionId);
    if (validationError !== null) {
      return { ok: false, error: validationError };
    }

    return this.#enqueue(validatedManifest.sessionId, async () => {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
        };
      }

      const previous = await this.load(validatedManifest.sessionId, options);
      if (!previous.ok) return previous;
      const conflict = snapshotConflict(previous.value, validatedManifest);
      if (conflict) return { ok: false, error: conflict };

      const filePath = this.resolvePath(validatedManifest.sessionId);
      const stagingPath = `${filePath}.${randomUUID()}.tmp`;

      try {
        await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
        const content = JSON.stringify(validatedManifest, null, 2);
        const handle = await open(stagingPath, "wx", 0o600);
        try {
          await handle.writeFile(content, "utf8");
          await safeFileSync(handle);
        } finally {
          await handle.close();
        }
        await rename(stagingPath, filePath);
        await safeDirectorySync(this.baseDir);
      } catch (err: unknown) {
        try {
          await unlink(stagingPath);
        } catch {
          // ignore cleanup error
        }
        const errorMsg = (err as Error).message;
        return {
          ok: false,
          error: {
            code: "corruption",
            retryable: false,
            message: `Failed to persist session manifest to ${filePath}: ${errorMsg}`
          }
        };
      }

      return { ok: true, value: validatedManifest };
    });
  }

  async delete(
    sessionId: string,
    options?: OperationOptions
  ): Promise<OperationResult<boolean>> {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
      };
    }

    const validationError = validateSafeSessionId(sessionId);
    if (validationError !== null) {
      return { ok: false, error: validationError };
    }

    return this.#enqueue(sessionId, async () => {
      if (options?.signal?.aborted) {
        return {
          ok: false,
          error: { code: "cancelled", retryable: false, message: "Operation was aborted" }
        };
      }

      const filePath = this.resolvePath(sessionId);
      try {
        await unlink(filePath);
        await safeDirectorySync(this.baseDir);
        return { ok: true, value: true };
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          return { ok: true, value: false };
        }
        return {
          ok: false,
          error: {
            code: "corruption",
            retryable: false,
            message: `Failed to delete session manifest at ${filePath}: ${nodeErr.message}`
          }
        };
      }
    });
  }
}
