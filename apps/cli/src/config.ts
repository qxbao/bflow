import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  WorkflowDefinitionSchema,
  type OperationResult,
  type WorkflowDefinition
} from "@ai-flow/contracts";
import type { FlowRepositoryConfig, InitCommandOutput } from "./types.js";

export const DEFAULT_CONFIG_RELATIVE_PATH = ".ai-flow/config.json";

export function createDefaultWorkflowDefinition(): WorkflowDefinition {
  const definition: WorkflowDefinition = {
    schemaVersion: "1",
    id: "sdlc-standard-workflow",
    name: "SDLC Standard 4-Task Workflow",
    version: "1.0.0",
    description: "Standard 4-task SDLC orchestration: Plan -> Implement -> Review -> QA",
    maxConcurrency: 2,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    qualityGates: [],
    tasks: [
      {
        id: "plan",
        title: "Architecture & Specification Planning",
        role: "planner",
        instruction: "Draft technical architecture and specification document",
        acceptanceCriteria: ["Technical specification complete"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement",
        title: "Feature Implementation & Unit Tests",
        role: "developer",
        instruction: "Implement feature code and unit tests",
        acceptanceCriteria: ["Feature implemented", "Unit tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks: 2,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Code Review & Quality Gate Audit",
        role: "reviewer",
        instruction: "Review implementation diff and quality verification evidence",
        acceptanceCriteria: ["Review decision rendered"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks: 2,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA & Integration Testing",
        role: "qa",
        instruction: "Execute integration and end-to-end acceptance tests",
        acceptanceCriteria: ["All acceptance tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: true,
        qualityGates: []
      }
    ],
    dependencies: [
      { taskId: "implement", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "implement", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ]
  };

  const parsed = WorkflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    throw new Error(`Default workflow definition is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function createDefaultRepositoryConfig(options?: {
  readonly projectName?: string | undefined;
  readonly runtimeId?: string | undefined;
  readonly createdAt?: string | undefined;
}): FlowRepositoryConfig {
  return {
    schemaVersion: "1",
    projectName: options?.projectName ?? "ai-flow-project",
    runtimeId: options?.runtimeId ?? `runtime-${randomUUID()}`,
    createdAt: options?.createdAt ?? new Date().toISOString(),
    storage: {
      runStorePath: ".ai-flow/data/runs.db",
      artifactStoreRoot: ".ai-flow/artifacts",
      registryStateFile: ".ai-flow/registry/state.json"
    },
    defaultWorkflow: createDefaultWorkflowDefinition()
  };
}

export function resolveConfigPath(cwd: string, configPath?: string, dir?: string): string {
  if (configPath !== undefined) {
    if (isAbsolute(configPath)) {
      return configPath;
    }
    const baseDir = dir !== undefined ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : cwd;
    return resolve(baseDir, configPath);
  }
  const targetDir = dir !== undefined ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : cwd;
  return resolve(targetDir, DEFAULT_CONFIG_RELATIVE_PATH);
}

export async function loadRepositoryConfig(
  configPath: string
): Promise<OperationResult<FlowRepositoryConfig>> {
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return {
      ok: false,
      error: {
        code: "not_found",
        retryable: false,
        message: `Configuration file not found at '${configPath}'.`
      }
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' contains invalid JSON.`
      }
    };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' must be a JSON object.`
      }
    };
  }

  const obj = raw as Record<string, unknown>;
  if (obj["schemaVersion"] !== "1") {
    const parsedNum =
      typeof obj["schemaVersion"] === "number"
        ? obj["schemaVersion"]
        : typeof obj["schemaVersion"] === "string" && /^\d+$/.test(obj["schemaVersion"])
          ? Number.parseInt(obj["schemaVersion"], 10)
          : 0;
    const receivedVersion = Number.isInteger(parsedNum) && parsedNum >= 0 ? parsedNum : 0;
    return {
      ok: false,
      error: {
        code: "unsupported_version",
        retryable: false,
        supportedVersions: [1],
        receivedVersion,
        message: `Unsupported config schema version '${String(obj["schemaVersion"])}'. Expected '1'.`
      }
    };
  }

  if (typeof obj["projectName"] !== "string" || obj["projectName"].trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' is missing required field 'projectName'.`
      }
    };
  }

  if (typeof obj["runtimeId"] !== "string" || obj["runtimeId"].trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' is missing required field 'runtimeId'.`
      }
    };
  }

  if (typeof obj["createdAt"] !== "string") {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' is missing required field 'createdAt'.`
      }
    };
  }

  const storage = obj["storage"];
  if (typeof storage !== "object" || storage === null || Array.isArray(storage)) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' is missing required 'storage' configuration.`
      }
    };
  }

  const storageObj = storage as Record<string, unknown>;
  if (
    typeof storageObj["runStorePath"] !== "string" ||
    storageObj["runStorePath"].trim().length === 0 ||
    typeof storageObj["artifactStoreRoot"] !== "string" ||
    storageObj["artifactStoreRoot"].trim().length === 0 ||
    typeof storageObj["registryStateFile"] !== "string" ||
    storageObj["registryStateFile"].trim().length === 0
  ) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file at '${configPath}' has invalid 'storage' configuration.`
      }
    };
  }

  const wfParse = WorkflowDefinitionSchema.safeParse(obj["defaultWorkflow"]);
  if (!wfParse.success) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Configuration file contains invalid defaultWorkflow: ${wfParse.error.issues[0]?.message ?? "validation failed"}`
      }
    };
  }

  const config: FlowRepositoryConfig = {
    schemaVersion: "1",
    projectName: obj["projectName"],
    runtimeId: obj["runtimeId"],
    createdAt: obj["createdAt"],
    storage: {
      runStorePath: storageObj["runStorePath"],
      artifactStoreRoot: storageObj["artifactStoreRoot"],
      registryStateFile: storageObj["registryStateFile"]
    },
    defaultWorkflow: wfParse.data
  };

  return { ok: true, value: config };
}

