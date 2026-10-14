export type {
  AgentConfiguration,
  AgentRegistry,
  AgentResolutionContext
} from "@ai-flow/contracts";
export { createAgentRegistry, FileAgentRegistry } from "./registry.js";
export type { FileAgentRegistryOptions } from "./registry.js";

// MVP Roles & Profiles
export * from "./roles.js";

// Content Safety & Prompt Injection Guardrails
export * from "./safety.js";

// Parameterized Prompt Rendering
export * from "./prompts.js";

// Structured Output Validation & Contract Mappers
export * from "./outputs.js";

// Role-to-Role Artifact Handoff (exclude ArtifactKind to prevent collision with roles.js)
export {
  ROLE_ARTIFACT_HANDOFF_RULES,
  createRoleArtifactHandoff,
  ingestRoleArtifactProposals,
  type ArtifactHandoffRule,
  type CreateArtifactHandoffRequest,
  type RoleArtifactHandoff
} from "./handoff.js";

// Workflow Definitions & Loader
export * from "./workflows.js";

// End-to-end Feature Workflow Example
export * from "./feature-example.js";
