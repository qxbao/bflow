import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BLOCKERS } from "../../src/agentic/blockers.js";

/**
 * Execution-path files where a new bare `throw new Error(` is forbidden: a blocker on the test-measurement
 * path must be a `TaskBlocker` so it carries `code`, `fixableBy` and `nextAction`.
 * Existing throws are grandfathered in `fixtures/execution-throw-allowlist.json` (inventory: docs/blocker-inventory.md).
 * To mark another file, add it here and regenerate the allowlist; do not widen an entry to make a new throw pass.
 */
export const GUARDED_FILES = ["behavioral-runner.ts", "task-commands.ts", "host-verification.ts"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const agenticDir = join(here, "../../src/agentic");
const allowlistPath = join(here, "fixtures/execution-throw-allowlist.json");
const MARKER = "throw new Error(";
const KEY_LENGTH = 90;

type Allowlist = { version: 1; files: Record<string, Record<string, number>> };

/** Normalised start of the throw argument; stable across reformatting and line shifts. */
export function throwKeys(source: string): string[] {
  const keys: string[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
    let from = 0;
    for (let at = line.indexOf(MARKER, from); at !== -1; at = line.indexOf(MARKER, from)) {
      from = at + MARKER.length;
      const tail = [line.slice(from), ...lines.slice(index + 1, index + 3)].join(" ");
      keys.push(tail.replace(/\s+/g, " ").trim().slice(0, KEY_LENGTH));
    }
  }
  return keys;
}

function count(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return out;
}

function loadAllowlist(): Allowlist {
  return JSON.parse(readFileSync(allowlistPath, "utf8")) as Allowlist;
}

describe("execution-path throw guard", () => {
  it("detects a bare throw new Error( and ignores comments and TaskBlocker", () => {
    const sample = ["// throw new Error(\"commented\")", "  * throw new Error(\"doc\")", "throw new TaskBlocker(\"no_test_identities\", \"m\");", "if (x) throw new Error(`boom ${x}`);"].join("\n");
    expect(throwKeys(sample)).toEqual(["`boom ${x}`);"]);
  });

  it.each(GUARDED_FILES)("%s introduces no throw new Error( beyond the allowlist", (file) => {
    const allowed = loadAllowlist().files[file] ?? {};
    const actual = count(throwKeys(readFileSync(join(agenticDir, file), "utf8")));
    const added = Object.entries(actual)
      .filter(([key, n]) => n > (allowed[key] ?? 0))
      .map(([key]) => key);
    expect(
      added,
      `New bare throw in ${file}. Use new TaskBlocker(<code>, ...) with a BLOCKERS entry (fixableBy + nextAction), or justify an allowlist entry against docs/blocker-inventory.md.`
    ).toEqual([]);
  });

  it("keeps the allowlist limited to guarded files and non-empty keys", () => {
    const allowlist = loadAllowlist();
    expect(allowlist.version).toBe(1);
    for (const [file, entries] of Object.entries(allowlist.files)) {
      expect(GUARDED_FILES as readonly string[]).toContain(file);
      for (const [key, n] of Object.entries(entries)) {
        expect(key.length).toBeGreaterThan(0);
        expect(n).toBeGreaterThan(0);
      }
    }
  });

  it("registry invariants: snake_case codes, owner from the closed set, non-empty next action", () => {
    for (const [code, entry] of Object.entries(BLOCKERS)) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(["developer", "director", "user", "environment", "runtime"]).toContain(entry.fixableBy);
      expect(entry.nextAction.trim().length).toBeGreaterThan(0);
    }
  });
});
