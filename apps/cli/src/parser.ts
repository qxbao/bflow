import {
  AgentRoleSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  RunStatusSchema,
  type ContractError,
  type RunStatus
} from "@bflow/contracts";
import { isHumanApprover } from "@bflow/runtime";
import type {
  AgentCheckCommandArgs,
  ApproveCommandArgs,
  CancelCommandArgs,
  ConfigMigrateCommandArgs,
  CliCommandName,
  GitPrepareCommandArgs,
  GitPrepareTaskDependencyInput,
  HelpCommandArgs,
  HighLevelCommandName,
  HighLevelCommonFlags,
  InitCommandArgs,
  McpStatusCommandArgs,
  ParseCliResult,
  RepoInspectCommandArgs,
  ResumeCommandArgs,
  RunCommandArgs,
  SetupCommandArgs,
  SkillsSyncCommandArgs,
  StatusCommandArgs,
  TaskImplementCommandArgs,
  TaskPlanCommandArgs,
  ToolStatusCommandArgs,
  VerifyCommandArgs,
  VersionCommandArgs
} from "./types.js";

const VALID_COMMANDS: ReadonlySet<CliCommandName> = new Set([
  "up",
  "down",
  "attach",
  "doctor",
  "recover",
  "init",
  "config-migrate",
  "setup",
  "docs",
  "run",
  "status",
  "approve",
  "resume",
  "cancel",
  "help",
  "version",
  "repo inspect",
  "task plan",
  "task implement",
  "verify",
  "git prepare",
  "mcp status",
  "tool status",
  "skills sync",
  "agent check"
]);

const HIGH_LEVEL_PREFIXES: ReadonlySet<string> = new Set([
  "repo",
  "task",
  "verify",
  "git",
  "mcp",
  "tool",
  "tools",
  "skills",
  "agent"
]);

const COMMON_HIGH_LEVEL_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "-j",
  "--help",
  "-h",
  "--correlation-id",
  "--idempotency-key",
  "--resume",
  "--actor",
  "--by",
  "--role",
  "--permission-mode",
  "--session-id",
  "--isolation"
]);

const COMMON_HIGH_LEVEL_BOOLEANS: ReadonlySet<string> = new Set([
  "--json",
  "-j",
  "--help",
  "-h",
  "--resume"
]);

const GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "-j",
  "--help",
  "-h",
  "--version",
  "-v"
]);

function isFlag(arg: string): boolean {
  return arg.startsWith("-") && !/^-\d+$/.test(arg);
}

function isValidIdentifier(val: string): boolean {
  if (/\s/.test(val)) return false;
  return IdentifierSchema.safeParse(val).success;
}

function makeValidationError(
  message: string,
  json: boolean,
  command?: CliCommandName
): ParseCliResult {
  const error: ContractError = {
    code: "validation",
    retryable: false,
    message
  };
  return {
    ok: false,
    error,
    ...(command !== undefined ? { command } : {}),
    json
  };
}

interface ParsedOptions {
  readonly flags: Map<string, string | true>;
  readonly positional: readonly string[];
}

function extractOptionsAndPositional(
  args: readonly string[],
  booleanFlags: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string>,
  command: CliCommandName,
  json: boolean
): { readonly ok: true; readonly value: ParsedOptions } | { readonly ok: false; readonly result: ParseCliResult } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--") {
      for (let j = i + 1; j < args.length; j++) {
        positional.push(args[j]!);
      }
      break;
    }

    if (isFlag(arg)) {
      let flagName: string;
      let flagValue: string | undefined;

      const equalsIndex = arg.indexOf("=");
      if (equalsIndex !== -1) {
        flagName = arg.slice(0, equalsIndex);
        flagValue = arg.slice(equalsIndex + 1);
      } else {
        flagName = arg;
      }

      if (!allowedFlags.has(flagName)) {
        return {
          ok: false,
          result: makeValidationError(`Unknown option '${flagName}' for command '${command}'.`, json, command)
        };
      }

      if (equalsIndex !== -1 && booleanFlags.has(flagName)) {
        return {
          ok: false,
          result: makeValidationError(`Option '${flagName}' does not take a value.`, json, command)
        };
      }

      if (equalsIndex !== -1 && flagValue !== undefined && flagValue.length === 0) {
        return {
          ok: false,
          result: makeValidationError(`Option '${flagName}' requires a value.`, json, command)
        };
      }

      if (booleanFlags.has(flagName)) {
        flags.set(flagName, true);
        continue;
      }

      if (flagValue !== undefined) {
        flags.set(flagName, flagValue);
      } else {
        const nextArg = args[i + 1];
        if (nextArg === undefined || isFlag(nextArg)) {
          return {
            ok: false,
            result: makeValidationError(`Option '${flagName}' requires a value.`, json, command)
          };
        }
        flags.set(flagName, nextArg);
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { ok: true, value: { flags, positional } };
}

interface HighLevelParsedOptions {
  readonly flags: Map<string, string>;
  readonly multiFlags: Map<string, string[]>;
  readonly booleanFlags: Set<string>;
  readonly positional: readonly string[];
}

function extractHighLevelOptions(
  args: readonly string[],
  booleanFlags: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string>,
  command: HighLevelCommandName,
  json: boolean
): { readonly ok: true; readonly value: HighLevelParsedOptions } | { readonly ok: false; readonly result: ParseCliResult } {
  const flags = new Map<string, string>();
  const multiFlags = new Map<string, string[]>();
  const parsedBooleanFlags = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--") {
      for (let j = i + 1; j < args.length; j++) {
        positional.push(args[j]!);
      }
      break;
    }

    if (isFlag(arg)) {
      let flagName: string;
      let flagValue: string | undefined;

      const equalsIndex = arg.indexOf("=");
      if (equalsIndex !== -1) {
        flagName = arg.slice(0, equalsIndex);
        flagValue = arg.slice(equalsIndex + 1);
      } else {
        flagName = arg;
      }

      if (!allowedFlags.has(flagName)) {
        return {
          ok: false,
          result: makeValidationError(`Unknown option '${flagName}' for command '${command}'.`, json, command)
        };
      }

      if (equalsIndex !== -1 && booleanFlags.has(flagName)) {
        return {
          ok: false,
          result: makeValidationError(`Option '${flagName}' does not take a value.`, json, command)
        };
      }

      if (equalsIndex !== -1 && flagValue !== undefined && flagValue.length === 0) {
        return {
          ok: false,
          result: makeValidationError(`Option '${flagName}' requires a value.`, json, command)
        };
      }

      if (booleanFlags.has(flagName)) {
        parsedBooleanFlags.add(flagName);
        continue;
      }

      if (flagValue === undefined) {
        const nextArg = args[i + 1];
        if (nextArg === undefined || isFlag(nextArg)) {
          return {
            ok: false,
            result: makeValidationError(`Option '${flagName}' requires a value.`, json, command)
          };
        }
        flagValue = nextArg;
        i++;
      }

      flags.set(flagName, flagValue);
      const existing = multiFlags.get(flagName);
      if (existing) {
        existing.push(flagValue);
      } else {
        multiFlags.set(flagName, [flagValue]);
      }
    } else {
      positional.push(arg);
    }
  }

  return { ok: true, value: { flags, multiFlags, booleanFlags: parsedBooleanFlags, positional } };
}

function collectListOption(
  multiFlags: Map<string, string[]>,
  ...flagNames: readonly string[]
): string[] {
  const result: string[] = [];
  for (const name of flagNames) {
    const values = multiFlags.get(name);
    if (values) {
      for (const val of values) {
        for (const item of val.split(",")) {
          const trimmed = item.trim();
          if (trimmed.length > 0) {
            result.push(trimmed);
          }
        }
      }
    }
  }
  return result;
}

