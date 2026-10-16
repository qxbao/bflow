import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRoleTopologySpec, type RoleSelector } from "./types.js";

/** Installed assets, never a prompt selected from the user's working repository. */
export async function readBuiltinRolePrompt(role: RoleSelector): Promise<{ prompt: string; source: string } | null> {
  const topology = getRoleTopologySpec(role)?.topologyRole;
  const sources: Record<string, string> = { chat: "chat/system-prompt.md", coordinator: "coordinator/system-prompt.md",
    analyst: "analyst/system-prompt.md", architect: "architect/system-prompt.md", "qa-verifier": "verifier/prompt.md" };
  const relative = topology && sources[topology]; if (!relative) return null;
  const source = fileURLToPath(new URL("../../../agents/" + relative, import.meta.url));
  let file;
  try {
    file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error("Prompt must be a regular file at most 64 KiB");
    const prompt = await file.readFile("utf8"); if (!prompt.trim()) throw new Error("Prompt is empty");
    return { prompt, source };
  } catch (error) {
    throw new Error(`Cannot load the original ${role} agent prompt at ${source}. Rebuild/reinstall the complete Bflow package, including agents/. ${String(error)}`);
  } finally { await file?.close(); }
}
