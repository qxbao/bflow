import { z } from "zod";
import { IdentifierSchema, JsonValueSchema, MetadataSchema } from "./common.js";

export const AgentConfigurationSchema = z
  .object({
    agentId: IdentifierSchema,
    role: z.string().min(1),
    transport: z.string().min(1),
    enabled: z.boolean(),
    priority: z.number().int(),
    maxConcurrentTasks: z.number().int().min(1),
    capabilities: z.array(z.string().min(1)),
    settings: JsonValueSchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const AgentResolutionContextSchema = z
  .object({
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    requiredCapabilities: z.array(z.string().min(1)),
    preferredAgentId: IdentifierSchema.optional(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;
export type AgentResolutionContext = z.infer<typeof AgentResolutionContextSchema>;
