import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const UserStopIntentSchema = z.object({
  version: z.literal(1),
  repositoryId: z.string().min(1),
  sessionName: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  source: z.enum(["cli", "web"]),
  operationId: z.string().min(1).max(200).optional(),
  requestedAt: z.string().datetime()
}).strict();
export type UserStopIntent = z.infer<typeof UserStopIntentSchema>;

const MAX_BYTES = 4096;

function stateDirectory(root: string): string { return join(root, ".bflow", "state"); }
function intentPath(root: string): string { return join(stateDirectory(root), "user-stop.json"); }

/**
 * Durable record that the user stopped the session. Absent when no file exists or it belongs to another
 * repository/session. A corrupt file is NOT absent: this throws, and the caller chooses the safe direction.
 */
export async function readUserStopIntent(root: string, repositoryId: string | undefined, sessionName: string): Promise<UserStopIntent | undefined> {
  const path = intentPath(root);
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error("User stop intent marker invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("User stop intent marker invalid"); }
  const result = UserStopIntentSchema.safeParse(parsed);
  if (!result.success) throw new Error("User stop intent marker invalid");
  if ((repositoryId !== undefined && result.data.repositoryId !== repositoryId) || result.data.sessionName !== sessionName) return undefined;
  return result.data;
}

export async function writeUserStopIntent(root: string, intent: UserStopIntent): Promise<void> {
  const value = UserStopIntentSchema.parse(intent);
  await mkdir(stateDirectory(root), { recursive: true });
  const target = intentPath(root);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function clearUserStopIntent(root: string): Promise<void> {
  await rm(intentPath(root), { force: true });
}

export type UserStopState = { readonly stopped: false } | { readonly stopped: true; readonly intent?: UserStopIntent };

/** Fails toward stopped: an unreadable or corrupt marker is treated as a stop, so nothing restarts the session on its own. */
export async function userStopState(root: string, repositoryId: string | undefined, sessionName: string): Promise<UserStopState> {
  try {
    const intent = await readUserStopIntent(root, repositoryId, sessionName);
    return intent ? { stopped: true, intent } : { stopped: false };
  } catch { return { stopped: true }; }
}

/** Operator-facing text shared by the director start refusal and the Director tool error. */
export function userStopMessages(intent: UserStopIntent | undefined): { message: string; fix: string } {
  return {
    message: intent
      ? `Người dùng đã dừng phiên Bflow lúc ${intent.requestedAt} (${intent.source}). Director không tự khởi động lại.`
      : "Người dùng đã dừng phiên Bflow (không đọc được chi tiết dấu dừng). Director không tự khởi động lại.",
    fix: "Báo cho người dùng và kết thúc lượt. Chỉ chạy `bflow director start --restart` khi người dùng yêu cầu khởi động lại trong tin nhắn mới nhất của họ."
  };
}

export const SESSION_STOPPED_BY_USER = "session_stopped_by_user";
