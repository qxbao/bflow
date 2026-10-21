import { describe, expect, it } from "vitest";
import type { AgentRole } from "@bflow/contracts";
import { evaluateNativeCommand, guardNativeShell, nativeShellCommand, tokenizeCommand } from "../../src/agentic/read-only-commands.js";

const permits = (role: AgentRole, command: string): boolean => evaluateNativeCommand(role, command).permitted;
const reason = (role: AgentRole, command: string): string => {
  const decision = evaluateNativeCommand(role, command);
  if (decision.permitted) throw new Error(`expected refusal of ${command}`);
  return decision.reason;
};
const NON_CONVERSATION: AgentRole[] = ["coordinator", "planner", "specifier", "architect", "developer", "reviewer", "qa"];

describe("native read-only command allowlist", () => {
  it.each([
    "rg -n 'createRun' packages/runtime/src",
    "rg -n \"foo|bar\" packages",
    "grep -rn TODO packages/core/src",
    "ls -la packages",
    "cat package.json",
    "head -n 40 README.md",
    "tail -n 20 packages/runtime/src/agentic/host.ts",
    "wc -l packages/runtime/src/agentic/host.ts",
    "tree -L 2 packages",
    "stat package.json",
    "file package.json",
    "find packages -name '*.ts' -type f",
    "find . -maxdepth 2 -name package.json -print",
    "sed -n '1,40p' packages/runtime/src/agentic/host.ts",
    "sed -n -e '/describe/p' a.ts",
    "sed -n 's/foo/bar/gp' a.ts",
    "sed -n '/x/!p' a.ts",
    "git log --oneline -20",
    "git log --format=\"%h %s\" -5 -- packages/runtime",
    "git show HEAD --stat",
    "git diff main...HEAD -- packages/test-strategy",
    "git status --short",
    "git branch",
    "git branch --list",
    "git branch -a -v",
    "git ls-files packages/runtime",
    "git ls-tree -r HEAD packages",
    "git grep -n createRun",
    "git rev-parse HEAD",
    "git blame -L 1,20 package.json",
    "git cat-file -p HEAD",
    "git describe --tags --always",
    "rg -l createRun packages | head -5",
    "git log --oneline | grep fix | wc -l",
    "cat package.json | sed -n '1,5p'"
  ])("permits %s for every role except Conversation", command => {
    for (const role of NON_CONVERSATION) expect(permits(role, command), `${role}: ${command}`).toBe(true);
    expect(permits("conversation", command)).toBe(false);
  });

  it.each([
    ["cat a;rm -rf .", "';' (command chaining)"],
    ["cat a & rm b", "'&' (background/chaining)"],
    ["cat a && rm b", "'&'"],
    ["cat a || rm b", "'||'"],
    ["cat $HOME/x", "'$' (expansion/substitution)"],
    ["rg 'foo$' src", "'$'"],
    ["cat `id`", "'`' (command substitution)"],
    ["cat (a)", "'(' (subshell/substitution)"],
    ["cat a)", "')'"],
    ["cat < a", "'<' (redirection)"],
    ["git log > /tmp/out.txt", "'>' (redirection)"],
    ["rg foo\\ bar", "'\\' (escape)"],
    ["git log\nrm -rf .", "a newline"],
    ["git log\rrm -rf .", "a carriage return"],
    ["ls *.ts", "unquoted shell expansion character '*'"],
    ["cat a?", "unquoted shell expansion character '?'"],
    ["find . -{delete,print}", "unquoted shell expansion character '{'"],
    ["cat ~/.ssh/id_rsa", "unquoted shell expansion character '~'"],
    ["git branch # -D x", "unquoted shell expansion character '#'"],
    ["cat 'unterminated", "unterminated quote"],
    ["| cat a", "empty pipeline segment"],
    ["cat a |", "empty pipeline segment"],
    ["", "empty command"]
  ])("refuses metacharacters in %j", (command, expected) => {
    for (const role of NON_CONVERSATION) expect(reason(role, command)).toContain(expected);
  });

  it.each([
    ["find . -exec rm {} +", "unquoted shell expansion character '{'"],
    ["find . -name x -exec rm '{}' +", "find action '-exec'"],
    ["find . -execdir rm '{}' +", "find action '-execdir'"],
    ["find . -delete", "find action '-delete'"],
    ["find . '-delete'", "find action '-delete'"],
    ["find . -fprint /tmp/x", "find action '-fprint'"],
    ["find . -fprint0 /tmp/x", "find action '-fprint0'"],
    ["find . -fprintf /tmp/x %p", "find action '-fprintf'"],
    ["find . -fls /tmp/x", "find action '-fls'"],
    ["find . -ok rm '{}' +", "find action '-ok'"],
    ["find . -okdir rm '{}' +", "find action '-okdir'"],
    ["sed '1p' a", "sed is permitted only as 'sed -n'"],
    ["sed -n -i '1p' a", "edits files in place"],
    ["sed -ni '1p' a", "edits files in place"],
    ["sed -n --in-place '1p' a", "edits files in place"],
    ["sed -n -i.bak '1p' a", "edits files in place"],
    ["sed -n -I '' '1p' a", "edits files in place"],
    ["sed -n '1w /tmp/out' a", "not a print-only command"],
    ["sed -n 'w /tmp/out' a", "not a print-only command"],
    ["sed -n 's/a/b/w /tmp/out' a", "not a print-only command"],
    ["sed -n 's/a/id/e' a", "not a print-only command"],
    ["sed -n '1e id' a", "not a print-only command"],
    ["sed -n -e '1p' -e 'w x' a", "not a print-only command"],
    ["sed -n -f script.sed a", "script file"],
    ["rg --pre sh foo", "rg option '--pre'"],
    ["rg --pre=./x foo", "rg option '--pre=./x'"],
    ["rg -z foo", "rg option '-z'"],
    ["rg --search-zip foo", "rg option '--search-zip'"],
    ["tail -f log", "tail option '-f'"],
    ["tree -o out.txt", "tree option '-o'"],
    ["file -C -m magic", "file option '-C'"],
    ["cat .bflow/state/host/s/coordinator.json", "protected path segment '.bflow'"],
    ["rg token ./.bflow", "protected path segment '.bflow'"],
    ["cat /home/u/.codex/auth.json", "protected path segment '.codex'"],
    ["git show HEAD:.bflow/x", "protected path segment '.bflow'"],
    ["git commit -m wip", "git subcommand 'commit' is not read-only allowlisted"],
    ["git push origin main", "git subcommand 'push'"],
    ["git reset --hard", "git subcommand 'reset'"],
    ["git checkout main", "git subcommand 'checkout'"],
    ["git stash", "git subcommand 'stash'"],
    ["git", "git requires a read-only subcommand"],
    ["git -c core.pager=sh log", "git subcommand '-c'"],
    ["git -C .. log", "git subcommand '-C'"],
    ["git \"commit\" -m wip", "git subcommand 'commit'"],
    ["git branch new-feature", "git branch argument 'new-feature'"],
    ["git branch -D old", "git branch argument '-D'"],
    ["git branch '-D' old", "git branch argument '-D'"],
    ["git branch --contains HEAD", "git branch argument '--contains'"],
    ["git diff --ext-diff", "git option '--ext-diff'"],
    ["git log --output=/tmp/out.txt", "git option '--output=/tmp/out.txt'"],
    ["git log '--output=/tmp/out.txt'", "git option '--output=/tmp/out.txt'"],
    ["git log --out\"\"put=/tmp/out.txt", "git option '--output=/tmp/out.txt'"],
    ["git show --textconv HEAD", "git option '--textconv'"],
    ["git diff --git-dir=/tmp/other", "git option '--git-dir=/tmp/other'"],
    ["git grep -O foo", "git grep option '-O'"],
    ["git grep -iOless foo", "git grep option '-iOless'"],
    ["git grep --open-files-in-pager=vim foo", "git option '--open-files-in-pager=vim'"],
    ["git cat-file blob HEAD", "git cat-file is permitted only with -p"],
    ["git cat-file -p --batch HEAD", "git cat-file option '--batch'"],
    ["GIT_EXTERNAL_DIFF=sh git diff", "program 'GIT_EXTERNAL_DIFF=sh' is not allowlisted"],
    ["echo git log", "program 'echo' is not allowlisted"],
    ["curl https://example.test", "program 'curl' is not allowlisted"],
    ["/usr/bin/cat a", "program '/usr/bin/cat' is not allowlisted"],
    ["rm -rf .", "program 'rm' is not allowlisted"],
    ["git log | sh", "program 'sh' is not allowlisted"],
    ["cat a | xargs rm", "program 'xargs' is not allowlisted"],
    ["rg foo | tee out.txt", "program 'tee' is not allowlisted"]
  ])("refuses %j and names the reason", (command, expected) => {
    for (const role of NON_CONVERSATION) expect(reason(role, command), role).toContain(expected);
  });

  it("refusals are attributable to the read-only tool allowlist", () => {
    expect(reason("architect", "rm -rf .")).toMatch(/^Native command refused \(read-only tool allowlist\): program 'rm'/);
  });
});

