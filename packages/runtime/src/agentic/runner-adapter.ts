/** Runtime-private adapter API. No executable, mount, environment or parser is accepted from role messages. */
export type ResultFormat = "vitest_json" | "node_tap" | "junit" | "go_json" | "rust_libtest" | "trx" | "jest_json" | "mocha_json" | "rspec_json";
export interface RunnerMount { source: string; target: string }
export interface RunnerIdentities { testNames: string[]; testPaths: string[] }
export interface RunnerInvocation {
  args: string[];
  /** Relative to the disposable checkout, or absolute below its private report directory. */
  reportPaths?: string[];
  prepare?: { executable: string; args: string[]; timeoutMs: number };
}
export interface AdapterRunner {
  adapterId: string;
  version: string;
  executable: string;
  /** Relative project root, '.' for the repository root. */
  projectDirectory: string;
  format: ResultFormat;
  failureExitCodes?: readonly number[];
  helpers?: { name: string; content: string }[];
  nameRule: string;
  mounts: RunnerMount[];
  environment: Record<string, string>;
  /** Repository files which define execution and are frozen together with Red tests. */
  protectedPaths: string[];
  bind(identities: RunnerIdentities, reportDirectory: string): RunnerInvocation;
  prepare?: { executable: string; args: string[]; timeoutMs: number };
}
export interface AdapterContext {
  root: string;
  dependencySource?: string;
  /** Bounded non-symlink manifest inventory, relative to root. */
  files: string[];
}
export interface AdapterDetection { runners: AdapterRunner[]; notes: string[] }
export interface RunnerAdapter {
  id: string;
  detect(context: AdapterContext): Promise<AdapterDetection>;
}

/** Node flags a `node [flags] --test` script may carry; anything else is not forwarded and is not detected. */
const NODE_TEST_FLAG = /^(--experimental-strip-types|--disable-warning=[A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Returns the allowlisted node flags that precede `--test` in a script containing `node [flags] --test`, or undefined
 * when the script has no such invocation. Only the first `node` invocation in the script is considered.
 */
export function parseNodeTestFlags(script: string): string[] | undefined {
  const tokens = script.trim().split(/\s+/);
  const start = tokens.indexOf("node");
  if (start === -1) return undefined;
  const flags: string[] = [];
  for (const token of tokens.slice(start + 1)) {
    if (token === "--test") return flags;
    if (!NODE_TEST_FLAG.test(token)) return undefined;
    flags.push(token);
  }
  return undefined;
}
