import { z } from "zod";
import { AGENT_ROLES, AgentProviderIdSchema, type AgentProviderId } from "@bflow/contracts";

/** Governance roles plus the on-demand `sos` rescue role that repository configuration may carry. */
export const PRESET_ROLES = [...AGENT_ROLES, "sos"] as const;
export const PresetRoleSchema = z.enum(PRESET_ROLES);
export type PresetRole = z.infer<typeof PresetRoleSchema>;

export const RoleModelAssignmentSchema = z.object({
  cli: AgentProviderIdSchema,
  /** Absent means the provider CLI's own default model. */
  model: z.string().trim().min(1).optional(),
  /** Set when the preset's provider cannot run the role and another provider was substituted. */
  fallbackReason: z.string().min(1).optional()
}).strict();
export type RoleModelAssignment = z.infer<typeof RoleModelAssignmentSchema>;

export const RoleModelPresetSchema = z.object({
  provider: AgentProviderIdSchema,
  description: z.string().min(1),
  roles: z.record(PresetRoleSchema, RoleModelAssignmentSchema)
}).strict().superRefine((preset, context) => {
  for (const role of PRESET_ROLES) {
    if (!preset.roles[role]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role], message: "Every role needs a preset entry" });
  }
});
export type RoleModelPreset = z.infer<typeof RoleModelPresetSchema>;

/** Model ids follow the suggestions already shipped in the repository config template. */
const CLAUDE_REASONING = "claude-opus-4-7";
const CLAUDE_EXECUTION = "claude-sonnet-4-6";
const CODEX_REASONING = "gpt-5.4";
const CODEX_EXECUTION = "gpt-5.4-mini";

/** Agy Conversation is unsupported (only specialist native binding is), so the agy preset routes it to Claude. */
export const AGY_CONVERSATION_FALLBACK_REASON =
  "Agy does not support the Conversation role; it falls back to Claude Code.";

function uniform(cli: AgentProviderId, reasoning: string, execution: string): Record<PresetRole, RoleModelAssignment> {
  const reasoningRoles: ReadonlySet<PresetRole> = new Set(["coordinator", "planner", "architect", "specifier", "reviewer", "security", "sos"]);
  const conversationModel = cli === "codex" ? reasoning : execution;
  return Object.fromEntries(PRESET_ROLES.map(role => [role, {
    cli,
    model: role === "conversation" ? conversationModel : reasoningRoles.has(role) ? reasoning : execution
  }])) as Record<PresetRole, RoleModelAssignment>;
}

const RAW_PRESETS: Record<AgentProviderId, unknown> = {
  claude: {
    provider: "claude",
    description: "Claude Code: Opus for coordination, analysis, architecture and review; Sonnet for conversation, implementation and testing.",
    roles: uniform("claude", CLAUDE_REASONING, CLAUDE_EXECUTION)
  },
  codex: {
    provider: "codex",
    description: "Codex: gpt-5.4 for conversation, coordination, analysis, architecture, implementation and review; gpt-5.4-mini for testing and QA.",
    roles: { ...uniform("codex", CODEX_REASONING, CODEX_EXECUTION), developer: { cli: "codex", model: CODEX_REASONING } }
  },
  agy: {
    provider: "agy",
    // Agy model ids come from `agy models` and vary by account/version; preflight rejects an id outside that catalog,
    // so the preset keeps Agy's own default model instead of guessing one.
    description: "Antigravity: specialist roles use the Agy default model (pick ids from 'agy models'); Conversation uses Claude Code.",
    roles: Object.fromEntries(PRESET_ROLES.map(role => [role, role === "conversation"
      ? { cli: "claude", model: CLAUDE_EXECUTION, fallbackReason: AGY_CONVERSATION_FALLBACK_REASON }
      : { cli: "agy" }]))
  }
};

/** Validated once at load: a malformed static preset is a programming error, not a runtime condition. */
export const ROLE_MODEL_PRESETS: Readonly<Record<AgentProviderId, RoleModelPreset>> = Object.freeze({
  claude: RoleModelPresetSchema.parse(RAW_PRESETS.claude),
  codex: RoleModelPresetSchema.parse(RAW_PRESETS.codex),
  agy: RoleModelPresetSchema.parse(RAW_PRESETS.agy)
});

export function roleModelPreset(provider: AgentProviderId): RoleModelPreset {
  return ROLE_MODEL_PRESETS[AgentProviderIdSchema.parse(provider)];
}

export function presetAssignment(provider: AgentProviderId, role: PresetRole): RoleModelAssignment {
  return roleModelPreset(provider).roles[PresetRoleSchema.parse(role)]!;
}
