import { AgentBindingVerificationSchema } from "./receipts.js";
import { z } from "zod";
import { AgentExecutionHandleSchema } from "./agent.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema, MetadataSchema } from "./common.js";
import {
  BlockageSchema,
  RecoveryPolicySchema,
  ReworkPolicySchema,
  RetryPolicySchema,
  RunStatusSchema,
  TaskStatusSchema,
  TimeoutPolicySchema
} from "./execution.js";
import { QualityGateBindingSchema, QualityGateDefinitionSchema } from "./quality.js";
import { RoleProfilePinSchema, SpecialistRoleSchema } from "./role-profile.js";

export const TaskDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    role: z.string().min(1),
    roleProfile: RoleProfilePinSchema.optional(),
    instruction: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    input: JsonValueSchema.optional(),
    retry: RetryPolicySchema,
    rework: ReworkPolicySchema.optional(),
    timeout: TimeoutPolicySchema,
    requiresApproval: z.boolean(),
    qualityGates: z.array(QualityGateBindingSchema),
    metadata: MetadataSchema.optional()
  })
  .strict().superRefine((task, ctx) => {
    if (task.roleProfile && !SpecialistRoleSchema.safeParse(task.role).success) ctx.addIssue({ code: "custom", message: "profiled task requires a standard specialist governance role", path: ["role"] });
  });

export const TaskDependencySchema = z
  .object({
    taskId: IdentifierSchema,
    dependsOnTaskId: IdentifierSchema,
    condition: z.enum(["succeeded", "completed"])
  })
  .strict();

const WorkflowDefinitionBaseSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: IdentifierSchema,
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1).optional(),
    tasks: z.array(TaskDefinitionSchema).min(1),
    dependencies: z.array(TaskDependencySchema),
    qualityGates: z.array(QualityGateDefinitionSchema),
    maxConcurrency: z.number().int().min(1),
    failurePolicy: z.enum(["fail-fast", "continue-independent", "block"]),
    recovery: RecoveryPolicySchema,
    metadata: MetadataSchema.optional()
  })
  .strict();

export const WorkflowDefinitionSchema = WorkflowDefinitionBaseSchema.superRefine((workflow, context) => {
  const taskIds = new Set<string>();
  for (const [index, task] of workflow.tasks.entries()) {
    if (taskIds.has(task.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate task id: ${task.id}`,
        path: ["tasks", index, "id"]
      });
    }
    taskIds.add(task.id);
  }

  const dependencyGraph = new Map<string, string[]>();
  for (const taskId of taskIds) dependencyGraph.set(taskId, []);

  const dependencyKeys = new Set<string>();
  for (const [index, dependency] of workflow.dependencies.entries()) {
    const dependencyKey = `${dependency.taskId}\u0000${dependency.dependsOnTaskId}\u0000${dependency.condition}`;
    if (dependencyKeys.has(dependencyKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate task dependency",
        path: ["dependencies", index]
      });
    }
    dependencyKeys.add(dependencyKey);
    if (!taskIds.has(dependency.taskId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown dependent task: ${dependency.taskId}`,
        path: ["dependencies", index, "taskId"]
      });
    }
    if (!taskIds.has(dependency.dependsOnTaskId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown prerequisite task: ${dependency.dependsOnTaskId}`,
        path: ["dependencies", index, "dependsOnTaskId"]
      });
    }
    if (dependency.taskId === dependency.dependsOnTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A task cannot depend on itself",
        path: ["dependencies", index]
      });
    }
    dependencyGraph.get(dependency.taskId)?.push(dependency.dependsOnTaskId);
  }

  const gateIds = new Set<string>();
  for (const [index, gate] of workflow.qualityGates.entries()) {
    if (gateIds.has(gate.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate quality gate id: ${gate.id}`,
        path: ["qualityGates", index, "id"]
      });
    }
    gateIds.add(gate.id);
  }
  for (const [taskIndex, task] of workflow.tasks.entries()) {
    const bindingIds = new Set<string>();
    for (const [bindingIndex, binding] of task.qualityGates.entries()) {
      const bindingKey = `${binding.gateId}\u0000${binding.phase}`;
      if (!gateIds.has(binding.gateId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown quality gate: ${binding.gateId}`,
          path: ["tasks", taskIndex, "qualityGates", bindingIndex, "gateId"]
        });
      }
      if (bindingIds.has(bindingKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate quality gate binding",
          path: ["tasks", taskIndex, "qualityGates", bindingIndex]
        });
      }
      bindingIds.add(bindingKey);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const containsCycle = (taskId: string): boolean => {
    if (active.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    active.add(taskId);
    for (const dependency of dependencyGraph.get(taskId) ?? []) {
      if (containsCycle(dependency)) return true;
    }
    active.delete(taskId);
    visited.add(taskId);
    return false;
  };

  if ([...taskIds].some((taskId) => containsCycle(taskId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow dependencies must form an acyclic graph",
      path: ["dependencies"]
    });
  }
});

export const TaskStateSchema = z
  .object({
    taskId: IdentifierSchema,
    status: TaskStatusSchema,
    attempt: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    attemptId: IdentifierSchema.optional(),
    agentExecution: AgentExecutionHandleSchema.optional(),
    bindingVerification: AgentBindingVerificationSchema.optional(),
    blockage: BlockageSchema.optional(),
    startedAt: IsoDateTimeSchema.optional(),
    completedAt: IsoDateTimeSchema.optional(),
    version: z.number().int().nonnegative()
  })
  .strict();

export const WorkflowRunSnapshotSchema = z
  .object({
    runId: IdentifierSchema,
    workflowId: IdentifierSchema,
    workflowVersion: z.string().min(1),
    status: RunStatusSchema,
    input: JsonValueSchema.optional(),
    tasks: z.array(TaskStateSchema),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    version: z.number().int().nonnegative(),
    lastEventSequence: z.number().int().nonnegative(),
    metadata: MetadataSchema.optional()
  })
  .strict();

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type TaskDependency = z.infer<typeof TaskDependencySchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;
