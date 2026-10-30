import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePrivateRuntimeStateDirectory } from "@bflow/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs, runCli } from "../src/index.js";
import { discoverAgentAccess } from "../src/docs-gateway.js";
import { DEEPWIKI_ID, DEEPWIKI_TOOL_NAMES, STRUCTURE_TEXT, startGateway, startUpstream, type Upstream } from "./helpers/context7-fixtures.js";

const parse = (...args: string[]) => parseCliArgs(args);
const value = (...args: string[]) => { const result = parse(...args); if (!result.ok) throw new Error(result.error.message); return result.value as any; };
const rejected = (...args: string[]) => { const result = parse(...args); expect(result.ok, args.join(" ")).toBe(false); return result.ok ? "" : result.error.message; };

// File name kept from the Context7 era: this suite carries the legacy `bflow docs` regression coverage over to DeepWiki.
describe("bflow docs parsing", () => {
  it("parses ask, structure, contents, status and probe with every option", () => {
    expect(value("docs", "ask", "--repo", "facebook/react", "--public", "--question", "How are hooks scheduled?")).toMatchObject({ command: "docs", action: "ask", repo: "facebook/react", publicRepository: true, question: "How are hooks scheduled?", json: false });
    expect(value("docs", "ask", "--repo", "vercel/next.js", "--public", "--question", "routing", "--role", "reviewer", "--timeout", "5000", "-j"))
      .toMatchObject({ action: "ask", repo: "vercel/next.js", role: "reviewer", timeoutMs: 5000, json: true });
    expect(value("docs", "structure", "--repo", "facebook/react", "--public")).toMatchObject({ action: "structure", repo: "facebook/react", publicRepository: true });
    expect(value("docs", "contents", "--repo", "facebook/react", "--public", "--json")).toMatchObject({ action: "contents", json: true });
    expect(value("docs", "status", "--json")).toMatchObject({ action: "status", json: true });
    expect(value("docs", "probe")).toMatchObject({ action: "probe", live: false });
    expect(value("docs", "probe", "--live", "--json")).toMatchObject({ action: "probe", live: true, json: true });
    expect(value("docs", "--question=x", "ask", "--repo=a/b", "--public")).toMatchObject({ action: "ask", repo: "a/b", question: "x" });
  });

  it("rejects malformed input with a specific message", () => {
    expect(rejected("docs")).toMatch(/Missing subcommand/);
    expect(rejected("docs", "fetch", "react")).toMatch(/Unknown subcommand 'fetch'/);
    expect(rejected("docs", "search", "react")).toMatch(/Unknown subcommand/);
    expect(rejected("docs", "lookup", "react", "--query", "x")).toMatch(/Unknown subcommand/);
    expect(rejected("docs", "ask", "--public", "--question", "x")).toMatch(/--repo/);
    expect(rejected("docs", "ask", "--repo", "facebook/react", "--question", "x")).toMatch(/--public/);
    expect(rejected("docs", "ask", "--repo", "facebook/react", "--public")).toMatch(/requires --question/);
    expect(rejected("docs", "ask", "--repo", "git@github.com:acme/private-product.git", "--public", "--question", "x")).toMatch(/owner\/repo/);
    expect(rejected("docs", "ask", "--repo", "https://github.com/facebook/react", "--public", "--question", "x")).toMatch(/owner\/repo/);
    expect(rejected("docs", "ask", "--repo", "facebook/react", "--public", "--question", "x".repeat(2001))).toMatch(/1-2000/);
    expect(rejected("docs", "status", "--role", "conversation")).toMatch(/--role/);
    expect(rejected("docs", "status", "--timeout", "10")).toMatch(/--timeout/);
    expect(rejected("docs", "status", "extra")).toMatch(/Unexpected positional/);
    expect(rejected("docs", "status", "--question", "x")).toMatch(/Unknown option/);
    expect(rejected("docs", "structure", "--repo", "facebook/react", "--public", "--question", "x")).toMatch(/Unknown option/);
  });

  it("shows help for the command", async () => {
    const result = await runCli(["docs", "--help"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("bflow docs <ask|structure|contents|status|probe>");
    expect(result.stdout).toContain("never start a documentation server of their own");
    expect((await runCli(["--help"])).stdout).toContain("docs            Read public repository documentation through DeepWiki");
  });
});

let upstream: Upstream;
let stack: Awaited<ReturnType<typeof startGateway>> | undefined;
let repo: string;
let state: string;
beforeEach(async () => {
  upstream = await startUpstream();
  repo = await realpath(await mkdtemp(join("/tmp", "bflow-docs-")));
  state = join(repo, "machine-state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "^18.2.0" } }));
  expect((await runCli(["init"], { cwd: repo })).ok).toBe(true);
});
afterEach(async () => { await stack?.stop(); stack = undefined; await upstream.close(); await rm(repo, { recursive: true, force: true }); });

const docs = async (extra: { access?: "agent" | "none" } = {}) => {
  stack ??= await startGateway(upstream.endpoint);
  const agent = await stack.enroll("developer", "claude");
  return { cwd: repo, docs: { stateDirectory: state, machineId: "m1", grantedRoles: ["developer"],
    access: async () => extra.access === "none" ? { mode: "none" as const, kind: "not_granted" as const, reason: "This role has no DeepWiki grant." } : { mode: "agent" as const, target: agent } } };
};
const envelope = (stdout: string) => JSON.parse(stdout) as { ok: boolean; command: string; data: any };
const ASK = ["docs", "ask", "--repo", "facebook/react", "--public", "--question", "useEffect cleanup"];

describe("bflow docs commands against a shared Gateway", () => {
  it("asks about an explicitly named public repository and reports what it used", async () => {
    const context = await docs();
    const result = await runCli([...ASK, "--json"], context);
    expect(result.exitCode).toBe(0);
    const { data } = envelope(result.stdout);
    expect(data).toMatchObject({ docs: true, action: "ask", ok: true, access: { mode: "agent" }, answer: { repoName: "facebook/react", tool: "ask_wiki_question" } });
    expect(data.answer.content).toBe("wiki answer for facebook/react: useEffect cleanup");
    expect(data.metrics).toMatchObject({ lookups: 1, toolCalls: 1 });
    expect(upstream.seen.filter(item => item.method === "initialize")).toHaveLength(1);
    expect(upstream.seen.find(item => item.tool === "ask_wiki_question")?.args).toEqual({ repoName: "facebook/react", question: "useEffect cleanup" });
  });

  it("reads the wiki structure and contents with only the repository name", async () => {
    const context = await docs();
    const structure = await runCli(["docs", "structure", "--repo", "facebook/react", "--public", "--json"], context);
    expect(structure.exitCode).toBe(0);
    expect(envelope(structure.stdout).data.answer).toMatchObject({ tool: "read_wiki_structure", content: STRUCTURE_TEXT });
    const contents = await runCli(["docs", "contents", "--repo", "facebook/react", "--public", "--json"], context);
    expect(envelope(contents.stdout).data.answer).toMatchObject({ tool: "read_wiki_contents" });
    expect(upstream.seen.filter(item => item.tool).map(item => item.args)).toEqual([{ repoName: "facebook/react" }, expect.objectContaining({ repoName: "facebook/react" })]);
  });

  it("exits 1 with a classified failure, and never invents content", async () => {
    const context = await docs();
    upstream.behave({ answerText: () => ({ text: "Repository not found. Visit https://deepwiki.com/x/y to index it.", isError: true }) });
    const missing = await runCli(["docs", "ask", "--repo", "x/y", "--public", "--question", "x", "--json"], context);
    expect(missing.exitCode).toBe(1);
    expect(envelope(missing.stdout).data).toMatchObject({ ok: false, failure: { kind: "library_not_found", stage: "query" } });
    expect(envelope(missing.stdout).data.answer).toBeUndefined();
  });

  it("explains a missing Gateway grant instead of working around it", async () => {
    const result = await runCli([...ASK, "--json"], await docs({ access: "none" }));
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).data).toMatchObject({ ok: false, access: { mode: "none" }, failure: { kind: "permission_denied", stage: "access" } });
    expect(upstream.seen.filter(item => item.tool)).toHaveLength(0);
  });

  it("renders readable output and removes terminal control sequences from retrieved text", async () => {
    upstream.behave({ answerText: () => ({ text: "Safe \u001b[31mred\u001b[0m text\u0007 and a bell" }) });
    const result = await runCli(ASK, await docs());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DeepWiki answer for facebook/react");
    expect(result.stdout).toContain("Source: DeepWiki via the shared Gateway");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u0007");
    expect(result.stdout).toContain("Safe [31mred[0m text and a bell");
    upstream.behave({ answerText: () => ({ text: "Repository not found.", isError: true }) });
    const failure = await runCli(ASK, await docs());
    expect(failure.stdout).toContain("[FAIL] docs ask (query): library_not_found");
  });

  it("keeps no cache and stores no question text on disk", async () => {
    upstream.behave({ answerText: () => ({ text: "static public documentation" }) });
    const context = await docs();
    const first = await runCli(["docs", "ask", "--repo", "facebook/react", "--public", "--question", "secret internal wording", "--json"], context);
    expect(first.exitCode).toBe(0);
    expect(await readdir(state)).not.toContain("docs-cache");
  });

  it("reports status through the same health model as doctor", async () => {
    const context = await docs();
    await writeFile(join(state, "setup-gateway-ready.json"), JSON.stringify({ schemaVersion: 3, definitionDigest: "d", pid: process.pid, endpoint: stack!.endpoint,
      observedAt: new Date().toISOString(), observations: [{ serviceId: DEEPWIKI_ID, status: "ready", discoveredTools: DEEPWIKI_TOOL_NAMES }] }), { mode: 0o600 });
    const result = await runCli(["docs", "status", "--json"], context);
    expect(result.exitCode).toBe(0);
    const { data } = envelope(result.stdout);
    expect(data).toMatchObject({ action: "status", ok: true, health: { state: "healthy", enabled: true, required: false } });
    expect(data.health.checks.map((check: { id: string; status: string }) => `${check.id}:${check.status}`)).toEqual(expect.arrayContaining([
      "gateway:pass", "service:pass", "connection:pass", "discovery:pass", "read_wiki_structure:pass", "quota:pass"]));
    const human = await runCli(["docs", "status"], context);
    expect(human.stdout).toContain("DeepWiki: healthy (optional)");
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
      entries: [{ registrationId: "reg-1", envName: "BFLOW_MCP_TOKEN_REG_1", allowedTools: DEEPWIKI_TOOL_NAMES }], ...overrides }), { mode: 0o600 });
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
    await plan({ entries: [{ registrationId: "reg-1", envName: "BFLOW_MCP_TOKEN_REG_1", allowedTools: ["ask_wiki_question"] }] });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
    await plan({ endpoint: "https://evil.example.com/mcp" });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
    await plan({ entries: [{ registrationId: "reg-1", envName: "NOT_A_TOKEN_NAME", allowedTools: DEEPWIKI_TOOL_NAMES }] });
    expect(await discoverAgentAccess(env, repo)).toBeUndefined();
  });
});

