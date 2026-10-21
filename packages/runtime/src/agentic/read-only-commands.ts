import type { AgentRole } from "@bflow/contracts";

/**
 * Native shell allowlist enforced by the host PreToolUse guard.
 *
 * Every role except Conversation may run one read-only command, or a `|` pipeline whose every
 * segment is allowlisted. Developers additionally may run the project's build/test commands in
 * their task worktree. The command string is tokenized here without a shell: anything a shell would
 * expand, chain, redirect or substitute is refused instead of interpreted.
 */
export type NativeCommandDecision = { readonly permitted: true } | { readonly permitted: false; readonly reason: string };

/** Native tool names that carry a shell command: Claude `Bash` and the Codex shell tools. */
export const NATIVE_SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "exec_command", "shell", "local_shell", "shell_command"]);

/** Role prompt text describing the read-only shell surface (every role except Conversation). */
export const NATIVE_READ_GUIDANCE = "The native shell (Bash or exec_command) runs only read-only commands: rg, grep, ls, cat, head, tail, wc, tree, stat, file, find (no -exec/-delete/-fprint/-ok), sed -n with print-only scripts, and git log/show/diff/status/branch/ls-files/ls-tree/grep/rev-parse/blame/cat-file -p/describe; `|` pipes are allowed when every segment is allowlisted. Never use ; & && || backticks ( ) < > or newlines; $ \\ and glob/brace characters are accepted only inside single quotes (e.g. rg 'foo$'), and do not read .bflow or provider credential directories. A refusal names the rejected command or token.";

const REFUSAL_PREFIX = "Native command refused (read-only tool allowlist)";
const refuse = (reason: string): NativeCommandDecision => ({ permitted: false, reason: `${REFUSAL_PREFIX}: ${reason}` });
const PERMIT: NativeCommandDecision = { permitted: true };

/** Shell metacharacters that chain, background, substitute, redirect, escape or start a new line. */
const METACHARACTER_LABELS: ReadonlyMap<string, string> = new Map([
  [";", "';' (command chaining)"], ["&", "'&' (background/chaining)"], ["$", "'$' (expansion/substitution)"],
  ["`", "'`' (command substitution)"], ["(", "'(' (subshell/substitution)"], [")", "')' (subshell/substitution)"],
  ["<", "'<' (redirection)"], [">", "'>' (redirection)"], ["\\", "'\\' (escape)"], ["\n", "a newline"], ["\r", "a carriage return"]
]);
/** Refused everywhere, even inside single quotes, where a shell would keep them literal: kept conservative on purpose. */
const ALWAYS_FORBIDDEN = new Set([";", "&", "`", "(", ")", "<", ">", "\n", "\r"]);
/** Still active inside double quotes (expansion, substitution, escape). Inside single quotes they are literal. */
const DOUBLE_QUOTE_FORBIDDEN = new Set(["$", "\\"]);
/** Unquoted characters a shell expands into other words (globs, braces, tilde, comments); quoted they are literal. */
const UNQUOTED_EXPANSIONS = new Set(["*", "?", "[", "]", "{", "}", "~", "#", "!"]);
const forbidden = (character: string, context: string): { error: string } =>
  ({ error: `forbidden shell metacharacter ${METACHARACTER_LABELS.get(character)!}${context}` });
/** Path segments of provider credentials and Bflow host state that native reads must not name. */
const PROTECTED_SEGMENTS = new Set([".bflow", ".ssh", ".aws", ".gnupg", ".claude", ".codex", ".gemini", ".config", ".netrc", ".npmrc"]);

type Tokenized = { readonly segments: readonly string[][] } | { readonly error: string };

/**
 * Splits a command into pipeline segments of quote-removed words, exactly as a POSIX shell would for this restricted grammar.
 * Single quotes make `$ \ * ? [ ] { } |` literal; double quotes still refuse `$` and `\`; `; & ` ( ) < >` and line breaks
 * are refused in every context.
 */
