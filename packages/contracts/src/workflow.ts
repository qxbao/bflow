import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonValueSchema, MetadataSchema } from "./common.js";
import {
  BlockageSchema,
  RecoveryPolicySchema,
  RetryPolicySchema,
  RunStatusSchema,
  TaskStatusSchema,
  TimeoutPolicySchema
} from "./execution.js";

export const TaskDefinitionSchema = z
  .object({
    id: IdentifierSchema,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    role: z.string().min(1),
    instruction: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    input: JsonValueSchema.optional(),
    retry: RetryPolicySchema,
    timeout: TimeoutPolicySchema,
    requiresApproval: z.boolean(),
    metadata: MetadataSchema.optional()
  })
  .strict();

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

  for (const [index, dependency] of workflow.dependencies.entries()) {
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
    agentExecutionId: IdentifierSchema.optional(),
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
