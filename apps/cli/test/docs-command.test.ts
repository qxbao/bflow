import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs, runCli } from "../src/index.js";
import { discoverAgentAccess } from "../src/docs-gateway.js";
import { fixtureDirectory, startGateway, startUpstream, type Upstream } from "./helpers/context7-fixtures.js";

const parse = (...args: string[]) => parseCliArgs(args);
const value = (...args: string[]) => { const result = parse(...args); if (!result.ok) throw new Error(result.error.message); return result.value as any; };
const rejected = (...args: string[]) => { const result = parse(...args); expect(result.ok, args.join(" ")).toBe(false); return result.ok ? "" : result.error.message; };

describe("bflow docs parsing", () => {
  it("parses search, lookup and status with every option", () => {
    expect(value("docs", "search", "react")).toMatchObject({ command: "docs", action: "search", library: "react", json: false });
    expect(value("docs", "search", "next.js", "--query", "routing", "--version", "v15.1.8", "--json")).toMatchObject({ action: "search", library: "next.js", query: "routing", version: "v15.1.8", json: true });
    expect(value("docs", "lookup", "react", "--query", "useEffect cleanup", "--language", "typescript", "--no-cache", "--role", "reviewer", "--timeout", "5000", "-j"))
      .toMatchObject({ action: "lookup", library: "react", query: "useEffect cleanup", language: "typescript", noCache: true, role: "reviewer", timeoutMs: 5000, json: true });
    expect(value("docs", "lookup", "--library-id", "/vercel/next.js/v15.1.8", "--query", "route handlers")).toMatchObject({ action: "lookup", libraryId: "/vercel/next.js/v15.1.8" });
    expect(value("docs", "status", "--json")).toMatchObject({ action: "status", json: true });
    expect(value("docs", "--query=x", "lookup", "@scope/pkg")).toMatchObject({ action: "lookup", library: "@scope/pkg", query: "x" });
  });

  it("rejects malformed input with a specific message", () => {
    expect(rejected("docs")).toMatch(/Missing subcommand/);
    expect(rejected("docs", "fetch", "react")).toMatch(/Unknown subcommand 'fetch'/);
    expect(rejected("docs", "search")).toMatch(/exactly one library/);
    expect(rejected("docs", "search", "a", "b")).toMatch(/exactly one library/);
    expect(rejected("docs", "search", "react; rm -rf /")).toMatch(/library name/);
    expect(rejected("docs", "lookup", "react")).toMatch(/requires --query/);
    expect(rejected("docs", "lookup", "--query", "x")).toMatch(/library name or --library-id/);
    expect(rejected("docs", "lookup", "react", "--library-id", "/a/b", "--query", "x")).toMatch(/either a library name or --library-id/);
    expect(rejected("docs", "lookup", "--library-id", "not-an-id", "--query", "x")).toMatch(/--library-id/);
    expect(rejected("docs", "lookup", "react", "--query", "x".repeat(2001))).toMatch(/1-2000/);
    expect(rejected("docs", "lookup", "react", "--query", "x", "--version", "../../etc")).toMatch(/--version/);
    expect(rejected("docs", "lookup", "react", "--query", "x", "--language", "bad lang!")).toMatch(/--language/);
    expect(rejected("docs", "status", "--role", "conversation")).toMatch(/--role/);
    expect(rejected("docs", "status", "--timeout", "10")).toMatch(/--timeout/);
    expect(rejected("docs", "status", "extra")).toMatch(/Unexpected positional/);
    expect(rejected("docs", "search", "react", "--no-cache")).toMatch(/Unknown option/);
    expect(rejected("docs", "status", "--query", "x")).toMatch(/Unknown option/);
  });

  it("shows help for the command", async () => {
    const result = await runCli(["docs", "--help"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("bflow docs <search|lookup|status>");
    expect(result.stdout).toContain("never start a documentation server of their own");
    expect((await runCli(["--help"])).stdout).toContain("docs            Look up current library documentation");
  });
});

let upstream: Upstream;
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let repo: string;
let state: string;
let resolveReact: string;
beforeEach(async () => {
  resolveReact = await readFile(join(fixtureDirectory, "resolve-react.txt"), "utf8");
  upstream = await startUpstream(resolveReact);
  repo = await realpath(await mkdtemp(join("/tmp", "bflow-docs-")));
  state = join(repo, "machine-state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "^18.2.0" } }));
  await writeFile(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/react": { version: "18.2.0" } } }));
  expect((await runCli(["init"], { cwd: repo })).ok).toBe(true);
});
afterEach(async () => { await stack?.stop(); stack = undefined; await upstream.close(); await rm(repo, { recursive: true, force: true }); });

const docs = async (extra: { access?: "agent" | "none"; cache?: boolean } = {}) => {
  stack ??= await startGateway(upstream.endpoint);
  const agent = await stack.enroll("developer", "claude");
  return { cwd: repo, docs: { stateDirectory: state, machineId: "m1", grantedRoles: ["developer"],
    access: async () => extra.access === "none" ? { mode: "none" as const, kind: "not_granted" as const, reason: "This role has no Context7 grant." } : { mode: "agent" as const, target: agent } } };
};
const envelope = (stdout: string) => JSON.parse(stdout) as { ok: boolean; command: string; data: any };

describe("bflow docs commands against a shared Gateway", () => {
  it("looks documentation up for the version the repository's lockfile pins and reports what it used", async () => {
    const context = await docs();
    const result = await runCli(["docs", "lookup", "react", "--query", "useEffect cleanup", "--json"], context);
    expect(result.exitCode).toBe(0);
    const { data } = envelope(result.stdout);
    expect(data).toMatchObject({ docs: true, action: "lookup", ok: true, access: { mode: "agent" },
      lookup: { libraryId: "/react/react/v18.2.0", requestedVersion: "18.2.0", versionUsed: "v18.2.0", versionSource: "installed", versionMatch: "exact", cache: { hit: false } } });
    expect(data.lookup.installed).toMatchObject({ dependency: "react", exact: true, source: "package-lock.json" });
    expect(data.lookup.content).toBe("docs for /react/react/v18.2.0: useEffect cleanup");
    expect(data.metrics).toMatchObject({ lookups: 1, resolveCalls: 1, queryCalls: 1 });
    expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(1);
  });

  it("lets an explicit version override the repository's and says so", async () => {
    const result = await runCli(["docs", "lookup", "react", "--query", "x", "--version", "19.2.7", "--json"], await docs());
    expect(envelope(result.stdout).data.lookup).toMatchObject({ requestedVersion: "19.2.7", versionSource: "explicit", versionUsed: "v19.2.7" });
  });

  it("searches for libraries and shows the version choice for the project", async () => {
    const result = await runCli(["docs", "search", "react", "--json"], await docs());
    expect(result.exitCode).toBe(0);
    const { data } = envelope(result.stdout);
    expect(data.search).toMatchObject({ selection: "selected", version: { libraryId: "/react/react/v18.2.0", match: "exact" } });
    expect(data.search.candidates.length).toBeGreaterThan(1);
  });

  it("exits 1 with a classified failure, and never invents content", async () => {
    const context = await docs();
    const result = await runCli(["docs", "lookup", "zzzz-no-such-lib-qq", "--query", "x", "--json"], context);
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).data).toMatchObject({ ok: false, failure: { kind: "library_not_found", stage: "resolve" } });
    expect(envelope(result.stdout).data.lookup).toBeUndefined();
    upstream.behave({ queryText: () => ({ text: 'Library "/x/y" not found.', isError: true }) });
    const missing = await runCli(["docs", "lookup", "--library-id", "/x/y", "--query", "x", "--json"], context);
    expect(missing.exitCode).toBe(1);
    expect(envelope(missing.stdout).data.failure.kind).toBe("library_not_found");
  });

  it("explains a missing Gateway grant instead of working around it", async () => {
    const result = await runCli(["docs", "lookup", "react", "--query", "x", "--json"], await docs({ access: "none" }));
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).data).toMatchObject({ ok: false, access: { mode: "none" }, failure: { kind: "permission_denied", stage: "access" } });
    expect(upstream.seen.filter(item => item.tool)).toHaveLength(0);
  });

  it("renders readable output and removes terminal control sequences from retrieved text", async () => {
    upstream.behave({ queryText: () => ({ text: "Safe \u001b[31mred\u001b[0m text\u0007 and a bell" }) });
    const result = await runCli(["docs", "lookup", "react", "--query", "x"], await docs());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Documentation for");
    expect(result.stdout).toContain("/react/react/v18.2.0");
    expect(result.stdout).toContain("requested 18.2.0 (installed)");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u0007");
    expect(result.stdout).toContain("Safe [31mred[0m text and a bell");
    const failure = await runCli(["docs", "lookup", "zzzz-no-such-lib-qq", "--query", "x"], await docs());
    expect(failure.stdout).toContain("[FAIL] docs lookup (resolve): library_not_found");
  });

  it("caches only when the repository enables it, stores no query text, and keeps the cache private", async () => {
    upstream.behave({ queryText: () => ({ text: "static public documentation" }) });
    const context = await docs();
    const first = await runCli(["docs", "lookup", "react", "--query", "secret internal wording", "--json"], context);
    expect(envelope(first.stdout).data.lookup.cache).toEqual({ hit: false, stored: false });
    const configPath = join(repo, ".bflow", "config.yml");
    const text = await readFile(configPath, "utf8");
    await writeFile(configPath, text.replace(/context7:\n(\s+)enabled: true\n(\s+)required: false(?:\n\s+cache:\n\s+enabled: false\n\s+ttlSeconds: \d+\n\s+allowAuthenticated: false)?/, "context7:\n$1enabled: true\n$2required: false\n$1cache:\n$1  enabled: true\n$1  ttlSeconds: 600"));
    expect(await readFile(configPath, "utf8")).toContain("ttlSeconds: 600");
    const second = await runCli(["docs", "lookup", "react", "--query", "secret internal wording", "--json"], context);
    expect(envelope(second.stdout).data.lookup.cache).toEqual({ hit: false, stored: true });
    const third = await runCli(["docs", "lookup", "react", "--query", "secret internal wording", "--json"], context);
    expect(envelope(third.stdout).data.lookup.cache).toEqual({ hit: true, stored: false });
    expect(upstream.seen.filter(item => item.tool === "query-docs")).toHaveLength(2);
    const directory = join(state, "docs-cache");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(await readFile(join(directory, files[0]!), "utf8")).not.toContain("secret internal wording");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const bypass = await runCli(["docs", "lookup", "react", "--query", "secret internal wording", "--no-cache", "--json"], context);
    expect(envelope(bypass.stdout).data.lookup.cache.hit).toBe(false);
  });

  it("reports status through the same health model as doctor", async () => {
    const context = await docs();
    await writeFile(join(state, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: stack!.endpoint,
      observedAt: new Date().toISOString(), observations: [{ serviceId: "context7", status: "ready", discoveredTools: ["resolve-library-id", "query-docs"] }] }), { mode: 0o600 });
    const result = await runCli(["docs", "status", "--json"], context);
    expect(result.exitCode).toBe(0);
    const { data } = envelope(result.stdout);
    expect(data).toMatchObject({ action: "status", ok: true, health: { state: "healthy", enabled: true, required: false } });
    expect(data.health.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`)).toEqual(expect.arrayContaining([
      "gateway:pass", "service:pass", "authentication:pass", "connection:pass", "discovery:pass", "resolve-library-id:pass", "query-docs:pass", "quota:pass"]));
    const human = await runCli(["docs", "status"], context);
    expect(human.stdout).toContain("Context7: healthy (optional)");
    await rm(join(state, "setup-gateway-ready.json"));
    const down = await runCli(["docs", "status", "--json"], context);
    expect(down.exitCode).toBe(1);
    expect(envelope(down.stdout).data.health).toMatchObject({ state: "degraded" });
  });
});

describe("agent Gateway access discovery", () => {
  const launchId = "launch-abc123";
  async function plan(overrides: Record<string, unknown> = {}, session = "bf-session") {
    const host = join(resolvePrivateRuntimeStateDirectory(repo), "host", session, "gateway-probes");
    await mkdir(host, { recursive: true, mode: 0o700 });
    await writeFile(join(host, `${launchId}.json`), JSON.stringify({ schemaVersion: 3, launchId, endpoint: "http://127.0.0.1:4000/mcp",
      entries: [{ registrationId: "reg-1", envName: "BFLOW_MCP_TOKEN_REG_1", allowedTools: ["resolve-library-id", "query-docs"] }], ...overrides }), { mode: 0o600 });
  }
  const env = { BFLOW_LAUNCH_ID: launchId, BFLOW_MCP_TOKEN_REG_1: "a".repeat(64) };

  it("finds the agent's own registration from its launch id and token environment variable", async () => {
    await plan();
    expect(await discoverAgentAccess(env, repo)).toEqual({ endpoint: "http://127.0.0.1:4000/mcp", token: "a".repeat(64), registrationId: "reg-1" });
  });

  it("returns nothing when the launch, the token, the tools or the endpoint do not qualify", async () => {
    await plan();
    expect(await discoverAgentAccess({}, repo)).toBeUndefined();
    expect(await discoverAgentAccess({ BFLOW_LAUNCH_ID: launchId }, repo)).toBeUndefined();
    expect(await discoverAgentAccess({ ...env, BFLOW_LAUNCH_ID: "../escape" }, repo)).toBeUndefined();
    expect(await discoverAgentAccess({ ...env, BFLOW_LAUNCH_ID: "another-launch" }, repo)).toBeUndefined();
    await plan({ entries: [{ registrationId: "reg-1", envName: "BFLOW_MCP_TOKEN_REG_1", allowedTools: ["resolve-library-id"] }] });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
    await plan({ endpoint: "https://evil.example.com/mcp" });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
    await plan({ entries: [{ registrationId: "reg-1", envName: "NOT_A_TOKEN_NAME", allowedTools: ["resolve-library-id", "query-docs"] }] });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
  });
});

describe("required Context7 refusal", () => {
  it("blocks startup only when it is enabled, required and a check fails", async () => {
    const { requiredContext7Refusal } = await import("../src/docs-health.js");
    const failing = [{ id: "service" as const, status: "fail" as const, message: "blocked", remediation: "Run setup." }];
    expect(requiredContext7Refusal({ enabled: true, required: true, checks: failing })).toMatch(/Required Context7 documentation service is not ready: blocked.*Run setup\./);
    expect(requiredContext7Refusal({ enabled: true, required: false, checks: failing })).toBeUndefined();
    expect(requiredContext7Refusal({ enabled: false, required: true, checks: failing })).toBeUndefined();
    expect(requiredContext7Refusal({ enabled: true, required: true, checks: [{ id: "gateway" as const, status: "pass" as const, message: "ok" }] })).toBeUndefined();
  });
});

describe("Gateway response and host-root handling", () => {
  const stream = (...chunks: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });

  it("reads the response with the right id from an event stream with comments, notifications and no closing blank line", async () => {
    const { readEvent } = await import("../src/docs-gateway.js");
    const reply = (id: number) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `answer ${id}` }] } })}`;
    expect(await readEvent(stream(`: ping\n\n${reply(3)}\n\n`), 3)).toMatchObject({ id: 3 });
    expect(await readEvent(stream(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`, `${reply(5)}\n\n`), 5)).toMatchObject({ id: 5 });
    expect(await readEvent(stream(reply(7).slice(0, 30), `${reply(7).slice(30)}`), 7)).toMatchObject({ id: 7 });
    expect(await readEvent(stream(`${reply(1)}\n\n`), 2)).toBeUndefined();
    expect(await readEvent(stream(": only a comment\n\n"), 1)).toBeUndefined();
  });

  it("resolves the host's repository from a task worktree, so an agent finds its own registration there", async () => {
    const { resolveHostRepositoryRoot } = await import("../src/docs-gateway.js");
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-q", "-m", "init"]);
    const worktree = join(repo, "..", `${repo.split("/").pop()}-wt`);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "task-branch", worktree]);
    try {
      expect(await resolveHostRepositoryRoot(repo)).toBe(repo);
      expect(await resolveHostRepositoryRoot(await realpath(worktree))).toBe(repo);
      expect(await resolveHostRepositoryRoot(await mkdtemp(join("/tmp", "bflow-nogit-")))).toBeUndefined();
    } finally { await rm(worktree, { recursive: true, force: true }); }
  });

  it("does not create Bflow state in a directory that has none while looking for an agent's access", async () => {
    const bare = await realpath(await mkdtemp(join("/tmp", "bflow-nobflow-")));
    try {
      expect(await discoverAgentAccess({ BFLOW_LAUNCH_ID: "launch-abc123", BFLOW_MCP_TOKEN_REG_1: "a".repeat(64) }, bare)).toBeUndefined();
      expect(await readdir(bare)).toEqual([]);
    } finally { await rm(bare, { recursive: true, force: true }); }
  });

  it("keeps the CLI's Context7 identity identical to the tool installer's", async () => {
    const installer = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
    const { CONTEXT7_SERVICE_ID, CONTEXT7_TOOLS } = await import("../src/context7-constants.js");
    expect(CONTEXT7_SERVICE_ID).toBe(installer.CONTEXT7_SERVICE_ID);
    expect([...CONTEXT7_TOOLS]).toEqual([...installer.CONTEXT7_TOOLS]);
  });
});