export async function loadWorkflowDefinitionFromFile(
  workflowPath: string
): Promise<OperationResult<WorkflowDefinition>> {
  let content: string;
  try {
    content = await readFile(workflowPath, "utf-8");
  } catch {
    return {
      ok: false,
      error: {
        code: "not_found",
        retryable: false,
        message: `Workflow definition file not found at '${workflowPath}'.`
      }
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Workflow definition file at '${workflowPath}' contains invalid JSON.`
      }
    };
  }

  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid workflow definition in '${workflowPath}': ${issues}`
      }
    };
  }

  return { ok: true, value: parsed.data };
}

export async function initRepositoryConfig(options: {
  readonly cwd: string;
  readonly dir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly projectName?: string | undefined;
  readonly force: boolean;
  readonly clock?: (() => Date) | undefined;
  readonly confirmOverwrite?: ((configPath: string) => Promise<boolean> | boolean) | undefined;
}): Promise<OperationResult<InitCommandOutput>> {
  const targetPath = resolveConfigPath(options.cwd, options.configPath, options.dir);

  let fileExists = false;
  try {
    await access(targetPath);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  let overwritten = false;
  if (fileExists) {
    if (options.force) {
      overwritten = true;
    } else if (options.confirmOverwrite !== undefined) {
      const confirmed = await options.confirmOverwrite(targetPath);
      if (!confirmed) {
        return {
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
            message: `Configuration file already exists at '${targetPath}'. Pass --force (or --yes) to overwrite.`
          }
        };
      }
      overwritten = true;
    } else {
      return {
        ok: false,
        error: {
          code: "conflict",
          retryable: true,
          message: `Configuration file already exists at '${targetPath}'. Pass --force (or --yes) to overwrite.`
        }
      };
    }
  }

  const now = options.clock !== undefined ? options.clock() : new Date();
  const config = createDefaultRepositoryConfig({
    ...(options.projectName !== undefined ? { projectName: options.projectName } : {}),
    createdAt: now.toISOString()
  });

  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "corruption",
        retryable: false,
        message: `Failed to write configuration file to '${targetPath}': ${err instanceof Error ? err.message : String(err)}`
      }
    };
  }

  return {
    ok: true,
    value: {
      configPath: targetPath,
      config,
      overwritten
    }
  };
}
