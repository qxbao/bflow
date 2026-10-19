import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";
import { CODEX_CONFIG_HOOK_MAX_BYTES } from "./codex-hook-toml.js";

/** Read only bounded regular configuration; never follow a replaced final symlink or block on a FIFO. */
async function readProbeConfig(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(CODEX_CONFIG_HOOK_MAX_BYTES)) throw new Error("Ineligible probe configuration");
    const bytes = Buffer.alloc(CODEX_CONFIG_HOOK_MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (total > CODEX_CONFIG_HOOK_MAX_BYTES || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
      throw new Error("Probe configuration changed during inspection");
    return bytes.toString("utf8", 0, total);
  } finally { await handle.close(); }
}

/**
 * Over-approximate every layer/profile rather than guessing which profile Codex selects. Relative
 * instruction paths and non-basename fallback names have unproven resolution semantics: opt out.
 * No credential values or unrelated configuration are returned or included in public fingerprints.
 */
export async function codexProbeConfigDependencies(configPaths: readonly string[]): Promise<{
  readonly requiredFiles: readonly string[];
  readonly fallbackNames: readonly string[];
} | undefined> {
  if (configPaths.length > 64) return undefined;
  const requiredFiles = new Set<string>();
  const fallbackNames = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 16) throw new Error("Probe configuration exceeds dependency inspection limits");
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "model_instructions_file") {
        if (typeof entry !== "string" || entry.length > 4096 || !isAbsolute(entry) || /[~$\\\0\r\n]/.test(entry))
          throw new Error("Unproven model instruction path");
        requiredFiles.add(resolve(entry));
      } else if (key === "project_doc_fallback_filenames") {
        if (!Array.isArray(entry) || entry.some(name => typeof name !== "string" ||
            !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name === "." || name === ".."))
          throw new Error("Unproven project document path");
        for (const name of entry) fallbackNames.add(name);
      } else {
        // Older/new provider versions may load additional files (e.g. experimental_instructions_file
        // or model_catalog_json). Do not interpret an unfamiliar selector as inline, immutable data.
        if (key === "model_catalog_json" || /(?:^|_)(?:files?|paths?|director(?:y|ies)|dirs?)(?:_|$)/i.test(key))
          throw new Error("Unproven configuration file dependency");
        visit(entry, depth + 1);
      }
      if (requiredFiles.size > 64 || fallbackNames.size > 64) throw new Error("Too many probe dependencies");
    }
  };
  try {
    for (const path of configPaths) {
      let text: string;
      try { text = await readProbeConfig(path); }
      catch (error) {
        // Absence is separately pinned by the caller's before/after metadata snapshots.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return undefined;
      }
      visit(parse(text, { unsafeKeyBehaviour: "throw" }), 0);
    }
    return { requiredFiles: [...requiredFiles], fallbackNames: [...fallbackNames] };
  } catch { return undefined; }
}