function parseHighLevelCommonFlags(
  opts: HighLevelParsedOptions,
  json: boolean,
  command: HighLevelCommandName
): { readonly ok: true; readonly value: HighLevelCommonFlags } | { readonly ok: false; readonly result: ParseCliResult } {
  const correlationId = opts.flags.get("--correlation-id");
  if (correlationId !== undefined) {
    if (!isValidIdentifier(correlationId)) {
      return {
        ok: false,
        result: makeValidationError(`Invalid correlation identifier '${correlationId}'.`, json, command)
      };
    }
  }

  const idempotencyKey = opts.flags.get("--idempotency-key");
  if (idempotencyKey !== undefined) {
    const idempParse = IdempotencyKeySchema.safeParse(idempotencyKey);
    if (!idempParse.success) {
      return {
        ok: false,
        result: makeValidationError(`Invalid idempotency key '${idempotencyKey}'.`, json, command)
      };
    }
  }

  const resume = opts.booleanFlags.has("--resume");

  const rawActor = opts.flags.get("--actor") ?? opts.flags.get("--by");
  let actor: string | undefined;
  if (rawActor !== undefined) {
    const flagUsed = opts.flags.has("--actor") ? "--actor" : "--by";
    if (rawActor.trim().length === 0) {
      return {
        ok: false,
        result: makeValidationError(`Option '${flagUsed}' cannot be empty.`, json, command)
      };
    }
    actor = rawActor.trim();
  }

  const rawRole = opts.flags.get("--role");
  let role: string | undefined;
  if (rawRole !== undefined) {
    const roleParse = AgentRoleSchema.safeParse(rawRole);
    if (!roleParse.success) {
      return {
        ok: false,
        result: makeValidationError(
          `Invalid role '${rawRole}'. Must be one of: ${AgentRoleSchema.options.join(", ")}.`,
          json,
          command
        )
      };
    }
    role = roleParse.data;
  }

  const rawPermissionMode = opts.flags.get("--permission-mode");
  let permissionMode: "restricted" | "workspace_auto" | "unattended_isolated" | undefined;
  if (rawPermissionMode !== undefined) {
    if (
      rawPermissionMode !== "restricted" &&
      rawPermissionMode !== "workspace_auto" &&
      rawPermissionMode !== "unattended_isolated"
    ) {
      return {
        ok: false,
        result: makeValidationError(
          `Invalid permission mode '${rawPermissionMode}'. Must be 'restricted', 'workspace_auto', or 'unattended_isolated'.`,
          json,
          command
        )
      };
    }
    permissionMode = rawPermissionMode;
  }

  const sessionId = opts.flags.get("--session-id");
  if (sessionId !== undefined) {
    if (!isValidIdentifier(sessionId)) {
      return {
        ok: false,
        result: makeValidationError(`Invalid session identifier '${sessionId}'.`, json, command)
      };
    }
  }

  const rawIsolation = opts.flags.get("--isolation");
  let isolation: "provider_policy" | "os_sandbox" | "container" | undefined;
  if (rawIsolation !== undefined) {
    if (
      rawIsolation !== "provider_policy" &&
      rawIsolation !== "os_sandbox" &&
      rawIsolation !== "container"
    ) {
      return {
        ok: false,
        result: makeValidationError(
          `Invalid isolation '${rawIsolation}'. Must be 'provider_policy', 'os_sandbox', or 'container'.`,
          json,
          command
        )
      };
    }
    isolation = rawIsolation;
  }

  return {
    ok: true,
    value: {
      json,
      help: false,
      correlationId,
      idempotencyKey,
      resume,
      actor,
      role,
      permissionMode,
      sessionId,
      isolation
    }
  };
}

function resolveHelpTopic(
  tokens: readonly string[]
): { readonly ok: true; readonly topic: CliCommandName } | { readonly ok: false; readonly topic: string } | undefined {
  if (tokens.length === 0) return undefined;
  const t0 = tokens[0]!;
  const t1 = tokens[1];

  if (t0 === "help") {
    const inner = tokens.slice(1).filter((a) => !isFlag(a));
    return resolveHelpTopic(inner);
  }

  if (t0 === "repo") {
    if (t1 === "inspect" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "repo inspect" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "task") {
    if (t1 === "plan") return { ok: true, topic: "task plan" };
    if (t1 === "implement") return { ok: true, topic: "task implement" };
    if (t1 === undefined || isFlag(t1)) return { ok: true, topic: "task plan" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "git") {
    if (t1 === "prepare" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "git prepare" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "mcp") {
    if (t1 === "status" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "mcp status" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "tool" || t0 === "tools") {
    if (t1 === "status" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "tool status" };
    return { ok: false, topic: "tool status" };
  }

  if (t0 === "skills") {
    if (t1 === "sync" || t1 === "list" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "skills sync" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "agent") {
    if (t1 === "check" || t1 === undefined || isFlag(t1)) return { ok: true, topic: "agent check" };
    return { ok: false, topic: `${t0} ${t1}` };
  }

  if (t0 === "verify") {
    return { ok: true, topic: "verify" };
  }

  if (VALID_COMMANDS.has(t0 as CliCommandName)) {
    return { ok: true, topic: t0 as CliCommandName };
  }

  return { ok: false, topic: t0 };
}

function parseRepoInspect(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([...COMMON_HIGH_LEVEL_FLAGS, "--dir", "--include-files", "--max-files"]);
  const booleans = new Set([...COMMON_HIGH_LEVEL_BOOLEANS, "--include-files"]);
  const optRes = extractHighLevelOptions(args, booleans, allowed, "repo inspect", json);
  if (!optRes.ok) return optRes.result;

  if (optRes.value.positional.length > 0) {
    return makeValidationError(
      `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow repo inspect'.`,
      json,
      "repo inspect"
    );
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "repo inspect");
  if (!commonRes.ok) return commonRes.result;

  const rawDir = optRes.value.flags.get("--dir");
  let dir: string | undefined;
  if (rawDir !== undefined) {
    if (rawDir.trim().length === 0) {
      return makeValidationError("Option '--dir' cannot be empty.", json, "repo inspect");
    }
    dir = rawDir.trim();
  }

  const includeFiles = optRes.value.booleanFlags.has("--include-files");

  const rawMaxFiles = optRes.value.flags.get("--max-files");
  let maxFiles: number | undefined;
  if (rawMaxFiles !== undefined) {
    const num = Number(rawMaxFiles);
    if (!Number.isSafeInteger(num) || num < 1 || num > 10000) {
      return makeValidationError(
        "Option '--max-files' must be an integer between 1 and 10000.",
        json,
        "repo inspect"
      );
    }
    maxFiles = num;
  }

  const value: RepoInspectCommandArgs = {
    ...commonRes.value,
    command: "repo inspect",
    dir,
    includeFiles,
    maxFiles
  };
  return { ok: true, value };
}

function parseTaskPlan(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([...COMMON_HIGH_LEVEL_FLAGS, "--spec", "--workflow", "-w", "--run-id", "--run"]);
  const booleans = COMMON_HIGH_LEVEL_BOOLEANS;
  const optRes = extractHighLevelOptions(args, booleans, allowed, "task plan", json);
  if (!optRes.ok) return optRes.result;

  let specPath: string;
  const flagSpec = optRes.value.flags.get("--spec");
  if (flagSpec !== undefined) {
    if (optRes.value.positional.length > 0) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow task plan'.`,
        json,
        "task plan"
      );
    }
    if (flagSpec.trim().length === 0) {
      return makeValidationError("Option '--spec' cannot be empty.", json, "task plan");
    }
    specPath = flagSpec.trim();
  } else {
    if (optRes.value.positional.length === 0) {
      return makeValidationError("Option '--spec' (or positional spec path) is required for 'task plan'.", json, "task plan");
    }
    if (optRes.value.positional.length > 1) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow task plan'.`,
        json,
        "task plan"
      );
    }
    specPath = optRes.value.positional[0]!.trim();
    if (specPath.length === 0) {
      return makeValidationError("Positional spec path cannot be empty for 'task plan'.", json, "task plan");
    }
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "task plan");
  if (!commonRes.ok) return commonRes.result;

  const rawWorkflow = optRes.value.flags.get("--workflow") ?? optRes.value.flags.get("-w");
  let workflowPath: string | undefined;
  if (rawWorkflow !== undefined) {
    if (rawWorkflow.trim().length === 0) {
      return makeValidationError("Option '--workflow' cannot be empty.", json, "task plan");
    }
    workflowPath = rawWorkflow.trim();
  }

  const rawRunId = optRes.value.flags.get("--run-id") ?? optRes.value.flags.get("--run");
  let runId: string | undefined;
  if (rawRunId !== undefined) {
    if (!isValidIdentifier(rawRunId)) {
      return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "task plan");
    }
    runId = rawRunId;
  }

  const value: TaskPlanCommandArgs = {
    ...commonRes.value,
    command: "task plan",
    specPath,
    workflowPath,
    runId
  };
  return { ok: true, value };
}

