import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRoleTopologySpec, type RoleSelector, type TopologyRole } from "./types.js";

export const NON_USER_FACING_AUTONOMOUS_POLICY = `You are a non-user-facing execution agent.

The user does not monitor or read your pane.

Do not ask the user questions. Do not wait for a user response. Do not request conversational permission to continue.

Execute your assigned task autonomously using the tools, skills, and permissions available to you.

When information is missing, make a reversible, low-risk assumption and record it.

If a decision requires user approval, changes an approved specification, or exceeds your authority, send a structured escalation to Coordinator through Herdr and mark the task as blocked.

Never treat the lack of a user response in your pane as permission to bypass a security or approval boundary.

Do not claim success without verification evidence.

When finished, emit a structured result and notify Coordinator.`;

export const STRUCTURED_RESULT_REQUIRED_FIELDS = Object.freeze([
  "status",
  "summary",
  "evidence",
  "artifacts",
  "blockers",
  "requested_action",
  "next_role"
] as const);

const ROLE_PROMPT_CANDIDATE_PATHS: Record<TopologyRole, readonly string[]> = {
  chat: ["chat/system-prompt.md"],
  coordinator: ["coordinator/system-prompt.md"],
  analyst: ["analyst/system-prompt.md", "analyst/prompt.md"],
  architect: ["architect/system-prompt.md", "architect/prompt.md"],
  planner: ["planner/system-prompt.md"],
  developer: ["developer/system-prompt.md"],
  reviewer: ["reviewer/system-prompt.md"],
  "qa-verifier": ["verifier/system-prompt.md", "verifier/prompt.md"]
};

/** Installed assets, never a prompt selected from the user's working repository. */
export async function readBuiltinRolePrompt(role: RoleSelector): Promise<{ prompt: string; source: string } | null> {
  const topology = getRoleTopologySpec(role)?.topologyRole;
  if (!topology) return null;
  const candidates = ROLE_PROMPT_CANDIDATE_PATHS[topology];
  if (!candidates || candidates.length === 0) return null;

  let lastError: unknown = null;
  let lastSource = "";

  for (const relative of candidates) {
    const source = fileURLToPath(new URL("../../../agents/" + relative, import.meta.url));
    lastSource = source;
    let file;
    try {
      file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) {
        throw new Error("Prompt must be a regular file at most 64 KiB");
      }
      const prompt = await file.readFile("utf8");
      if (!prompt.trim()) {
        throw new Error("Prompt is empty");
      }
      return { prompt, source };
    } catch (error) {
      lastError = error;
    } finally {
      await file?.close();
    }
  }

  throw new Error(
    `Cannot load the original ${role} agent prompt at ${lastSource}. Rebuild/reinstall the complete Bflow package, including agents/. ${String(lastError)}`
  );
}
