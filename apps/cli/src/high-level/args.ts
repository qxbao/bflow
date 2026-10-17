import { HighLevelError, usageError, type CommandOutcome, type HighLevelCommandName } from "./envelope.js";

export interface FlagSpec {
  readonly type: "string" | "boolean" | "integer";
  readonly multiple?: boolean;
  readonly required?: boolean;
  /** Restricts string values. */
  readonly choices?: readonly string[];
}

/** Machine-readable behavior contract published in the command reference. */
export interface CommandBehavior {
  readonly summary: string;
  /** What the command may change: nothing, repository-scoped Bflow/Git state, or machine-scoped files. */
  readonly mutates: "none" | "repository" | "machine";
  /** read_only: always safe; retry_safe: repeats reconcile; resume_required: an interrupted run needs --resume. */
  readonly retry: "read_only" | "retry_safe" | "resume_required";
  /** Default idempotency key; `<...>` are argument placeholders. */
  readonly idempotencyKey?: string;
  /** Flags that grant permission for a risky step; without them the command stops before it. */
  readonly permissionFlags: readonly string[];
  readonly outcomes: readonly CommandOutcome[];
}

export interface CommandSpec {
  readonly name: HighLevelCommandName;
  readonly behavior: CommandBehavior;
  /** Command words after `bflow`, e.g. ["task", "implement"]. */
  readonly words: readonly string[];
  readonly positionals: readonly { readonly name: string; readonly required: boolean }[];
  readonly flags: Readonly<Record<string, FlagSpec>>;
}

export interface ParsedHighLevelArgs {
  readonly spec: CommandSpec;
  readonly json: boolean;
  readonly help: boolean;
  readonly positionals: Readonly<Record<string, string>>;
  readonly strings: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
  readonly integers: ReadonlyMap<string, number>;
  readonly correlationId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

/** Flags accepted by every high-level command. */
export const COMMON_FLAGS: Readonly<Record<string, FlagSpec>> = {
  "--json": { type: "boolean" },
  "--help": { type: "boolean" },
  "--correlation-id": { type: "string" },
  "--idempotency-key": { type: "string" }
};

const ALIASES: Readonly<Record<string, string>> = { "-j": "--json", "-h": "--help" };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export function isSafeIdentifier(value: string): boolean {
  return SAFE_ID.test(value) && !value.split("/").some(part => part === "." || part === "..");
}

function fail(message: string): never {
  throw new HighLevelError(usageError(message));
}

/** Parses `argv` after the command words. Throws HighLevelError(usage) on invalid input. */
export function parseCommandArgs(spec: CommandSpec, argv: readonly string[]): ParsedHighLevelArgs {
  const flags = { ...COMMON_FLAGS, ...spec.flags };
  const label = spec.words.join(" ");
  const positionals: string[] = [];
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const booleans = new Set<string>();
  const integers = new Map<string, number>();

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!raw.startsWith("-") || raw === "-") { positionals.push(raw); continue; }
    const eq = raw.indexOf("=");
    const name = ALIASES[eq === -1 ? raw : raw.slice(0, eq)] ?? (eq === -1 ? raw : raw.slice(0, eq));
    const flag = flags[name];
    if (flag === undefined) fail(`Unknown option '${name}' for 'bflow ${label}'. Run 'bflow ${label} --help'.`);
    if (flag.type === "boolean") {
      if (eq !== -1) fail(`Option '${name}' does not take a value.`);
      booleans.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = raw.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || (value.startsWith("-") && value !== "-")) fail(`Option '${name}' requires a value.`);
      i++;
    }
    if (value.trim().length === 0) fail(`Option '${name}' requires a non-empty value.`);
    if (value.includes("\0")) fail(`Option '${name}' must not contain NUL bytes.`);
    if (flag.choices !== undefined && !flag.choices.includes(value))
      fail(`Option '${name}' must be one of: ${flag.choices.join(", ")}.`);
    if (flag.type === "integer") {
      if (!/^\d+$/.test(value)) fail(`Option '${name}' must be a non-negative integer.`);
      if (integers.has(name)) fail(`Option '${name}' may be given only once.`);
      integers.set(name, Number.parseInt(value, 10));
    } else if (flag.multiple === true) {
      lists.set(name, [...(lists.get(name) ?? []), value]);
    } else {
      if (strings.has(name)) fail(`Option '${name}' may be given only once.`);
      strings.set(name, value);
    }
  }

  const help = booleans.has("--help");
  const named: Record<string, string> = {};
  if (!help) {
    if (positionals.length > spec.positionals.length)
      fail(`Unexpected argument '${positionals[spec.positionals.length]}' for 'bflow ${label}'.`);
    spec.positionals.forEach((positional, index) => {
      const value = positionals[index];
      if (value === undefined) {
        if (positional.required) fail(`Missing required argument <${positional.name}> for 'bflow ${label}'.`);
        return;
      }
      if (!isSafeIdentifier(value)) fail(`Argument <${positional.name}> '${value}' is not a valid identifier.`);
      named[positional.name] = value;
    });
    for (const [name, flag] of Object.entries(spec.flags))
      if (flag.required === true && !strings.has(name) && !lists.has(name) && !integers.has(name))
        fail(`Missing required option '${name}' for 'bflow ${label}'.`);
  }

  for (const name of ["--correlation-id", "--idempotency-key"] as const) {
    const value = strings.get(name);
    if (value !== undefined && !isSafeIdentifier(value)) fail(`Option '${name}' must be a safe identifier.`);
  }

  return {
    spec,
    json: booleans.has("--json"),
    help,
    positionals: named,
    strings,
    lists,
    booleans,
    integers,
    correlationId: strings.get("--correlation-id"),
    idempotencyKey: strings.get("--idempotency-key")
  };
}