function parseTaskImplement(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([
    ...COMMON_HIGH_LEVEL_FLAGS,
    "--task-id",
    "--task",
    "--run-id",
    "--run",
    "--spec",
    "--workflow",
    "-w",
    "--attempt-id",
    "--base-revision",
    "--owned-path",
    "--forbidden-path",
    "--developer-id",
    "--require-red-evidence",
    "--target-branch",
    "--environment",
    "--auto-approve",
    "--approved-by"
  ]);
  const booleans = new Set([...COMMON_HIGH_LEVEL_BOOLEANS, "--require-red-evidence", "--auto-approve"]);
  const optRes = extractHighLevelOptions(args, booleans, allowed, "task implement", json);
  if (!optRes.ok) return optRes.result;

  const flagTaskId = optRes.value.flags.get("--task-id") ?? optRes.value.flags.get("--task");
  let taskId: string;
  if (flagTaskId !== undefined) {
    if (optRes.value.positional.length > 0) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow task implement'.`,
        json,
        "task implement"
      );
    }
    taskId = flagTaskId.trim();
  } else {
    if (optRes.value.positional.length === 0) {
      return makeValidationError("Task identifier is required for 'task implement'.", json, "task implement");
    }
    if (optRes.value.positional.length > 1) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow task implement'.`,
        json,
        "task implement"
      );
    }
    taskId = optRes.value.positional[0]!.trim();
  }

  if (!isValidIdentifier(taskId)) {
    return makeValidationError(`Invalid task identifier '${taskId}'.`, json, "task implement");
  }

  const rawRunId = optRes.value.flags.get("--run-id") ?? optRes.value.flags.get("--run");
  if (rawRunId === undefined) {
    return makeValidationError("Option '--run-id' is required for 'task implement'.", json, "task implement");
  }
  if (!isValidIdentifier(rawRunId)) {
    return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "task implement");
  }
  const runId = rawRunId;

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "task implement");
  if (!commonRes.ok) return commonRes.result;

  const rawSpec = optRes.value.flags.get("--spec");
  let specPath: string | undefined;
  if (rawSpec !== undefined) {
    if (rawSpec.trim().length === 0) {
      return makeValidationError("Option '--spec' cannot be empty.", json, "task implement");
    }
    specPath = rawSpec.trim();
  }

  const rawWorkflow = optRes.value.flags.get("--workflow") ?? optRes.value.flags.get("-w");
  let workflowPath: string | undefined;
  if (rawWorkflow !== undefined) {
    if (rawWorkflow.trim().length === 0) {
      return makeValidationError("Option '--workflow' cannot be empty.", json, "task implement");
    }
    workflowPath = rawWorkflow.trim();
  }

  const rawAttempt = optRes.value.flags.get("--attempt-id");
  let attemptId: string | undefined;
  if (rawAttempt !== undefined) {
    if (!isValidIdentifier(rawAttempt)) {
      return makeValidationError(`Invalid attempt identifier '${rawAttempt}'.`, json, "task implement");
    }
    attemptId = rawAttempt;
  }

  const rawBaseRev = optRes.value.flags.get("--base-revision");
  let baseRevision: string | undefined;
  if (rawBaseRev !== undefined) {
    if (rawBaseRev.trim().length === 0) {
      return makeValidationError("Option '--base-revision' cannot be empty.", json, "task implement");
    }
    baseRevision = rawBaseRev.trim();
  }

  const ownedPaths = collectListOption(optRes.value.multiFlags, "--owned-path");
  const forbiddenPaths = collectListOption(optRes.value.multiFlags, "--forbidden-path");

  const rawDevId = optRes.value.flags.get("--developer-id");
  let developerId: string | undefined;
  if (rawDevId !== undefined) {
    if (!isValidIdentifier(rawDevId)) {
      return makeValidationError(`Invalid developer identifier '${rawDevId}'.`, json, "task implement");
    }
    developerId = rawDevId;
  }

  const requireRedEvidence = optRes.value.booleanFlags.has("--require-red-evidence");

  const rawTargetBranch = optRes.value.flags.get("--target-branch");
  let targetBranch: string | undefined;
  if (rawTargetBranch !== undefined) {
    if (rawTargetBranch.trim().length === 0) {
      return makeValidationError("Option '--target-branch' cannot be empty.", json, "task implement");
    }
    targetBranch = rawTargetBranch.trim();
  }

  const rawEnv = optRes.value.flags.get("--environment");
  let environmentName: string | undefined;
  if (rawEnv !== undefined) {
    if (rawEnv.trim().length === 0) {
      return makeValidationError("Option '--environment' cannot be empty.", json, "task implement");
    }
    environmentName = rawEnv.trim();
  }

  const autoApprove = optRes.value.booleanFlags.has("--auto-approve");

  const rawApprovedBy = optRes.value.flags.get("--approved-by");
  let approvedBy: string | undefined;
  if (rawApprovedBy !== undefined) {
    if (rawApprovedBy.trim().length === 0) {
      return makeValidationError("Option '--approved-by' cannot be empty.", json, "task implement");
    }
    approvedBy = rawApprovedBy.trim();
  }

  const value: TaskImplementCommandArgs = {
    ...commonRes.value,
    command: "task implement",
    taskId,
    runId,
    specPath,
    workflowPath,
    attemptId,
    baseRevision,
    ownedPaths,
    forbiddenPaths,
    developerId,
    requireRedEvidence,
    targetBranch,
    environmentName,
    autoApprove,
    approvedBy
  };
  return { ok: true, value };
}

function parseVerify(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([
    ...COMMON_HIGH_LEVEL_FLAGS,
    "--run-id",
    "--run",
    "--task-id",
    "--task",
    "--scope",
    "--spec",
    "--plan",
    "--change-set",
    "--cycle",
    "--max-iterations"
  ]);
  const booleans = COMMON_HIGH_LEVEL_BOOLEANS;
  const optRes = extractHighLevelOptions(args, booleans, allowed, "verify", json);
  if (!optRes.ok) return optRes.result;

  const flagTaskId = optRes.value.flags.get("--task-id") ?? optRes.value.flags.get("--task");
  let taskId: string | undefined;
  if (flagTaskId !== undefined) {
    if (optRes.value.positional.length > 0) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow verify'.`,
        json,
        "verify"
      );
    }
    taskId = flagTaskId.trim();
  } else if (optRes.value.positional.length > 0) {
    if (optRes.value.positional.length > 1) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow verify'.`,
        json,
        "verify"
      );
    }
    taskId = optRes.value.positional[0]!.trim();
  }

  if (taskId !== undefined) {
    if (!isValidIdentifier(taskId)) {
      return makeValidationError(`Invalid task identifier '${taskId}'.`, json, "verify");
    }
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "verify");
  if (!commonRes.ok) return commonRes.result;

  const rawRunId = optRes.value.flags.get("--run-id") ?? optRes.value.flags.get("--run");
  let runId: string | undefined;
  if (rawRunId !== undefined) {
    if (!isValidIdentifier(rawRunId)) {
      return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "verify");
    }
    runId = rawRunId;
  }

  const rawScope = optRes.value.flags.get("--scope");
  let scope: "task" | "workflow" = "task";
  if (rawScope !== undefined) {
    if (rawScope !== "task" && rawScope !== "workflow") {
      return makeValidationError(`Invalid scope '${rawScope}'. Must be 'task' or 'workflow'.`, json, "verify");
    }
    scope = rawScope;
  }

  const rawSpec = optRes.value.flags.get("--spec");
  let specPath: string | undefined;
  if (rawSpec !== undefined) {
    if (rawSpec.trim().length === 0) {
      return makeValidationError("Option '--spec' cannot be empty.", json, "verify");
    }
    specPath = rawSpec.trim();
  }

  const rawPlan = optRes.value.flags.get("--plan");
  let planPath: string | undefined;
  if (rawPlan !== undefined) {
    if (rawPlan.trim().length === 0) {
      return makeValidationError("Option '--plan' cannot be empty.", json, "verify");
    }
    planPath = rawPlan.trim();
  }

  const rawChangeSet = optRes.value.flags.get("--change-set");
  let changeSetPath: string | undefined;
  if (rawChangeSet !== undefined) {
    if (rawChangeSet.trim().length === 0) {
      return makeValidationError("Option '--change-set' cannot be empty.", json, "verify");
    }
    changeSetPath = rawChangeSet.trim();
  }

  const rawCycle = optRes.value.flags.get("--cycle");
  let cyclePath: string | undefined;
  if (rawCycle !== undefined) {
    if (rawCycle.trim().length === 0) {
      return makeValidationError("Option '--cycle' cannot be empty.", json, "verify");
    }
    cyclePath = rawCycle.trim();
  }

  const rawMaxIter = optRes.value.flags.get("--max-iterations");
  let maxIterations: number | undefined;
  if (rawMaxIter !== undefined) {
    const num = Number(rawMaxIter);
    if (!Number.isSafeInteger(num) || num < 1 || num > 10) {
      return makeValidationError(
        "Option '--max-iterations' must be an integer between 1 and 10.",
        json,
        "verify"
      );
    }
    maxIterations = num;
  }

  const value: VerifyCommandArgs = {
    ...commonRes.value,
    command: "verify",
    runId,
    taskId,
    scope,
    specPath,
    planPath,
    changeSetPath,
    cyclePath,
    maxIterations
  };
  return { ok: true, value };
}

