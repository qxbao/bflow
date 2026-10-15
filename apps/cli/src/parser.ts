import {
  IdempotencyKeySchema,
  IdentifierSchema,
  RunStatusSchema,
  type ContractError,
  type RunStatus
} from "@ai-flow/contracts";
import { isHumanApprover } from "@ai-flow/runtime";
import type {
  ApproveCommandArgs,
  CancelCommandArgs,
  CliCommandName,
  HelpCommandArgs,
  InitCommandArgs,
  ParseCliResult,
  ResumeCommandArgs,
  RunCommandArgs,
  StatusCommandArgs
} from "./types.js";

const VALID_COMMANDS: ReadonlySet<CliCommandName> = new Set([
  "init",
  "run",
  "status",
  "approve",
  "resume",
  "cancel",
  "help"
]);

const GLOBAL_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "-j",
  "--help",
  "-h"
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
  let idx = 0;

  while (idx < argv.length) {
    const token = argv[idx]!;
    if (token === "--json" || token === "-j") {
      leadingJson = true;
      idx++;
    } else if (token === "--help" || token === "-h") {
      leadingHelp = true;
      idx++;
    } else {
      break;
    }
  }

  const effectiveJson = leadingJson || json;
  const remaining = argv.slice(idx);

  if (remaining.length === 0) {
    const value: HelpCommandArgs = {
      command: "help",
      help: true,
      json: effectiveJson
    };
    return { ok: true, value };
  }

  if (leadingHelp) {
    const firstRemaining = remaining[0]!;
    if (VALID_COMMANDS.has(firstRemaining as CliCommandName)) {
      if (firstRemaining === "help") {
        const nonFlags = remaining.slice(1).filter((a) => !isFlag(a));
        const topic = nonFlags[0];
        if (topic !== undefined) {
          if (VALID_COMMANDS.has(topic as CliCommandName)) {
            const value: HelpCommandArgs = {
              command: "help",
              topic: topic as CliCommandName,
              help: true,
              json: effectiveJson
            };
            return { ok: true, value };
          }
          return makeValidationError(
            `Unknown help topic '${topic}'. Run 'flow --help' for usage.`,
            effectiveJson,
            "help"
          );
        }
        const value: HelpCommandArgs = {
          command: "help",
          help: true,
          json: effectiveJson
        };
        return { ok: true, value };
      }

      const value: HelpCommandArgs = {
        command: "help",
        topic: firstRemaining as CliCommandName,
        help: true,
        json: effectiveJson
      };
      return { ok: true, value };
    }

    if (!isFlag(firstRemaining)) {
      return makeValidationError(
        `Unknown help topic '${firstRemaining}'. Run 'flow --help' for usage.`,
        effectiveJson,
        "help"
      );
    }
    return makeValidationError(
      `Unknown command '${firstRemaining}'. Run 'flow --help' for usage.`,
      effectiveJson
    );
  }

  if (leadingJson) {
    const firstRemaining = remaining[0]!;
    if (VALID_COMMANDS.has(firstRemaining as CliCommandName)) {
      return parseCliArgs([firstRemaining, ...remaining.slice(1), "--json"]);
    }
    return makeValidationError(
      `Unknown command '${firstRemaining}'. Run 'flow --help' for usage.`,
      true
    );
  }

  const first = argv[0]!;

  if (first === "help") {
    const nonFlags = argv.slice(1).filter((a) => !isFlag(a));
    const topic = nonFlags[0];
    if (topic !== undefined) {
      if (VALID_COMMANDS.has(topic as CliCommandName)) {
        const value: HelpCommandArgs = {
          command: "help",
          topic: topic as CliCommandName,
          help: true,
          json
        };
        return { ok: true, value };
      }
      return makeValidationError(`Unknown help topic '${topic}'. Run 'flow --help' for usage.`, json, "help");
    }
    const value: HelpCommandArgs = {
      command: "help",
      help: true,
      json
    };
    return { ok: true, value };
  }

  if (!VALID_COMMANDS.has(first as CliCommandName)) {
    return makeValidationError(`Unknown command '${first}'. Run 'flow --help' for usage.`, json);
  }

  const command = first as Exclude<CliCommandName, "help">;
  const hasGlobalHelp = argv.some((a) => a === "--help" || a === "-h");

  if (hasGlobalHelp) {
    const value: HelpCommandArgs = {
      command: "help",
      topic: command,
      help: true,
      json
    };
    return { ok: true, value };
  }

  const commandArgs = argv.slice(1);

  switch (command) {
    case "init": {
      const booleanFlags = new Set(["--force", "-f", "--yes", "-y", "--json", "-j", "--help", "-h"]);
      const allowedFlags = new Set([
        "--dir",
        "--config",
        "--name",
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
          `Unexpected positional argument '${optRes.value.positional[0]}' for 'flow init'.`,
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
        force,
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
        return makeValidationError("Missing required <requirement> argument for 'flow run'.", json, "run");
      }

      const requirement = optRes.value.positional[0]!.trim();
      if (requirement.length === 0) {
        return makeValidationError("Missing required <requirement> argument for 'flow run'.", json, "run");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'flow run'.`,
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
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'flow status'.`,
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
        return makeValidationError("Missing required <task-id> argument for 'flow approve'.", json, "approve");
      }

      const taskId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(taskId)) {
        return makeValidationError(`Invalid task identifier '${taskId}'.`, json, "approve");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'flow approve'.`,
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
        return makeValidationError("Missing required <run-id> argument for 'flow resume'.", json, "resume");
      }

      const runId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(runId)) {
        return makeValidationError(`Invalid run identifier '${runId}'.`, json, "resume");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'flow resume'.`,
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
        return makeValidationError("Missing required <run-id> argument for 'flow cancel'.", json, "cancel");
      }

      const runId = optRes.value.positional[0]!.trim();
      if (!isValidIdentifier(runId)) {
        return makeValidationError(`Invalid run identifier '${runId}'.`, json, "cancel");
      }

      if (optRes.value.positional.length > 1) {
        return makeValidationError(
          `Unexpected positional argument '${optRes.value.positional[1]}' for 'flow cancel'.`,
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
