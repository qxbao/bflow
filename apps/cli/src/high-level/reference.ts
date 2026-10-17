import type { JsonValue } from "@bflow/contracts";
import { COMMON_FLAGS, type CommandSpec } from "./args.js";
import { HIGH_LEVEL_EXIT_CODES } from "./envelope.js";

/**
 * Machine-readable command reference for skill authors (SkillManager) and agents. Generated from
 * the same specs the parser enforces, so it cannot drift from actual behavior.
 */
export function describeHighLevelCommands(specs: readonly CommandSpec[]): JsonValue {
  const flags = (input: CommandSpec["flags"]) => Object.entries(input).map(([name, flag]) => ({
    name, type: flag.type, required: flag.required === true, repeatable: flag.multiple === true,
    ...(flag.choices !== undefined ? { choices: [...flag.choices] } : {})
  }));
  return {
    schemaVersion: 1,
    invocation: "bflow <words> [positionals] [options] --json",
    envelope: {
      stream: "stdout (also for failures when --json is given)",
      shape: "{ ok, command, exitCode, result: CommandExecutionResult(schemaVersion 3) }",
      output: "result.output = { schemaVersion: 1, command, outcome, ids, replayed, steps[], data }"
    },
    exitCodes: Object.fromEntries(Object.entries(HIGH_LEVEL_EXIT_CODES).map(([name, code]) => [String(code), name])),
    commonFlags: flags(COMMON_FLAGS),
    commands: specs.map(spec => ({
      name: spec.name,
      usage: `bflow ${spec.words.join(" ")}${spec.positionals.map(p => p.required ? ` <${p.name}>` : ` [${p.name}]`).join("")}`,
      ...JSON.parse(JSON.stringify(spec.behavior)) as Record<string, JsonValue>,
      positionals: spec.positionals.map(p => ({ name: p.name, required: p.required })),
      flags: flags(spec.flags)
    }))
  };
}