function parseGitPrepare(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([
    ...COMMON_HIGH_LEVEL_FLAGS,
    "--run-id",
    "--run",
    "--integration-id",
    "--base-revision",
    "--task",
    "--target-branch",
    "--environment",
    "--auto-approve",
    "--approved-by"
  ]);
  const booleans = new Set([...COMMON_HIGH_LEVEL_BOOLEANS, "--auto-approve"]);
  const optRes = extractHighLevelOptions(args, booleans, allowed, "git prepare", json);
  if (!optRes.ok) return optRes.result;

  if (optRes.value.positional.length > 0) {
    return makeValidationError(
      `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow git prepare'.`,
      json,
      "git prepare"
    );
  }

  const rawRunId = optRes.value.flags.get("--run-id") ?? optRes.value.flags.get("--run");
  if (rawRunId === undefined) {
    return makeValidationError("Option '--run-id' is required for 'git prepare'.", json, "git prepare");
  }
  if (!isValidIdentifier(rawRunId)) {
    return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "git prepare");
  }
  const runId = rawRunId;

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "git prepare");
  if (!commonRes.ok) return commonRes.result;

  const rawIntegrationId = optRes.value.flags.get("--integration-id");
  let integrationId: string | undefined;
  if (rawIntegrationId !== undefined) {
    if (!isValidIdentifier(rawIntegrationId)) {
      return makeValidationError(`Invalid integration identifier '${rawIntegrationId}'.`, json, "git prepare");
    }
    integrationId = rawIntegrationId;
  }

  const rawBaseRev = optRes.value.flags.get("--base-revision");
  let baseRevision: string | undefined;
  if (rawBaseRev !== undefined) {
    if (rawBaseRev.trim().length === 0) {
      return makeValidationError("Option '--base-revision' cannot be empty.", json, "git prepare");
    }
    baseRevision = rawBaseRev.trim();
  }

  const tasks: GitPrepareTaskDependencyInput[] = [];
  const rawTasks = optRes.value.multiFlags.get("--task") ?? [];
  for (const raw of rawTasks) {
    const colonIdx = raw.indexOf(":");
    let taskKey: string;
    let dependsOn: string[] = [];
    if (colonIdx !== -1) {
      taskKey = raw.slice(0, colonIdx).trim();
      const depsPart = raw.slice(colonIdx + 1).trim();
      if (depsPart.length > 0) {
        dependsOn = depsPart.split(",").map((d) => d.trim()).filter(Boolean);
      }
    } else {
      taskKey = raw.trim();
    }
    if (taskKey.length === 0 || !isValidIdentifier(taskKey)) {
      return makeValidationError(`Invalid task key '${taskKey}' in '--task'.`, json, "git prepare");
    }
    for (const dep of dependsOn) {
      if (!isValidIdentifier(dep)) {
        return makeValidationError(`Invalid dependency task key '${dep}' in '--task'.`, json, "git prepare");
      }
    }
    tasks.push({ taskKey, dependsOn });
  }

  const rawTargetBranch = optRes.value.flags.get("--target-branch");
  let targetBranch: string | undefined;
  if (rawTargetBranch !== undefined) {
    if (rawTargetBranch.trim().length === 0) {
      return makeValidationError("Option '--target-branch' cannot be empty.", json, "git prepare");
    }
    targetBranch = rawTargetBranch.trim();
  }

  const rawEnv = optRes.value.flags.get("--environment");
  let environmentName: string | undefined;
  if (rawEnv !== undefined) {
    if (rawEnv.trim().length === 0) {
      return makeValidationError("Option '--environment' cannot be empty.", json, "git prepare");
    }
    environmentName = rawEnv.trim();
  }

  const autoApprove = optRes.value.booleanFlags.has("--auto-approve");

  const rawApprovedBy = optRes.value.flags.get("--approved-by");
  let approvedBy: string | undefined;
  if (rawApprovedBy !== undefined) {
    if (rawApprovedBy.trim().length === 0) {
      return makeValidationError("Option '--approved-by' cannot be empty.", json, "git prepare");
    }
    approvedBy = rawApprovedBy.trim();
  }

  const value: GitPrepareCommandArgs = {
    ...commonRes.value,
    command: "git prepare",
    runId,
    integrationId,
    baseRevision,
    tasks,
    targetBranch,
    environmentName,
    autoApprove,
    approvedBy
  };
  return { ok: true, value };
}

function parseMcpStatus(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([...COMMON_HIGH_LEVEL_FLAGS, "--service", "--services", "--service-id"]);
  const booleans = COMMON_HIGH_LEVEL_BOOLEANS;
  const optRes = extractHighLevelOptions(args, booleans, allowed, "mcp status", json);
  if (!optRes.ok) return optRes.result;

  if (optRes.value.positional.length > 0) {
    return makeValidationError(
      `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow mcp status'.`,
      json,
      "mcp status"
    );
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "mcp status");
  if (!commonRes.ok) return commonRes.result;

  const rawServices = collectListOption(optRes.value.multiFlags, "--service", "--services", "--service-id");
  for (const s of rawServices) {
    if (!isValidIdentifier(s)) {
      return makeValidationError(`Invalid service identifier '${s}'.`, json, "mcp status");
    }
  }

  const value: McpStatusCommandArgs = {
    ...commonRes.value,
    command: "mcp status",
    serviceIds: rawServices
  };
  return { ok: true, value };
}

function parseToolStatus(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([...COMMON_HIGH_LEVEL_FLAGS, "--tool", "--tools", "--tool-id"]);
  const booleans = COMMON_HIGH_LEVEL_BOOLEANS;
  const optRes = extractHighLevelOptions(args, booleans, allowed, "tool status", json);
  if (!optRes.ok) return optRes.result;

  if (optRes.value.positional.length > 0) {
    return makeValidationError(
      `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow tool status'.`,
      json,
      "tool status"
    );
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "tool status");
  if (!commonRes.ok) return commonRes.result;

  const rawTools = collectListOption(optRes.value.multiFlags, "--tool", "--tools", "--tool-id");
  for (const t of rawTools) {
    if (!isValidIdentifier(t)) {
      return makeValidationError(`Invalid tool identifier '${t}'.`, json, "tool status");
    }
  }

  const value: ToolStatusCommandArgs = {
    ...commonRes.value,
    command: "tool status",
    toolIds: rawTools
  };
  return { ok: true, value };
}

function parseSkillsSync(
  args: readonly string[],
  json: boolean,
  defaultMode: "sync" | "list"
): ParseCliResult {
  const allowed = new Set([
    ...COMMON_HIGH_LEVEL_FLAGS,
    "--list",
    "--provider",
    "--manifest-id",
    "--environment-id",
    "--catalog-dir",
    "--store-dir"
  ]);
  const booleans = new Set([...COMMON_HIGH_LEVEL_BOOLEANS, "--list"]);
  const optRes = extractHighLevelOptions(args, booleans, allowed, "skills sync", json);
  if (!optRes.ok) return optRes.result;

  if (optRes.value.positional.length > 0) {
    return makeValidationError(
      `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow skills sync'.`,
      json,
      "skills sync"
    );
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "skills sync");
  if (!commonRes.ok) return commonRes.result;

  let mode: "sync" | "list" = defaultMode;
  if (optRes.value.booleanFlags.has("--list")) {
    mode = "list";
  }

  const rawProvider = optRes.value.flags.get("--provider");
  let provider: "claude" | "codex" | "agy" | undefined;
  if (rawProvider !== undefined) {
    if (rawProvider !== "claude" && rawProvider !== "codex" && rawProvider !== "agy") {
      return makeValidationError(
        `Invalid provider '${rawProvider}'. Must be 'claude', 'codex', or 'agy'.`,
        json,
        "skills sync"
      );
    }
    provider = rawProvider;
  }

  const rawManifestId = optRes.value.flags.get("--manifest-id");
  let manifestId: string | undefined;
  if (rawManifestId !== undefined) {
    if (!isValidIdentifier(rawManifestId)) {
      return makeValidationError(`Invalid manifest identifier '${rawManifestId}'.`, json, "skills sync");
    }
    manifestId = rawManifestId;
  }

  const rawEnvId = optRes.value.flags.get("--environment-id");
  let environmentId: string | undefined;
  if (rawEnvId !== undefined) {
    if (!isValidIdentifier(rawEnvId)) {
      return makeValidationError(`Invalid environment identifier '${rawEnvId}'.`, json, "skills sync");
    }
    environmentId = rawEnvId;
  }

  const rawCatalogDir = optRes.value.flags.get("--catalog-dir");
  let catalogDir: string | undefined;
  if (rawCatalogDir !== undefined) {
    if (rawCatalogDir.trim().length === 0) {
      return makeValidationError("Option '--catalog-dir' cannot be empty.", json, "skills sync");
    }
    catalogDir = rawCatalogDir.trim();
  }

  const rawStoreDir = optRes.value.flags.get("--store-dir");
  let storeDir: string | undefined;
  if (rawStoreDir !== undefined) {
    if (rawStoreDir.trim().length === 0) {
      return makeValidationError("Option '--store-dir' cannot be empty.", json, "skills sync");
    }
    storeDir = rawStoreDir.trim();
  }

  const value: SkillsSyncCommandArgs = {
    ...commonRes.value,
    command: "skills sync",
    mode,
    provider,
    manifestId,
    environmentId,
    catalogDir,
    storeDir
  };
  return { ok: true, value };
}