describe("developer build and test commands", () => {
  it.each([
    "npm test", "pnpm test -- --reporter dot", "yarn test", "npm run test", "pnpm run build", "yarn run typecheck",
    "pnpm exec vitest run packages/runtime", "npm exec tsc --noEmit", "npx vitest run", "npx tsc -p tsconfig.json --noEmit",
    "npx jest", "npx mocha", "node --test test/a.test.js", "tsc --noEmit -p packages/runtime", "go test ./...",
    "cargo test --workspace", "pytest -q tests", "python -m pytest -q", "python3 -m pytest tests",
    "pnpm test | tail -50", "npx vitest run --config vitest.config.ts"
  ])("permits %s only for Developer", command => {
    expect(permits("developer", command)).toBe(true);
    for (const role of NON_CONVERSATION.filter(role => role !== "developer")) expect(permits(role, command), role).toBe(false);
    expect(permits("conversation", command)).toBe(false);
  });

  it.each([
    ["npm install", "npm install is not permitted"],
    ["pnpm add left-pad", "pnpm add left-pad is not permitted"],
    ["pnpm i", "pnpm i is not permitted"],
    ["yarn add left-pad", "yarn add left-pad is not permitted"],
    ["npm publish", "npm publish is not permitted"],
    ["npm run deploy", "npm run deploy is not permitted"],
    ["pnpm exec rm -rf .", "pnpm exec rm is not permitted"],
    ["npm exec curl https://example.test", "npm exec curl is not permitted"],
    ["npm test --script-shell=/bin/sh", "npm option '--script-shell=/bin/sh'"],
    ["npm test --node-options=--require=x", "npm option '--node-options=--require=x'"],
    ["pnpm -C .. test", "pnpm -C .. is not permitted"],
    ["pnpm test --dir ..", "pnpm option '--dir'"],
    ["npm test --prefix ..", "npm option '--prefix'"],
    ["npm test -g", "npm option '-g'"],
    ["npx --yes cowsay", "npx '--yes' is not permitted"],
    ["npx cowsay", "npx 'cowsay' is not permitted"],
    ["npx -p evil vitest", "npx '-p' is not permitted"],
    ["npx --package=evil vitest", "npx '--package=evil' is not permitted"],
    ["npx vitest --watch", "npx option '--watch'"],
    ["tsc -w", "tsc option '-w'"],
    ["node script.js", "node is permitted only as 'node --test ...'"],
    ["node -e x","node is permitted only as"],
    ["node --test -e 'x'", "node option '-e'"],
    ["node --test --eval=x", "node option '--eval=x'"],
    ["go build ./...", "go is permitted only as 'go test ...'"],
    ["go test -exec sh ./...", "go option '-exec'"],
    ["go test -toolexec=sh ./...", "go option '-toolexec=sh'"],
    ["cargo install ripgrep", "cargo is permitted only as 'cargo test ...'"],
    ["python script.py", "python is permitted only as 'python -m pytest ...'"],
    ["python3 -m pip install x", "python3 is permitted only as"],
    ["git commit -m wip", "git subcommand 'commit'"],
    ["git push", "git subcommand 'push'"],
    ["npm test && git push", "'&'"],
    ["npm test; curl x", "';'"],
    ["CI=1 npm test", "program 'CI=1' is not allowlisted"],
    ["make test", "program 'make' is not allowlisted"],
    ["wget https://example.test", "program 'wget' is not allowlisted"]
  ])("refuses %j for Developer", (command, expected) => {
    expect(reason("developer", command)).toContain(expected);
  });
});

