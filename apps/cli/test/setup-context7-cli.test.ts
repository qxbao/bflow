import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "../dist/bin.js");
let home: string;
beforeEach(async () => { home = await mkdtemp(join("/tmp", "bflow-c7cli-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function check(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await run(process.execPath, [bin, "setup", "--check", "--json"], { env: { ...process.env, BFLOW_HOME: home, ...env }, timeout: 60_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}
const diagnostics = (stdout: string): string[] => (JSON.parse(stdout).data?.diagnostics ?? []) as string[];

it("treats a malformed CONTEXT7_API_KEY in the environment as advice, not as a reason to abort a read-only check", async () => {
  const result = await check({ CONTEXT7_API_KEY: "not-a-key" });
  const notes = diagnostics(result.stdout);
  expect(notes.some(note => note.startsWith("CONTEXT7_API_KEY in the environment is ignored"))).toBe(true);
  expect(notes.some(note => /runs anonymously/.test(note))).toBe(true);
  expect(result.stdout).not.toContain("not-a-key");
  expect(result.stderr).not.toContain("not-a-key");
}, 90_000);

it("uses a well-formed key from the environment and says only that a key is in use", async () => {
  const key = "ctx7sk-0123456789abcdef-clitest";
  const result = await check({ CONTEXT7_API_KEY: key });
  expect(diagnostics(result.stdout).some(note => /runs with an API key/.test(note))).toBe(true);
  expect(result.stdout).not.toContain(key);
}, 90_000);

it("refuses --context7-api-key-stdin from a terminal-less shell with an empty key rather than storing nothing", async () => {
  const child = execFile(process.execPath, [bin, "setup", "--apply", "--context7-api-key-stdin", "--json"], { env: { ...process.env, BFLOW_HOME: home }, timeout: 60_000 });
  let stdout = ""; let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  child.stdin?.end("   \n");
  const code = await new Promise<number>(resolve => child.on("close", code => resolve(code ?? 1)));
  expect(code).not.toBe(0);
  expect(`${stdout}${stderr}`).toMatch(/empty/i);
}, 90_000);
