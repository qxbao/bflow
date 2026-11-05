import type { DirectorNdjsonSupervisorOptions } from "./director-wake-agy.js";
import { claudeDirectorArgs, classifyClaudeDirectorEvent, encodeClaudeDirectorPrompt } from "./director-wake-claude.js";

export type ClaudeDirectorSupervisorInput = Omit<DirectorNdjsonSupervisorOptions, "provider" | "args" | "protocol">;

/** Provider-local configuration for one supervised, persistent Claude Code process. */
export function createClaudeDirectorSupervisorOptions(input: ClaudeDirectorSupervisorInput): DirectorNdjsonSupervisorOptions {
  return {
    ...input,
    provider: "claude",
    args: claudeDirectorArgs(),
    protocol: { encodePrompt: encodeClaudeDirectorPrompt, classifyEvent: classifyClaudeDirectorEvent }
  };
}
