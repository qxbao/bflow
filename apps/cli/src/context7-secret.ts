import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the Context7 API key lives: a private file in the machine state directory, read by the Gateway daemon. */
export function context7KeyPath(paths: { readonly state: string }): string {
  return join(paths.state, "secrets", "context7-api-key");
}

export type KeyValidation = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly reason: string };

/**
 * Context7 keys start with `ctx7sk` (the hosted server says so when it rejects another prefix). Validation stops
 * obviously wrong input such as a pasted URL or a key with embedded whitespace from being stored and sent as a header.
 */
export function validateContext7ApiKey(raw: string): KeyValidation {
  const key = raw.replace(/\r?\n$/, "").trim();
  if (!key) return { ok: false, reason: "The Context7 API key is empty." };
  if (/\s/.test(key)) return { ok: false, reason: "The Context7 API key must not contain whitespace." };
  if (!/^ctx7sk[-_A-Za-z0-9]{8,}$/.test(key)) return { ok: false, reason: "A Context7 API key starts with 'ctx7sk' and contains only letters, digits, '-' and '_'." };
  if (key.length > 256) return { ok: false, reason: "The Context7 API key is unreasonably long." };
  return { ok: true, key };
}

/** Short digest used only to notice that the key changed. It is not reversible for a random key of this length. */
export function context7KeyFingerprint(key: string): string {
  return createHash("sha256").update(`bflow-context7|${key}`).digest("hex").slice(0, 16);
}

export type StoredKey =
  | { readonly status: "absent" }
  | { readonly status: "unsafe"; readonly reason: string }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "ok"; readonly key: string };

/** Reads the stored key, refusing a symlink, a file that is not ours, or one other accounts could read. */
export async function readStoredContext7Key(paths: { readonly state: string }): Promise<StoredKey> {
  const file = context7KeyPath(paths);
  let info;
  try { info = await lstat(file); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unsafe", reason: "The key file cannot be inspected." }; }
  if (!info.isFile() || info.isSymbolicLink()) return { status: "unsafe", reason: "The key path is not a regular file." };
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) return { status: "unsafe", reason: "The key file is readable by other accounts; run 'chmod 600' or store the key again." };
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return { status: "unsafe", reason: "The key file belongs to another account." };
  }
  const validated = validateContext7ApiKey(await readFile(file, "utf8"));
  return validated.ok ? { status: "ok", key: validated.key } : { status: "invalid", reason: validated.reason };
}

/** Stores the key atomically with owner-only permissions. The key never goes through the setup journal or its backups. */
export async function writeStoredContext7Key(paths: { readonly state: string }, key: string): Promise<void> {
  const file = context7KeyPath(paths);
  const directory = join(paths.state, "secrets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${key}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function removeStoredContext7Key(paths: { readonly state: string }): Promise<void> {
  await rm(context7KeyPath(paths), { force: true });
}

/** Reads the whole of standard input (used by `setup --context7-api-key-stdin`). Bounded to avoid a runaway pipe. */
export async function readKeyFromStream(stream: AsyncIterable<Buffer | string>, maxBytes = 4096): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length > maxBytes) throw new Error("The key input is too long.");
  }
  return text;
}