function parseAgentCheck(args: readonly string[], json: boolean): ParseCliResult {
  const allowed = new Set([...COMMON_HIGH_LEVEL_FLAGS, "--provider", "--stage", "--environment-id"]);
  const booleans = COMMON_HIGH_LEVEL_BOOLEANS;
  const optRes = extractHighLevelOptions(args, booleans, allowed, "agent check", json);
  if (!optRes.ok) return optRes.result;

  const flagProvider = optRes.value.flags.get("--provider");
  let provider: "claude" | "codex" | "agy" | undefined;
  if (flagProvider !== undefined) {
    if (optRes.value.positional.length > 0) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow agent check'.`,
        json,
        "agent check"
      );
    }
    if (flagProvider !== "claude" && flagProvider !== "codex" && flagProvider !== "agy") {
      return makeValidationError(
        `Invalid provider '${flagProvider}'. Must be 'claude', 'codex', or 'agy'.`,
        json,
        "agent check"
      );
    }
    provider = flagProvider;
  } else if (optRes.value.positional.length > 0) {
    if (optRes.value.positional.length > 1) {
      return makeValidationError(
        `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow agent check'.`,
        json,
        "agent check"
      );
    }
    const pos = optRes.value.positional[0]!.trim();
    if (pos !== "claude" && pos !== "codex" && pos !== "agy") {
      return makeValidationError(`Invalid provider '${pos}'. Must be 'claude', 'codex', or 'agy'.`, json, "agent check");
    }
    provider = pos;
  }

  const commonRes = parseHighLevelCommonFlags(optRes.value, json, "agent check");
  if (!commonRes.ok) return commonRes.result;

  const rawStage = optRes.value.flags.get("--stage");
  let stage: "preflight" | "activated" = "preflight";
  if (rawStage !== undefined) {
    if (rawStage !== "preflight" && rawStage !== "activated") {
      return makeValidationError(`Invalid stage '${rawStage}'. Must be 'preflight' or 'activated'.`, json, "agent check");
    }
    stage = rawStage;
  }

  const rawEnvId = optRes.value.flags.get("--environment-id");
  let environmentId: string | undefined;
  if (rawEnvId !== undefined) {
    if (!isValidIdentifier(rawEnvId)) {
      return makeValidationError(`Invalid environment identifier '${rawEnvId}'.`, json, "agent check");
    }
    environmentId = rawEnvId;
  }

  const value: AgentCheckCommandArgs = {
    ...commonRes.value,
    command: "agent check",
    provider,
    stage,
    environmentId
  };
  return { ok: true, value };
}