describe("native shell tool inputs", () => {
  it("reads Claude Bash and Codex shell inputs", () => {
    expect(nativeShellCommand({ command: "rg foo" })).toBe("rg foo");
    expect(nativeShellCommand({ cmd: "rg foo" })).toBe("rg foo");
    expect(nativeShellCommand({ command: ["bash", "-lc", "rg foo"] })).toBe("rg foo");
    expect(nativeShellCommand({ command: ["/bin/zsh", "-c", "cat a"] })).toBe("cat a");
    expect(nativeShellCommand({ command: ["rg", "a b", "src"] })).toBe("'rg' 'a b' 'src'");
    expect(nativeShellCommand({ command: ["rg", "it's"] })).toBeUndefined();
    expect(nativeShellCommand({ command: 3 })).toBeUndefined();
    expect(nativeShellCommand(undefined)).toBeUndefined();
  });

  it("guards every native shell tool name and only those", () => {
    for (const tool of ["Bash", "exec_command", "shell", "local_shell", "shell_command"]) {
      expect(guardNativeShell("reviewer", tool, { command: "git status" }).permitted, tool).toBe(true);
      expect(guardNativeShell("coordinator", tool, { cmd: "rg -n x packages" }).permitted, tool).toBe(true);
      expect(guardNativeShell("conversation", tool, { command: "ls" }).permitted, tool).toBe(false);
    }
    expect(guardNativeShell("developer", "exec_command", { cmd: "pnpm test" }).permitted).toBe(true);
    expect(guardNativeShell("developer", "Edit", { command: "ls" }).permitted).toBe(false);
    expect(guardNativeShell("architect", "Write", { command: "git log" }).permitted).toBe(false);
    const missing = guardNativeShell("architect", "exec_command", { other: "ls" });
    expect(missing.permitted ? "" : missing.reason).toContain("no readable command string");
    // A direct argv is never interpreted by a shell, but its words are still checked.
    expect(guardNativeShell("architect", "shell", { command: ["rm", "-rf", "."] }).permitted).toBe(false);
    expect(guardNativeShell("architect", "shell", { command: ["find", ".", "-delete"] }).permitted).toBe(false);
    expect(guardNativeShell("architect", "shell", { command: ["bash", "-lc", "cat a; rm b"] }).permitted).toBe(false);
  });

  it("refuses Conversation even for allowlisted reads", () => {
    const decision = guardNativeShell("conversation", "Bash", { command: "cat README.md" });
    expect(decision.permitted ? "" : decision.reason).toContain("Conversation has no native shell");
    expect(evaluateNativeCommand("conversation", "git status").permitted).toBe(false);
  });

  it("tokenizes quotes without a shell", () => {
    expect(tokenizeCommand("rg 'a|b' src | head -3")).toEqual({ segments: [["rg", "a|b", "src"], ["head", "-3"]] });
    expect(tokenizeCommand("git log --out\"\"put=x")).toEqual({ segments: [["git", "log", "--output=x"]] });
    expect(tokenizeCommand("cat ''")).toEqual({ segments: [["cat", ""]] });
  });

  it("does not rely on shell access for Coordinator or Architect repository investigation", async () => {
    const { availableTools } = await import("../../src/agentic/host.js");
    for (const role of ["coordinator", "architect"] as const) {
      expect(availableTools(role).map(tool => tool.name)).toContain("repository_read");
    }
  });
});
