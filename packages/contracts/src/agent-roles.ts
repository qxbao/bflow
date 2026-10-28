import { z } from "zod";

export const AGENT_ROLES = ["conversation", "coordinator", "planner", "architect", "specifier", "developer", "tester", "reviewer", "qa", "security"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