const DOCS_ROLES: ReadonlySet<string> = new Set(["coordinator", "planner", "architect", "specifier", "developer", "tester", "reviewer", "qa", "security"]);
const DOCS_LIBRARY = /^[A-Za-z0-9@][A-Za-z0-9@/._+-]{0,99}$/;
const DOCS_LIBRARY_ID = /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~+-]+(?:\/[A-Za-z0-9._~+-]+)*$/;
const DOCS_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const DOCS_LANGUAGE = /^[A-Za-z0-9+#._-]{1,40}$/;

function parseDocs(args: readonly string[], json: boolean): ParseCliResult {
  const subIndex = args.findIndex(item => !isFlag(item));
  const wantsHelp = args.includes("--help") || args.includes("-h");
  if (subIndex === -1 && !wantsHelp)
    return makeValidationError("Missing subcommand for 'bflow docs'. Expected 'search', 'lookup' or 'status'.", json, "docs");
  const action = subIndex === -1 ? "status" : args[subIndex]!;
  if (action !== "search" && action !== "lookup" && action !== "status")
    return makeValidationError(`Unknown subcommand '${action}' for 'bflow docs'. Expected 'search', 'lookup' or 'status'.`, json, "docs");
  const rest = subIndex === -1 ? args : [...args.slice(0, subIndex), ...args.slice(subIndex + 1)];
  const booleans = new Set(["--json", "-j", "--help", "-h", "--no-cache"]);
  const allowed = new Set(["--json", "-j", "--help", "-h", "--role", "--timeout",
    ...(action === "search" ? ["--query", "--version"] : []),
    ...(action === "lookup" ? ["--query", "--library-id", "--language", "--version", "--no-cache"] : [])]);
  const options = extractOptionsAndPositional(rest, booleans, allowed, "docs", json);
  if (!options.ok) return options.result;
  const flags = options.value.flags;
  const help = flags.has("--help") || flags.has("-h");
  const text = (name: string): string | undefined => { const value = flags.get(name); return typeof value === "string" ? value.trim() : undefined; };
  const invalid = (message: string) => makeValidationError(message, json, "docs");

  const role = text("--role");
  if (role !== undefined && !DOCS_ROLES.has(role)) return invalid(`Option '--role' must be one of: ${[...DOCS_ROLES].join(", ")}.`);
  const rawTimeout = text("--timeout");
  let timeoutMs: number | undefined;
  if (rawTimeout !== undefined) {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) return invalid("Option '--timeout' must be a whole number of milliseconds between 1000 and 120000.");
  }
  const version = text("--version");
  if (version !== undefined && !DOCS_VERSION.test(version)) return invalid("Option '--version' must be a version such as 18.2.0 or v18.2.0.");
  const common = { json, help, ...(role !== undefined ? { role } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  const positional = options.value.positional;

  if (action === "status") {
    if (positional.length > 0) return invalid(`Unexpected positional argument '${positional[0]}' for 'bflow docs status'.`);
    return { ok: true, value: { command: "docs", action: "status", ...common } };
  }
  if (action === "search") {
    if (!help && positional.length !== 1) return invalid("'bflow docs search' takes exactly one library name.");
    const library = positional[0] ?? "";
    if (!help && !DOCS_LIBRARY.test(library)) return invalid("The library name must be 1-100 characters: letters, digits and @ / . _ + -.");
    const query = text("--query");
    if (query !== undefined && (query.length === 0 || query.length > 2000)) return invalid("Option '--query' must be 1-2000 characters.");
    return { ok: true, value: { command: "docs", action: "search", library, ...(query !== undefined ? { query } : {}), ...(version !== undefined ? { version } : {}), ...common } };
  }
  const libraryId = text("--library-id");
  if (libraryId !== undefined && !DOCS_LIBRARY_ID.test(libraryId)) return invalid("Option '--library-id' must look like /org/project (optionally /org/project/version).");
  if (!help && positional.length > 1) return invalid("'bflow docs lookup' takes at most one library name.");
  const library = positional[0];
  if (library !== undefined && !DOCS_LIBRARY.test(library)) return invalid("The library name must be 1-100 characters: letters, digits and @ / . _ + -.");
  if (!help && library === undefined && libraryId === undefined) return invalid("'bflow docs lookup' needs a library name or --library-id.");
  if (library !== undefined && libraryId !== undefined) return invalid("Give either a library name or --library-id, not both.");
  const query = text("--query");
  if (!help && (query === undefined || query.length === 0)) return invalid("'bflow docs lookup' requires --query \"...\".");
  if (query !== undefined && query.length > 2000) return invalid("Option '--query' must be 1-2000 characters.");
  const language = text("--language");
  if (language !== undefined && !DOCS_LANGUAGE.test(language)) return invalid("Option '--language' must be a short language name such as typescript.");
  return { ok: true, value: { command: "docs", action: "lookup", query: query ?? "", ...(library !== undefined ? { library } : {}), ...(libraryId !== undefined ? { libraryId } : {}),
    ...(language !== undefined ? { language } : {}), ...(version !== undefined ? { version } : {}), ...(flags.has("--no-cache") ? { noCache: true } : {}), ...common } };
}

export function parseCliArgs(argv: readonly string[]): ParseCliResult {
  const json = argv.some((a) => a === "--json" || a === "-j");

  for (const a of argv) {
    const eqIdx = a.indexOf("=");
    if (eqIdx !== -1) {
      const fName = a.slice(0, eqIdx);
      if (GLOBAL_BOOLEAN_FLAGS.has(fName)) {
        return makeValidationError(`Option '${fName}' does not take a value.`, json);
      }
    }
  }

  let leadingJson = false;
  let leadingHelp = false;
  let leadingVersion = false;
  let idx = 0;

  while (idx < argv.length) {
    const token = argv[idx]!;
    if (token === "--json" || token === "-j") {
      leadingJson = true;
      idx++;
    } else if (token === "--help" || token === "-h") {
      leadingHelp = true;
      idx++;
    } else if (token === "--version" || token === "-v") {
      leadingVersion = true;
      idx++;
    } else {
      break;
    }
  }

  const effectiveJson = leadingJson || json;
  const remaining = argv.slice(idx);

  if (leadingVersion && !leadingHelp) {
    if (remaining.length > 0) {
      return makeValidationError(
        `Unexpected argument '${remaining[0]}' with '--version'.`,
        effectiveJson,
        "version"
      );
    }
    const value: VersionCommandArgs = {
      command: "version",
      help: false,
      json: effectiveJson
    };
    return { ok: true, value };
  }

  if (remaining.length === 0) {
    const value: HelpCommandArgs = {
      command: "help",
      help: true,
      json: effectiveJson
    };
    return { ok: true, value };
  }

  if (leadingHelp) {
    if (remaining.length > 0 && isFlag(remaining[0]!)) {
      return makeValidationError(
        `Unknown command '${remaining[0]}'. Run 'bflow --help' for usage.`,
        effectiveJson
      );
    }
    const nonFlags = remaining.filter((a) => !isFlag(a));
    const resolved = resolveHelpTopic(nonFlags);
    if (resolved === undefined) {
      const value: HelpCommandArgs = {
        command: "help",
        help: true,
        json: effectiveJson
      };
      return { ok: true, value };
    }
    if (resolved.ok) {
      const value: HelpCommandArgs = {
        command: "help",
        topic: resolved.topic,
        help: true,
        json: effectiveJson
      };
      return { ok: true, value };
    }
    return makeValidationError(
      `Unknown help topic '${resolved.topic}'. Run 'bflow --help' for usage.`,
      effectiveJson,
      "help"
    );
  }

  if (leadingJson) {
    const firstRemaining = remaining[0]!;
    if (VALID_COMMANDS.has(firstRemaining as CliCommandName) || HIGH_LEVEL_PREFIXES.has(firstRemaining)) {
      return parseCliArgs([firstRemaining, ...remaining.slice(1), "--json"]);
    }
    return makeValidationError(
      `Unknown command '${firstRemaining}'. Run 'bflow --help' for usage.`,
      true
    );
  }

  const first = argv[0]!;

  if (first === "help") {
    const nonFlags = argv.slice(1).filter((a) => !isFlag(a));
    const resolved = resolveHelpTopic(nonFlags);
    if (resolved === undefined) {
      const value: HelpCommandArgs = {
        command: "help",
        help: true,
        json
      };
      return { ok: true, value };
    }
    if (resolved.ok) {
      const value: HelpCommandArgs = {
        command: "help",
        topic: resolved.topic,
        help: true,
        json
      };
      return { ok: true, value };
    }
    return makeValidationError(`Unknown help topic '${resolved.topic}'. Run 'bflow --help' for usage.`, json, "help");
  }

  const hasGlobalHelp = argv.some((a) => a === "--help" || a === "-h");

  if (hasGlobalHelp) {
    const nonFlags = argv.filter((a) => !isFlag(a));
    const resolved = resolveHelpTopic(nonFlags);
    if (resolved && resolved.ok) {
      const value: HelpCommandArgs = {
        command: "help",
        topic: resolved.topic,
        help: true,
        json
      };
      return { ok: true, value };
    }
  }

  if (!VALID_COMMANDS.has(first as CliCommandName) && !HIGH_LEVEL_PREFIXES.has(first)) {
    return makeValidationError(`Unknown command '${first}'. Run 'bflow --help' for usage.`, json);
  }

  if (first === "repo") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow repo'. Expected 'inspect'.", json, "repo inspect");
    }
    const sub = argv[1 + subIdx]!;
    if (sub !== "inspect") {
      return makeValidationError(`Unknown subcommand '${sub}' for 'bflow repo'. Expected 'inspect'.`, json, "repo inspect");
    }
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    return parseRepoInspect(remainingArgs, json);
  }

  if (first === "task") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow task'. Expected 'plan' or 'implement'.", json);
    }
    const sub = argv[1 + subIdx]!;
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    if (sub === "plan") {
      return parseTaskPlan(remainingArgs, json);
    }
    if (sub === "implement") {
      return parseTaskImplement(remainingArgs, json);
    }
    return makeValidationError(`Unknown subcommand '${sub}' for 'bflow task'. Expected 'plan' or 'implement'.`, json);
  }

  if (first === "git") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow git'. Expected 'prepare'.", json, "git prepare");
    }
    const sub = argv[1 + subIdx]!;
    if (sub !== "prepare") {
      return makeValidationError(`Unknown subcommand '${sub}' for 'bflow git'. Expected 'prepare'.`, json, "git prepare");
    }
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    return parseGitPrepare(remainingArgs, json);
  }

  if (first === "mcp") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow mcp'. Expected 'status'.", json, "mcp status");
    }
    const sub = argv[1 + subIdx]!;
    if (sub !== "status") {
      return makeValidationError(`Unknown subcommand '${sub}' for 'bflow mcp'. Expected 'status'.`, json, "mcp status");
    }
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    return parseMcpStatus(remainingArgs, json);
  }

  if (first === "tool" || first === "tools") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow tool'. Expected 'status'.", json, "tool status");
    }
    const sub = argv[1 + subIdx]!;
    if (sub !== "status") {
      return makeValidationError(`Unknown subcommand '${sub}' for 'bflow tool'. Expected 'status'.`, json, "tool status");
    }
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    return parseToolStatus(remainingArgs, json);
  }

  if (first === "skills") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow skills'. Expected 'sync' or 'list'.", json, "skills sync");
    }
    const sub = argv[1 + subIdx]!;
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    if (sub === "sync") {
      return parseSkillsSync(remainingArgs, json, "sync");
    }
    if (sub === "list") {
      return parseSkillsSync(remainingArgs, json, "list");
    }
    return makeValidationError(`Unknown subcommand '${sub}' for 'bflow skills'. Expected 'sync' or 'list'.`, json, "skills sync");
  }

  if (first === "agent") {
    const subIdx = argv.slice(1).findIndex((a) => !isFlag(a));
    if (subIdx === -1) {
      return makeValidationError("Missing subcommand for 'bflow agent'. Expected 'check'.", json, "agent check");
    }
    const sub = argv[1 + subIdx]!;
    if (sub !== "check") {
      return makeValidationError(`Unknown subcommand '${sub}' for 'bflow agent'. Expected 'check'.`, json, "agent check");
    }
    const remainingArgs = [...argv.slice(1, 1 + subIdx), ...argv.slice(1 + subIdx + 1)];
    return parseAgentCheck(remainingArgs, json);
  }

  if (first === "verify") {
    return parseVerify(argv.slice(1), json);
  }

  const command = first as Exclude<CliCommandName, "help" | HighLevelCommandName>;
  const commandArgs = argv.slice(1);

  switch (command) {
    case "docs":
      return parseDocs(commandArgs, json);

    case "config-migrate": {
      const booleans = new Set(["--json", "-j", "--help", "-h"]);
      const allowed = new Set(["--json", "-j", "--help", "-h"]);
      const result = extractOptionsAndPositional(commandArgs, booleans, allowed, command, json);
      if (!result.ok) return result.result;
      if (result.value.positional.length) return makeValidationError("Unexpected positional argument for 'config-migrate'.", json, command);
      const value: ConfigMigrateCommandArgs = { command, json, help: result.value.flags.has("--help") || result.value.flags.has("-h") };
      return { ok: true, value };
    }

    case "up":
    case "down":
    case "attach":
    case "recover":
    case "doctor": {
      const booleans = new Set(["--json", "-j", "--yes", "-y"]);
      const allowed = new Set(["--json", "-j"]);
      if (command === "down" || command === "recover") { allowed.add("--yes"); allowed.add("-y"); }
      if (command === "up" || command === "down") allowed.add("--timeout");
      const result = extractOptionsAndPositional(commandArgs, booleans, allowed, command, json);
      if (!result.ok) return result.result;
      if (result.value.positional.length) return makeValidationError(`Unexpected positional argument for '${command}'.`, json, command);
      const timeout = result.value.flags.get("--timeout");
      const timeoutMs = timeout === undefined ? undefined : Number(timeout);
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000))
        return makeValidationError("--timeout must be an integer from 1 to 600000 milliseconds.", json, command);
      return { ok: true, value: { command, json, help: false, yes: result.value.flags.has("--yes") || result.value.flags.has("-y"), timeoutMs } };
    }

    case "version": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h", "--version", "-v"]);
      const allowedFlags = new Set(["--json", "-j", "--help", "-h", "--version", "-v"]);
      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "version", json);
      if (!optRes.ok) return optRes.result;
      if (optRes.value.positional.length > 0) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow version'.`,
          json,
          "version"
        );
      }
      const value: VersionCommandArgs = {
        command: "version",
        help: false,
        json
      };
      return { ok: true, value };
    }

    case "init": {
      const booleanFlags = new Set(["--force", "-f", "--yes", "-y", "--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--dir",
        "--config",
        "--name",
        "--provider",
        "--force",
        "-f",
        "--yes",
        "-y",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "init", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length > 0) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow init'.`,
          json,
          "init"
        );
      }

      const rawDir = optRes.value.flags.get("--dir") as string | undefined;
      if (rawDir !== undefined && rawDir.trim().length === 0) {
        return makeValidationError("Option '--dir' cannot be empty.", json, "init");
      }
      const dir = rawDir?.trim();

      const rawConfig = optRes.value.flags.get("--config") as string | undefined;
      if (rawConfig !== undefined && rawConfig.trim().length === 0) {
        return makeValidationError("Option '--config' cannot be empty.", json, "init");
      }
      const configPath = rawConfig?.trim();

      const rawName = optRes.value.flags.get("--name") as string | undefined;
      if (rawName !== undefined && rawName.trim().length === 0) {
        return makeValidationError("Option '--name' cannot be empty.", json, "init");
      }
      const projectName = rawName?.trim();
      const rawProvider = optRes.value.flags.get("--provider");
      let provider: "claude" | "codex" | "agy" | undefined;
      if (rawProvider !== undefined) {
        if (rawProvider !== "claude" && rawProvider !== "codex" && rawProvider !== "agy") {
          return makeValidationError("--provider must be 'claude', 'codex', or 'agy'.", json, "init");
        }
        provider = rawProvider;
      }

      const force =
        optRes.value.flags.has("--force") ||
        optRes.value.flags.has("-f") ||
        optRes.value.flags.has("--yes") ||
        optRes.value.flags.has("-y");

      const value: InitCommandArgs = {
        command: "init",
        dir,
        configPath,
        projectName,
        provider,
        force,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "setup": {
      const booleanFlags = new Set([
        "--check",
        "--dry-run",
        "--plan",
        "--apply",
        "--repair",
        "--codex-hooks",
        "--trust-all",
        "--revoke-trust-all",
        "--context7-api-key-stdin",
        "--no-context7",
        "--yes",
        "-y",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);
      const allowedFlags = new Set([
        "--check",
        "--dry-run",
        "--plan",
        "--apply",
        "--repair",
        "--codex-hooks",
        "--trust-all",
        "--revoke-trust-all",
        "--context7-api-key-stdin",
        "--no-context7",
        "--yes",
        "-y",
        "--dir",
        "--catalog-dir",
        "--hook-digest",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "setup", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length > 0) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[0]}' for 'bflow setup'.`,
          json,
          "setup"
        );
      }

      const modes: ("check" | "dry_run" | "apply" | "repair")[] = [];
      if (optRes.value.flags.has("--check")) modes.push("check");
      if (optRes.value.flags.has("--dry-run") || optRes.value.flags.has("--plan")) modes.push("dry_run");
      if (optRes.value.flags.has("--apply")) modes.push("apply");
      if (optRes.value.flags.has("--repair")) modes.push("repair");

      if (modes.length > 1) {
        return makeValidationError(
          "Conflicting setup mode flags specified. Choose only one of --check, --dry-run/--plan, --apply, or --repair.",
          json,
          "setup"
        );
      }

      const mode = modes[0] ?? "apply";

      const rawDir = optRes.value.flags.get("--dir") as string | undefined;
      if (rawDir !== undefined && rawDir.trim().length === 0) {
        return makeValidationError("Option '--dir' cannot be empty.", json, "setup");
      }
      const dir = rawDir?.trim();

      const rawCatalogDir = optRes.value.flags.get("--catalog-dir") as string | undefined;
      if (rawCatalogDir !== undefined && rawCatalogDir.trim().length === 0) {
        return makeValidationError("Option '--catalog-dir' cannot be empty.", json, "setup");
      }
      const catalogDir = rawCatalogDir?.trim();

      const yes = optRes.value.flags.has("--yes") || optRes.value.flags.has("-y");
      const codexHooks = optRes.value.flags.has("--codex-hooks");
      const trustAllHooks = optRes.value.flags.has("--trust-all");
      const revokeAllHookTrust = optRes.value.flags.has("--revoke-trust-all");
      const hookDigest = optRes.value.flags.get("--hook-digest");
      const context7ApiKeyStdin = optRes.value.flags.has("--context7-api-key-stdin");
      const noContext7 = optRes.value.flags.has("--no-context7");
      if (context7ApiKeyStdin && noContext7)
        return makeValidationError("'--context7-api-key-stdin' and '--no-context7' cannot be combined.", json, "setup");
      if ((context7ApiKeyStdin || noContext7) && codexHooks)
        return makeValidationError("Context7 options cannot be combined with '--codex-hooks'.", json, "setup");
      if (context7ApiKeyStdin && mode !== "apply" && mode !== "repair")
        return makeValidationError("'--context7-api-key-stdin' stores a credential and is valid only with --apply or --repair.", json, "setup");

      if ((trustAllHooks || revokeAllHookTrust) && !codexHooks)
        return makeValidationError("Hook policy flags require '--codex-hooks'.", json, "setup");
      if ((trustAllHooks && revokeAllHookTrust) || ((trustAllHooks || revokeAllHookTrust) && hookDigest !== undefined))
        return makeValidationError("Choose one hook policy action; do not combine it with '--hook-digest'.", json, "setup");
      if (hookDigest !== undefined && !codexHooks) {
        return makeValidationError("Option '--hook-digest' requires '--codex-hooks'.", json, "setup");
      }
      if (hookDigest !== undefined && (typeof hookDigest !== "string" || !/^[a-f0-9]{64}$/.test(hookDigest))) {
        return makeValidationError("Option '--hook-digest' must be a 64 hexadecimal SHA-256 digest.", json, "setup");
      }
      if (codexHooks) {
        if (modes.length !== 1 || mode === "repair") {
          return makeValidationError("'--codex-hooks' requires exactly one of --check, --plan, or --apply.", json, "setup");
        }
        if (dir !== undefined || catalogDir !== undefined) {
          return makeValidationError("'--codex-hooks' cannot be combined with --dir or --catalog-dir.", json, "setup");
        }
        if (mode !== "apply" && (trustAllHooks || revokeAllHookTrust)) {
          return makeValidationError(`'${trustAllHooks ? "--trust-all" : "--revoke-trust-all"}' is valid only with 'setup --codex-hooks --apply'.`, json, "setup");
        }
        if (mode !== "apply" && (yes || hookDigest !== undefined)) {
          return makeValidationError("'--yes' and '--hook-digest' are valid only with 'setup --codex-hooks --apply'.", json, "setup");
        }
        if (!trustAllHooks && !revokeAllHookTrust && yes !== (hookDigest !== undefined)) {
          return makeValidationError("Non-interactive Codex hook approval requires both '--yes' and '--hook-digest <sha256>'.", json, "setup");
        }
      }

      const value: SetupCommandArgs = {
        command: "setup",
        mode,
        yes,
        ...(codexHooks ? { codexHooks: true } : {}),
        ...(trustAllHooks ? { trustAllHooks: true } : {}),
        ...(revokeAllHookTrust ? { revokeAllHookTrust: true } : {}),
        ...(typeof hookDigest === "string" ? { hookDigest } : {}),
        ...(context7ApiKeyStdin ? { context7ApiKeyStdin: true } : {}),
        ...(noContext7 ? { noContext7: true } : {}),
        dir,
        catalogDir,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "run": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--run-id",
        "--workflow",
        "-w",
        "--config",
        "--idempotency-key",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "run", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length === 0) {
        return makeValidationError("Missing required <requirement> argument for 'bflow run'.", json, "run");
      }

      const requirement = optRes.value.positional[0]!.trim();
      if (requirement.length === 0) {
        return makeValidationError("Missing required <requirement> argument for 'bflow run'.", json, "run");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow run'.`,
          json,
          "run"
        );
      }

      const rawRunId = optRes.value.flags.get("--run-id") as string | undefined;
      if (rawRunId !== undefined) {
        if (!isValidIdentifier(rawRunId)) {
          return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "run");
        }
      }

      const rawIdempKey = optRes.value.flags.get("--idempotency-key") as string | undefined;
      if (rawIdempKey !== undefined) {
        const idempParse = IdempotencyKeySchema.safeParse(rawIdempKey);
        if (!idempParse.success) {
          return makeValidationError(`Invalid idempotency key '${rawIdempKey}'.`, json, "run");
        }
      }

      let workflowPath: string | undefined;
      if (optRes.value.flags.has("--workflow")) {
        const raw = optRes.value.flags.get("--workflow") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--workflow' cannot be empty.", json, "run");
        }
        workflowPath = raw.trim();
      } else if (optRes.value.flags.has("-w")) {
        const raw = optRes.value.flags.get("-w") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '-w' cannot be empty.", json, "run");
        }
        workflowPath = raw.trim();
      }

      const rawConfig = optRes.value.flags.get("--config") as string | undefined;
      if (rawConfig !== undefined && rawConfig.trim().length === 0) {
        return makeValidationError("Option '--config' cannot be empty.", json, "run");
      }
      const configPath = rawConfig?.trim();

      const value: RunCommandArgs = {
        command: "run",
        requirement,
        runId: rawRunId,
        workflowPath,
        configPath,
        idempotencyKey: rawIdempKey,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "status": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--status",
        "--workflow-id",
        "--limit",
        "--cursor",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "status", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow status'.`,
          json,
          "status"
        );
      }

      let runId: string | undefined;
      if (optRes.value.positional.length === 1) {
        const rawPosId = optRes.value.positional[0]!;
        if (!isValidIdentifier(rawPosId)) {
          return makeValidationError(`Invalid run identifier '${rawPosId}'.`, json, "status");
        }
        runId = rawPosId;
      }

      let statusFilter: RunStatus[] | undefined;
      const rawStatus = optRes.value.flags.get("--status") as string | undefined;
      if (rawStatus !== undefined) {
        const parts = rawStatus.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length === 0) {
          return makeValidationError("Option '--status' requires a valid status list.", json, "status");
        }
        statusFilter = [];
        for (const part of parts) {
          const parsedStatus = RunStatusSchema.safeParse(part);
          if (!parsedStatus.success) {
            return makeValidationError(
              `Invalid run status '${part}'. Expected one of: queued, running, waiting, blocked, succeeded, failed, cancelling, cancelled.`,
              json,
              "status"
            );
          }
          statusFilter.push(parsedStatus.data);
        }
      }

      const rawWorkflowId = optRes.value.flags.get("--workflow-id") as string | undefined;
      if (rawWorkflowId !== undefined) {
        if (!isValidIdentifier(rawWorkflowId)) {
          return makeValidationError(`Invalid workflow identifier '${rawWorkflowId}'.`, json, "status");
        }
      }

      let limit: number | undefined;
      const rawLimit = optRes.value.flags.get("--limit") as string | undefined;
      if (rawLimit !== undefined) {
        const num = Number(rawLimit);
        if (!Number.isInteger(num) || num < 1 || num > 500) {
          return makeValidationError("Option '--limit' must be an integer between 1 and 500.", json, "status");
        }
        limit = num;
      }

      const rawCursor = optRes.value.flags.get("--cursor") as string | undefined;
      let cursor: string | undefined;
      if (rawCursor !== undefined) {
        if (rawCursor.trim().length === 0) {
          return makeValidationError("Option '--cursor' cannot be empty.", json, "status");
        }
        cursor = rawCursor.trim();
      }

      if (
        runId !== undefined &&
        (statusFilter !== undefined || rawWorkflowId !== undefined || limit !== undefined || cursor !== undefined)
      ) {
        return makeValidationError(
          "Cannot combine <run-id> with list filter/pagination options (--status, --workflow-id, --limit, --cursor).",
          json,
          "status"
        );
      }

      const value: StatusCommandArgs = {
        command: "status",
        runId,
        statusFilter,
        workflowId: rawWorkflowId,
        limit,
        cursor,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "approve": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--run",
        "--run-id",
        "--by",
        "--decided-by",
        "--actor",
        "--decision",
        "--reason",
        "--approval-id",
        "--revision",
        "--generation",
        "--idempotency-key",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "approve", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length === 0) {
        return makeValidationError("Missing required <task-id> argument for 'bflow approve'.", json, "approve");
      }

      const taskId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(taskId)) {
        return makeValidationError(`Invalid task identifier '${taskId}'.`, json, "approve");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow approve'.`,
          json,
          "approve"
        );
      }

      const rawRunId =
        (optRes.value.flags.get("--run") as string | undefined) ??
        (optRes.value.flags.get("--run-id") as string | undefined);
      if (rawRunId !== undefined) {
        if (!isValidIdentifier(rawRunId)) {
          return makeValidationError(`Invalid run identifier '${rawRunId}'.`, json, "approve");
        }
      }

      let decidedBy = "human_operator";
      if (optRes.value.flags.has("--by")) {
        const raw = optRes.value.flags.get("--by") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--by' cannot be empty.", json, "approve");
        }
        decidedBy = raw.trim();
      } else if (optRes.value.flags.has("--decided-by")) {
        const raw = optRes.value.flags.get("--decided-by") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--decided-by' cannot be empty.", json, "approve");
        }
        decidedBy = raw.trim();
      } else if (optRes.value.flags.has("--actor")) {
        const raw = optRes.value.flags.get("--actor") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--actor' cannot be empty.", json, "approve");
        }
        decidedBy = raw.trim();
      }

      if (!isHumanApprover(decidedBy)) {
        return makeValidationError(
          `Mandatory human approval cannot be satisfied by an automated or AI actor ('${decidedBy}').`,
          json,
          "approve"
        );
      }

      const rawDecision = (optRes.value.flags.get("--decision") as string | undefined) ?? "approved";
      if (rawDecision !== "approved" && rawDecision !== "rejected" && rawDecision !== "changes_requested") {
        return makeValidationError(
          `Invalid decision '${rawDecision}'. Expected one of: approved, rejected, changes_requested.`,
          json,
          "approve"
        );
      }

      const rawReason = optRes.value.flags.get("--reason") as string | undefined;
      if (rawReason !== undefined && rawReason.trim().length === 0) {
        return makeValidationError("Option '--reason' cannot be empty.", json, "approve");
      }
      if (rawDecision !== "approved" && rawReason === undefined) {
        return makeValidationError(
          `Option '--reason' is required when decision is '${rawDecision}'.`,
          json,
          "approve"
        );
      }
      const reason = rawReason?.trim();

      const rawApprovalId = optRes.value.flags.get("--approval-id") as string | undefined;
      if (rawApprovalId !== undefined) {
        if (!isValidIdentifier(rawApprovalId)) {
          return makeValidationError(`Invalid approval identifier '${rawApprovalId}'.`, json, "approve");
        }
      }

      let revision: number | undefined;
      const rawRevision = optRes.value.flags.get("--revision") as string | undefined;
      if (rawRevision !== undefined) {
        const num = Number(rawRevision);
        if (!Number.isInteger(num) || num < 1) {
          return makeValidationError("Option '--revision' must be a positive integer (>= 1).", json, "approve");
        }
        revision = num;
      }

      let generation: number | undefined;
      const rawGeneration = optRes.value.flags.get("--generation") as string | undefined;
      if (rawGeneration !== undefined) {
        const num = Number(rawGeneration);
        if (!Number.isInteger(num) || num < 0) {
          return makeValidationError("Option '--generation' must be a non-negative integer (>= 0).", json, "approve");
        }
        generation = num;
      }

      const rawIdempKey = optRes.value.flags.get("--idempotency-key") as string | undefined;
      if (rawIdempKey !== undefined) {
        const idempParse = IdempotencyKeySchema.safeParse(rawIdempKey);
        if (!idempParse.success) {
          return makeValidationError(`Invalid idempotency key '${rawIdempKey}'.`, json, "approve");
        }
      }

      const value: ApproveCommandArgs = {
        command: "approve",
        taskId,
        runId: rawRunId,
        decidedBy,
        decision: rawDecision,
        reason,
        approvalId: rawApprovalId,
        revision,
        generation,
        idempotencyKey: rawIdempKey,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "resume": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set(["--idempotency-key", "--json", "-j", "--help", "-h"]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "resume", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length === 0) {
        return makeValidationError("Missing required <run-id> argument for 'bflow resume'.", json, "resume");
      }

      const runId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(runId)) {
        return makeValidationError(`Invalid run identifier '${runId}'.`, json, "resume");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow resume'.`,
          json,
          "resume"
        );
      }

      const rawIdempKey = optRes.value.flags.get("--idempotency-key") as string | undefined;
      if (rawIdempKey !== undefined) {
        const idempParse = IdempotencyKeySchema.safeParse(rawIdempKey);
        if (!idempParse.success) {
          return makeValidationError(`Invalid idempotency key '${rawIdempKey}'.`, json, "resume");
        }
      }

      const value: ResumeCommandArgs = {
        command: "resume",
        runId,
        idempotencyKey: rawIdempKey,
        json,
        help: false
      };
      return { ok: true, value };
    }

    case "cancel": {
      const booleanFlags = new Set(["--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--reason",
        "--by",
        "--requested-by",
        "--task",
        "--task-id",
        "--expected-version",
        "--idempotency-key",
        "--json",
        "-j",
        "--help",
        "-h"
      ]);

      const optRes = extractOptionsAndPositional(commandArgs, booleanFlags, allowedFlags, "cancel", json);
      if (!optRes.ok) return optRes.result;

      if (optRes.value.positional.length === 0) {
        return makeValidationError("Missing required <run-id> argument for 'bflow cancel'.", json, "cancel");
      }

      const runId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(runId)) {
        return makeValidationError(`Invalid run identifier '${runId}'.`, json, "cancel");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'bflow cancel'.`,
          json,
          "cancel"
        );
      }

      const rawReason = optRes.value.flags.get("--reason") as string | undefined;
      if (rawReason !== undefined && rawReason.trim().length === 0) {
        return makeValidationError("Option '--reason' cannot be empty.", json, "cancel");
      }
      const reason = rawReason?.trim();

      let requestedBy: string | undefined;
      if (optRes.value.flags.has("--by")) {
        const raw = optRes.value.flags.get("--by") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--by' cannot be empty.", json, "cancel");
        }
        requestedBy = raw.trim();
      } else if (optRes.value.flags.has("--requested-by")) {
        const raw = optRes.value.flags.get("--requested-by") as string;
        if (raw.trim().length === 0) {
          return makeValidationError("Option '--requested-by' cannot be empty.", json, "cancel");
        }
        requestedBy = raw.trim();
      }

      const rawTaskId =
        (optRes.value.flags.get("--task") as string | undefined) ??
        (optRes.value.flags.get("--task-id") as string | undefined);
      if (rawTaskId !== undefined) {
        if (!isValidIdentifier(rawTaskId)) {
          return makeValidationError(`Invalid task identifier '${rawTaskId}'.`, json, "cancel");
        }
      }

      let expectedVersion: number | undefined;
      const rawExpVer = optRes.value.flags.get("--expected-version") as string | undefined;
      if (rawExpVer !== undefined) {
        const num = Number(rawExpVer);
        if (!Number.isInteger(num) || num < 0) {
          return makeValidationError(
            "Option '--expected-version' must be a non-negative integer (>= 0).",
            json,
            "cancel"
          );
        }
        expectedVersion = num;
      }

      const rawIdempKey = optRes.value.flags.get("--idempotency-key") as string | undefined;
      if (rawIdempKey !== undefined) {
        const idempParse = IdempotencyKeySchema.safeParse(rawIdempKey);
        if (!idempParse.success) {
          return makeValidationError(`Invalid idempotency key '${rawIdempKey}'.`, json, "cancel");
        }
      }

      const value: CancelCommandArgs = {
        command: "cancel",
        runId,
        reason,
        requestedBy,
        taskId: rawTaskId,
        expectedVersion,
        idempotencyKey: rawIdempKey,
        json,
        help: false
      };
      return { ok: true, value };
    }
  }
}