export function tokenizeCommand(command: string): Tokenized {
  const segments: string[][] = [];
  let words: string[] = [], word = "", inWord = false, quote: "'" | '"' | undefined;
  const endWord = (): void => { if (inWord) words.push(word); word = ""; inWord = false; };
  for (const character of command) {
    if (ALWAYS_FORBIDDEN.has(character)) return forbidden(character, quote ? " (refused even inside quotes)" : "");
    if (quote === "'") {
      if (character === "'") quote = undefined; else word += character;
      continue;
    }
    if (quote === '"') {
      if (DOUBLE_QUOTE_FORBIDDEN.has(character)) return forbidden(character, " inside double quotes (use single quotes for a literal)");
      if (character === '"') quote = undefined; else word += character;
      continue;
    }
    if (METACHARACTER_LABELS.has(character)) return forbidden(character, "");
    if (character === "'" || character === '"') { quote = character; inWord = true; continue; }
    if (character === " " || character === "\t") { endWord(); continue; }
    if (character === "|") {
      endWord();
      if (words.length === 0) return { error: "empty pipeline segment ('||' or a leading/trailing '|')" };
      segments.push(words); words = []; continue;
    }
    if (UNQUOTED_EXPANSIONS.has(character)) return { error: `unquoted shell expansion character '${character}' (quote it to pass it literally)` };
    word += character; inWord = true;
  }
  if (quote) return { error: "unterminated quote" };
  endWord();
  if (words.length === 0) return { error: segments.length ? "empty pipeline segment ('||' or a leading/trailing '|')" : "empty command" };
  segments.push(words);
  return { segments };
}

/** A short option bundle such as `-niE` (no value attached after '=' and not a long option). */
const isShortBundle = (token: string): boolean => /^-[A-Za-z0-9]+$/.test(token);
const bundleHas = (token: string, letters: string): boolean => isShortBundle(token) && [...letters].some(letter => token.slice(1).includes(letter));

function protectedPath(token: string): string | undefined {
  const parts = token.split(/[/=:,]/);
  return parts.find(part => PROTECTED_SEGMENTS.has(part));
}

// ---------- Read-only commands (every role except Conversation) ----------

const GIT_READ_SUBCOMMANDS = new Set(["log", "show", "diff", "status", "branch", "ls-files", "ls-tree", "grep", "rev-parse", "blame", "cat-file", "describe"]);
/** Options that write files, run external programs, or retarget the repository. */
const GIT_REFUSED_OPTION = /^--(output|ext-diff|textconv|exec|upload-pack|receive-pack|git-dir|work-tree|namespace|config-env|open-files-in-pager)(=|$)/;
/** Branch listing only: any option that creates, renames, deletes or sets upstream is refused by omission. */
const BRANCH_LISTING_OPTIONS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current"]);

function checkGit(args: readonly string[]): string | undefined {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return "git requires a read-only subcommand";
  if (!GIT_READ_SUBCOMMANDS.has(subcommand)) return `git subcommand '${subcommand}' is not read-only allowlisted (allowed: ${[...GIT_READ_SUBCOMMANDS].join(", ")}; global options before the subcommand are refused)`;
  const refused = rest.find(arg => GIT_REFUSED_OPTION.test(arg));
  if (refused) return `git option '${refused}' is not permitted`;
  if (subcommand === "branch") {
    const bad = rest.find(arg => !BRANCH_LISTING_OPTIONS.has(arg));
    return bad === undefined ? undefined : `git branch argument '${bad}' is not a listing option`;
  }
  if (subcommand === "grep") {
    // -O/--open-files-in-pager runs a program; it may be bundled (-iO) or carry an attached value (-Oless).
    const bad = rest.find(arg => /^-[A-Za-z]*O/.test(arg));
    if (bad) return `git grep option '${bad}' is not permitted`;
  }
  if (subcommand === "cat-file") {
    if (!rest.includes("-p")) return "git cat-file is permitted only with -p";
    const bad = rest.find(arg => arg.startsWith("-") && arg !== "-p");
    if (bad) return `git cat-file option '${bad}' is not permitted`;
  }
  return undefined;
}

const FIND_REFUSED = /^-(exec|execdir|delete|ok|okdir|fls|fprint|fprint0|fprintf)$/;
function checkFind(args: readonly string[]): string | undefined {
  const bad = args.find(arg => FIND_REFUSED.test(arg));
  return bad ? `find action '${bad}' is not permitted` : undefined;
}

