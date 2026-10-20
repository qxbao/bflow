import type { AgentRole } from "@bflow/contracts";

/**
 * Read-only investigation roles (spike/review workflows) may run these git reads through Bash.
 * Developers keep Edit/Write only; every other role stays refused by the host guard.
 */
const INVESTIGATION_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["planner", "specifier", "architect", "reviewer", "qa"]);
const READ_ONLY_SUBCOMMANDS = new Set(["log", "show", "diff", "status", "branch"]);
/** Options that write files, run external programs, or retarget the repository. */
const REFUSED_OPTION = /^--(output|ext-diff|textconv|exec|upload-pack|receive-pack|git-dir|work-tree|namespace|config-env)(=|$)/;
/** Branch listing only: any option that creates, renames, deletes or sets upstream is refused by omission. */
const BRANCH_LISTING_OPTIONS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current"]);
/** Shell metacharacters that could chain, redirect, substitute or escape the single git invocation. */
const SHELL_METACHARACTERS = /[;|&$`()<>\\\r\n]/;

/** Strict allowlist for one `git <read-only subcommand> ...` invocation; no shell features are interpreted. */
export function permitsReadOnlyGit(command: string): boolean {
  if (SHELL_METACHARACTERS.test(command)) return false;
  // The shell removes quotes before git sees an argument, so `'--output'=x` or `--out""put=x` must be matched without them.
  const [program, subcommand, ...args] = command.trim().split(/\s+/).map(token => token.replace(/["']/g, ""));
  if (program !== "git" || subcommand === undefined || !READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
  if (args.some(arg => REFUSED_OPTION.test(arg))) return false;
  if (subcommand === "branch") return args.every(arg => BRANCH_LISTING_OPTIONS.has(arg));
  return true;
}

/** Host guard decision for a native PreToolUse call: only Bash git reads by investigation roles. */
export function permitsReadOnlyInvestigation(role: AgentRole, tool: string, command: unknown): boolean {
  return tool === "Bash" && INVESTIGATION_ROLES.has(role) && typeof command === "string" && permitsReadOnlyGit(command);
}