describe("required DeepWiki refusal", () => {
  it("blocks startup only when it is enabled, required and a check fails", async () => {
    const { requiredDeepWikiRefusal } = await import("../src/docs-health.js");
    const failing = [{ id: "service" as const, status: "fail" as const, message: "blocked", remediation: "Run setup." }];
    expect(requiredDeepWikiRefusal({ enabled: true, required: true, checks: failing })).toMatch(/Required DeepWiki documentation service is not ready: blocked.*Run setup\./);
    expect(requiredDeepWikiRefusal({ enabled: true, required: false, checks: failing })).toBeUndefined();
    expect(requiredDeepWikiRefusal({ enabled: false, required: true, checks: failing })).toBeUndefined();
    expect(requiredDeepWikiRefusal({ enabled: true, required: true, checks: [{ id: "gateway" as const, status: "pass" as const, message: "ok" }] })).toBeUndefined();
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

  it("keeps the CLI's DeepWiki identity identical to the tool installer's", async () => {
    const installer = await import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
    const { DEEPWIKI_SERVICE_ID, DEEPWIKI_TOOLS } = await import("../src/deepwiki-constants.js");
    expect(DEEPWIKI_SERVICE_ID).toBe(installer.DEEPWIKI_SERVICE_ID);
    expect([...DEEPWIKI_TOOLS]).toEqual([...installer.DEEPWIKI_TOOLS]);
  });
});