/** One sed command restricted to printing: optional address range, then p, =, l, or s/// with print-only flags. */
// Backslashes are excluded so an escaped delimiter can never shift where sed sees the command or its flags.
const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/[^/\\]*/)`;
const SED_SAFE_SCRIPT = new RegExp(`^(?:${SED_ADDRESS}(?:,(?:${SED_ADDRESS}|\\+\\d+))?)?!?(?:[p=l]|s/[^/\\\\]*/[^/\\\\]*/[gpiI0-9]*)$`);
function checkSed(args: readonly string[]): string | undefined {
  let quiet = false;
  const scripts: string[] = [], operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") { quiet = true; continue; }
    if (arg === "-e" || arg === "--expression") {
      const script = args[++index];
      if (script === undefined) return "sed -e requires a script";
      scripts.push(script); continue;
    }
    if (arg.startsWith("--expression=")) { scripts.push(arg.slice("--expression=".length)); continue; }
    if (arg.startsWith("--in-place") || /^-[A-Za-z]*[iI]/.test(arg)) return `sed option '${arg}' edits files in place and is not permitted`;
    if (arg === "-f" || arg.startsWith("--file") || bundleHas(arg, "f")) return `sed option '${arg}' (script file) is not permitted`;
    if (isShortBundle(arg)) {
      for (const letter of arg.slice(1)) {
        if (letter === "n") quiet = true;
        else if (!"Ersuz".includes(letter)) return `sed option '-${letter}' is not permitted`;
      }
      continue;
    }
    if (arg === "--posix" || arg === "--regexp-extended" || arg === "--separate" || arg === "--unbuffered" || arg === "--null-data") continue;
    if (arg.startsWith("--")) return `sed option '${arg}' is not permitted`;
    operands.push(arg);
  }
  if (!quiet) return "sed is permitted only as 'sed -n'";
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) return "sed -n requires a script";
    scripts.push(script);
  }
  const bad = scripts.find(script => !SED_SAFE_SCRIPT.test(script));
  return bad === undefined ? undefined : `sed script '${bad}' is not a print-only command (w/W/e/r and other commands are refused)`;
}

function checkRg(args: readonly string[]): string | undefined {
  // --pre/--hostname-bin run programs; -z/--search-zip spawns decompressors.
  const bad = args.find(arg => /^--(pre|pre-glob|hostname-bin|search-zip)(=|$)/.test(arg) || bundleHas(arg, "z"));
  return bad ? `rg option '${bad}' is not permitted` : undefined;
}

function checkTail(args: readonly string[]): string | undefined {
  const bad = args.find(arg => /^--(follow|retry)(=|$)/.test(arg) || bundleHas(arg, "fF"));
  return bad ? `tail option '${bad}' (follow) is not permitted` : undefined;
}

function checkTree(args: readonly string[]): string | undefined {
  // -o writes the listing to a file; -R writes 00Tree.html files with -H.
  const bad = args.find(arg => /^--(output|fromfile)(=|$)/.test(arg) || bundleHas(arg, "oR"));
  return bad ? `tree option '${bad}' is not permitted` : undefined;
}

function checkFile(args: readonly string[]): string | undefined {
  const bad = args.find(arg => /^--compile(=|$)/.test(arg) || bundleHas(arg, "C"));
  return bad ? `file option '${bad}' (writes a compiled magic file) is not permitted` : undefined;
}

const READ_COMMANDS: ReadonlyMap<string, (args: readonly string[]) => string | undefined> = new Map([
  ["rg", checkRg], ["grep", () => undefined], ["ls", () => undefined], ["cat", () => undefined], ["head", () => undefined],
  ["tail", checkTail], ["wc", () => undefined], ["tree", checkTree], ["stat", () => undefined], ["file", checkFile],
  ["find", checkFind], ["sed", checkSed], ["git", checkGit]
]);

// ---------- Developer build/test commands (task worktree) ----------

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const SCRIPT_NAMES = new Set(["test", "build", "typecheck"]);
const EXEC_TOOLS = new Set(["vitest", "tsc"]);
const NPX_TOOLS = new Set(["vitest", "tsc", "jest", "mocha"]);
/** Options that change the directory, shell, configuration, registry or Node flags of a build/test invocation. */
const BUILD_REFUSED_OPTION = /^(--(script-shell|shell|node-options|prefix|dir|cwd|userconfig|globalconfig|registry|workspace-root|global|watch|watchAll)(=.*)?|-C|-w|-g)$/;
/** Per-program options that run inline code or wrap the test binary (npx options before the tool name fail the tool check). */
const PROGRAM_REFUSED_OPTION: Readonly<Record<string, RegExp>> = {
  node: /^(--(eval|print)(=.*)?|-e|-p)$/,
  go: /^-(exec|toolexec)(=|$)/
};

function checkBuildArgs(program: string, args: readonly string[]): string | undefined {
  const bad = args.find(arg => BUILD_REFUSED_OPTION.test(arg) || PROGRAM_REFUSED_OPTION[program]?.test(arg) === true);
  return bad ? `${program} option '${bad}' is not permitted` : undefined;
}

function checkDeveloperBuild(words: readonly string[]): string | undefined {
  const [program, first, second, ...rest] = words as [string, string?, string?, ...string[]];
  if (PACKAGE_MANAGERS.has(program)) {
    if (first === "test") return checkBuildArgs(program, words.slice(2));
    if (first === "run" && second !== undefined && SCRIPT_NAMES.has(second)) return checkBuildArgs(program, rest);
    if (first === "exec" && second !== undefined && EXEC_TOOLS.has(second)) return checkBuildArgs(program, rest);
    return `${program} ${[first, second].filter(Boolean).join(" ")} is not permitted (allowed: test, run test|build|typecheck, exec vitest|tsc; no install/add/publish)`;
  }
  if (program === "npx") {
    if (first === undefined || !NPX_TOOLS.has(first)) return `npx '${first ?? ""}' is not permitted (allowed: ${[...NPX_TOOLS].join(", ")})`;
    return checkBuildArgs(program, words.slice(2));
  }
  if (program === "node") return first === "--test" ? checkBuildArgs(program, words.slice(2)) : "node is permitted only as 'node --test ...'";
  if (program === "tsc") return checkBuildArgs(program, words.slice(1));
  if (program === "go") return first === "test" ? checkBuildArgs(program, words.slice(2)) : "go is permitted only as 'go test ...'";
  if (program === "cargo") return first === "test" ? checkBuildArgs(program, words.slice(2)) : "cargo is permitted only as 'cargo test ...'";
  if (program === "pytest") return checkBuildArgs(program, words.slice(1));
  if (program === "python" || program === "python3")
    return first === "-m" && second === "pytest" ? checkBuildArgs(program, rest) : `${program} is permitted only as '${program} -m pytest ...'`;
  return undefined;
}
const DEVELOPER_PROGRAMS = new Set([...PACKAGE_MANAGERS, "npx", "node", "tsc", "go", "cargo", "pytest", "python", "python3"]);

// ---------- Decision ----------

function checkSegment(role: AgentRole, words: readonly string[]): string | undefined {
  const [program, ...args] = words as [string, ...string[]];
  const guarded = words.find(protectedPath);
  if (guarded) return `token '${guarded}' names protected path segment '${protectedPath(guarded)}'`;
  const read = READ_COMMANDS.get(program);
  if (read) return read(args);
  if (role === "developer" && DEVELOPER_PROGRAMS.has(program)) return checkDeveloperBuild(words);
  const allowed = [...READ_COMMANDS.keys()].join(", ");
  return role === "developer"
    ? `program '${program}' is not allowlisted (read: ${allowed}; build/test: npm|pnpm|yarn test/run/exec, npx, node --test, tsc, go test, cargo test, pytest, python -m pytest)`
    : `program '${program}' is not allowlisted for the ${role} role (allowed: ${allowed})`;
}

/** Decides one native shell command for a role; the reason names the refused command, token or character. */
export function evaluateNativeCommand(role: AgentRole, command: string): NativeCommandDecision {
  if (role === "conversation") return refuse("Conversation has no native shell; use the Bflow MCP tools");
  const tokenized = tokenizeCommand(command);
  if ("error" in tokenized) return refuse(`${tokenized.error} in ${JSON.stringify(command.slice(0, 200))}`);
  for (const segment of tokenized.segments) {
    const problem = checkSegment(role, segment);
    if (problem) return refuse(`${problem} in ${JSON.stringify(segment.join(" ").slice(0, 200))}`);
  }
  return PERMIT;
}

/** Extracts the command from a Claude `Bash` or Codex shell tool input; an argv array is only unwrapped from `sh|bash|zsh -c|-lc <script>`. */
export function nativeShellCommand(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const input = toolInput as Record<string, unknown>;
  const value = input.command ?? input.cmd;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(item => typeof item === "string")) {
    const argv = value as string[];
    if (argv.length === 3 && /^(\/bin\/|\/usr\/bin\/)?(sh|bash|zsh)$/.test(argv[0]!) && (argv[1] === "-c" || argv[1] === "-lc")) return argv[2];
    // A direct argv never passes through a shell; quote each word so the same tokenizer sees it verbatim.
    if (argv.length > 0 && argv.every(word => !word.includes("'"))) return argv.map(word => `'${word}'`).join(" ");
  }
  return undefined;
}

/** Host guard decision for a native PreToolUse shell call (Claude `Bash` or a Codex shell tool). */
export function guardNativeShell(role: AgentRole, tool: string, toolInput: unknown): NativeCommandDecision {
  if (!NATIVE_SHELL_TOOLS.has(tool)) return refuse(`tool '${tool}' is not a native shell tool`);
  if (role === "conversation") return refuse("Conversation has no native shell; use the Bflow MCP tools");
  const command = nativeShellCommand(toolInput);
  if (command === undefined) return refuse(`${tool} input has no readable command string`);
  return evaluateNativeCommand(role, command);
}
