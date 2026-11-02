import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DocsClient, FileDocsCache, MemoryDocsCache, cacheKey, cachePermitted, checkQuestion, checkRepoName, classifyGatewayError, classifyToolError,
  detectInstalledVersion, floorOfRange, resolveRepository, DEFAULT_CACHE_POLICY,
  type DocsTool, type DocsToolCaller, type ToolCallOutcome
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bflow-docs-")); roots.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content); }
  return root;
}

// Inline copies of what the hosted DeepWiki server answers (recorded read_wiki_structure output, shortened). No fixture files are read.
const STRUCTURE = "Available pages for facebook/react:\n\n- 1 React Overview\n  - 1.1 Repository Structure\n- 2 Reconciler\n  - 2.1 Fiber Architecture\n- 3 Glossary";
const NOT_INDEXED = "Repository not found. Visit https://deepwiki.com/acme/unindexed to index it.";

describe("installed version detection", () => {
  it("prefers the lockfile over the declared range", async () => {
    const root = await project({
      "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/react": { version: "18.3.1" } } })
    });
    expect(await detectInstalledVersion(root, "react")).toMatchObject({ dependency: "react", version: "18.3.1", exact: true, range: "^18.2.0", source: "package-lock.json" });
  });

  it("reads pnpm and yarn lockfiles", async () => {
    const pnpm = await project({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^2.0.0\n        version: 2.1.9(@types/node@22.0.0)\n"
    });
    expect(await detectInstalledVersion(pnpm, "vitest")).toMatchObject({ version: "2.1.9", exact: true, source: "pnpm-lock.yaml" });
    const yarn = await project({
      "package.json": JSON.stringify({ dependencies: { lodash: "^4.17.0" } }),
      "yarn.lock": '# yarn lockfile v1\n\nlodash@^4.17.0:\n  version "4.17.21"\n  resolved "https://x"\n'
    });
    expect(await detectInstalledVersion(yarn, "lodash")).toMatchObject({ version: "4.17.21", source: "yarn.lock" });
  });

  it("falls back to the lowest version of a range and says it is not exact", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: { next: "^14.2.1" } }) });
    expect(await detectInstalledVersion(root, "next.js")).toMatchObject({ dependency: "next", version: "14.2.1", exact: false, range: "^14.2.1", source: "package.json" });
  });

  it("detects Python, Go and Cargo dependencies", async () => {
    const py = await project({ "requirements.txt": "Django==4.2.7\nrequests>=2.31\n" });
    expect(await detectInstalledVersion(py, "django")).toMatchObject({ version: "4.2.7", exact: true, ecosystem: "python" });
    const uv = await project({ "uv.lock": '[[package]]\nname = "pydantic-core"\nversion = "2.20.1"\n\n[[package]]\nname = "pydantic"\nversion = "2.8.2"\n' });
    expect(await detectInstalledVersion(uv, "pydantic")).toMatchObject({ version: "2.8.2", source: "uv.lock" });
    const go = await project({ "go.mod": "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n" });
    expect(await detectInstalledVersion(go, "gin")).toMatchObject({ version: "1.9.1", ecosystem: "go" });
    const cargo = await project({ "Cargo.lock": '[[package]]\nname = "serde"\nversion = "1.0.200"\n' });
    expect(await detectInstalledVersion(cargo, "serde")).toMatchObject({ version: "1.0.200", ecosystem: "cargo" });
  });

  it("finds a workspace package's dependency from its own directory and uses the lockfile kept at the workspace root", async () => {
    const root = await project({
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/react": { version: "18.3.1" } } }),
      "apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } })
    });
    expect(await detectInstalledVersion(root, "react", { from: join(root, "apps/web") })).toMatchObject({ version: "18.3.1", exact: true, source: "package-lock.json" });
    expect(await detectInstalledVersion(root, "react")).toBeNull();
    const own = await project({ "package.json": JSON.stringify({ dependencies: { react: "17.0.2" } }), "apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }) });
    expect(await detectInstalledVersion(own, "react", { from: join(own, "apps/web") })).toMatchObject({ version: "18.2.0", exact: false, source: join("apps/web", "package.json") });
    expect(await detectInstalledVersion(own, "react", { from: "/somewhere/else" })).toMatchObject({ version: "17.0.2" });
  });

  it("does not report a transitive copy from a yarn or pnpm lockfile as the project's own version", async () => {
    const yarn = await project({
      "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      "yarn.lock": '# yarn lockfile v1\n\nreact@^16.8.0:\n  version "16.14.0"\n\nreact@^18.2.0:\n  version "18.2.0"\n'
    });
    expect(await detectInstalledVersion(yarn, "react")).toMatchObject({ version: "18.2.0", exact: true, source: "yarn.lock" });
    const ambiguousYarn = await project({
      "package.json": JSON.stringify({ dependencies: { react: "^18.1.0" } }),
      "yarn.lock": '# yarn lockfile v1\n\nreact@^16.8.0:\n  version "16.14.0"\n\nreact@^18.0.0:\n  version "18.2.0"\n'
    });
    expect(await detectInstalledVersion(ambiguousYarn, "react")).toMatchObject({ version: "18.1.0", exact: false, source: "package.json" });
    const pnpm = await project({
      "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '6.0'\npackages:\n  /react@16.14.0:\n    resolution: {}\n  /react@18.2.0:\n    resolution: {}\n"
    });
    expect(await detectInstalledVersion(pnpm, "react")).toMatchObject({ version: "18.2.0", exact: false, source: "package.json" });
  });

  it("returns null when the project does not depend on the library", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: { left: "1.0.0" } }) });
    expect(await detectInstalledVersion(root, "react")).toBeNull();
    expect(await detectInstalledVersion(await project({}), "react")).toBeNull();
  });

  it("refuses ranges it cannot reduce to one version", () => {
    expect(floorOfRange("^18.2.0")).toBe("18.2.0");
    expect(floorOfRange(">=1.2.3 <2")).toBe("1.2.3");
    expect(floorOfRange("1.x || 2.x")).toBeNull();
    expect(floorOfRange("workspace:*")).toBeNull();
    expect(floorOfRange("latest")).toBeNull();
  });
});

// Replaces the Context7 "resolve library id" parsing scenarios: DeepWiki has no resolve step, so the equivalent question is
// which repository a request names. Only an explicit public owner/repo or an exact entry of the built-in mapping resolves.
describe("DeepWiki repository resolution (inline fixtures)", () => {
  it("resolves an explicitly named public repository", () => {
    expect(resolveRepository({ repoName: "facebook/react", visibility: "public" })).toEqual({ status: "resolved", repoName: "facebook/react", source: "explicit" });
    expect(checkRepoName("vercel/next.js")).toEqual({ ok: true });
  });

  it("ignores malformed repository names instead of inventing one", () => {
    for (const repoName of ["nope", "", "https://github.com/facebook/react", "git@github.com:facebook/react.git", "facebook/react.git", "a/b/c", "../etc/passwd", "facebook/.."])
      expect(resolveRepository({ repoName, visibility: "public" })).toMatchObject({ status: "refused" });
    expect(checkRepoName(["facebook/react"])).toMatchObject({ ok: false });
  });

  it("never infers that a repository is public", () => {
    expect(resolveRepository({ repoName: "facebook/react" })).toMatchObject({ status: "refused" });
    expect(resolveRepository({ repoName: "acme/internal-tool", visibility: "private" })).toMatchObject({ status: "refused" });
    expect(resolveRepository({ repoName: "acme/internal-tool", visibility: "PUBLIC" })).toMatchObject({ status: "refused" });
    expect(resolveRepository({ repoName: "acme/internal-tool", visibility: true })).toMatchObject({ status: "refused" });
  });

  it("does not treat the nearest unrelated name as a match for an unknown library", () => {
    expect(resolveRepository({ library: "zzzz-no-such-lib-qq" })).toMatchObject({ status: "no_match" });
    expect(resolveRepository({ library: "reactish" })).toMatchObject({ status: "no_match" });
    expect(resolveRepository({})).toMatchObject({ status: "refused" });
  });

  it("selects the exact-name entry of the clear mapping", () => {
    expect(resolveRepository({ library: "react" })).toEqual({ status: "resolved", repoName: "facebook/react", source: "mapping" });
    expect(resolveRepository({ library: "Next.js" })).toEqual({ status: "resolved", repoName: "vercel/next.js", source: "mapping" });
    expect(resolveRepository({ library: "  REACT " })).toMatchObject({ repoName: "facebook/react" });
  });
});

describe("failure classification", () => {
  it("separates the tool errors the server reports with HTTP 200", () => {
    expect(classifyToolError(NOT_INDEXED)).toMatchObject({ kind: "library_not_found", retryable: false });
    expect(classifyToolError("Input validation error: Invalid arguments for tool ask_wiki_question: repoName: Invalid input")).toMatchObject({ kind: "invalid_arguments" });
    expect(classifyToolError("Rate limit exceeded, retry later")).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(classifyToolError("something else entirely")).toMatchObject({ kind: "upstream_error" });
  });

  it("maps the Gateway driver's structured transport errors", () => {
    const err = (details: Record<string, unknown>, code = "transport_unavailable") => ({ code, message: "m", details });
    expect(classifyGatewayError(err({ kind: "rate_limited", status: 429, retryAfterMs: 5000 }))).toMatchObject({ kind: "rate_limited", retryAfterMs: 5000, status: 429, retryable: true });
    expect(classifyGatewayError(err({ kind: "network" }))).toMatchObject({ kind: "network", retryable: true });
    expect(classifyGatewayError(err({ kind: "timeout" }, "timeout"))).toMatchObject({ kind: "timeout" });
    expect(classifyGatewayError({ code: "validation", message: "Requested tools are not offered by the configured services" })).toMatchObject({ kind: "permission_denied" });
    expect(classifyGatewayError({ code: "transport_unavailable", message: "down" })).toMatchObject({ kind: "unavailable" });
  });
});

describe("documentation cache", () => {
  const parts = { libraryId: "a/b", version: "v1.0.0", query: "How do I X?", language: null };

  it("keys on library, version, query and language, and never stores the query", async () => {
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, version: "v2.0.0" }));
    expect(cacheKey(parts)).not.toBe(cacheKey({ ...parts, language: "go" }));
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts, query: "  How do I X?  " }));
    const directory = await mkdtemp(join(tmpdir(), "bflow-doc-cache-")); roots.push(directory);
    const cache = new FileDocsCache({ directory: join(directory, "cache") });
    await cache.set(parts, "public docs text", 60);
    const files = await readdir(join(directory, "cache"));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(directory, "cache", files[0]!), "utf8");
    expect(raw).not.toContain("How do I X?");
    expect((await stat(join(directory, "cache", files[0]!))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "cache"))).mode & 0o777).toBe(0o700);
    expect((await cache.get(parts))?.content).toBe("public docs text");
  });

  it("expires entries, counts hits and misses, and invalidates by library or entirely", async () => {
    let now = 1_000_000;
    const memory = new MemoryDocsCache({ now: () => now });
    await memory.set(parts, "x", 10);
    expect((await memory.get(parts))?.content).toBe("x");
    now += 11_000;
    expect(await memory.get(parts)).toBeNull();
    expect(memory.stats()).toMatchObject({ hits: 1, misses: 1, expired: 1, writes: 1 });
    await memory.set(parts, "x", 10); await memory.set({ ...parts, libraryId: "c/d" }, "y", 10);
    expect(await memory.invalidate({ libraryId: "a/b" })).toBe(1);
    expect(await memory.invalidate()).toBe(1);
    const directory = await mkdtemp(join(tmpdir(), "bflow-doc-cache-")); roots.push(directory);
    const file = new FileDocsCache({ directory, now: () => now });
    await file.set(parts, "x", 10); await file.set({ ...parts, libraryId: "c/d" }, "y", 10);
    expect(await file.invalidate({ libraryId: "c/d" })).toBe(1);
    now += 11_000;
    expect(await file.get(parts)).toBeNull();
    expect(file.stats().expired).toBe(1);
  });

  it("evicts the oldest entries beyond the limit and treats damaged files as misses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bflow-doc-cache-")); roots.push(directory);
    const cache = new FileDocsCache({ directory, maxEntries: 2 });
    for (const library of ["a/1", "a/2", "a/3"]) { await cache.set({ ...parts, libraryId: library }, "d", 60); await new Promise(resolve => setTimeout(resolve, 15)); }
    expect((await readdir(directory)).filter(name => name.endsWith(".json"))).toHaveLength(2);
    expect(cache.stats().evictions).toBe(1);
    await writeFile(join(directory, `${cacheKey({ ...parts, libraryId: "a/3" })}.json`), "{broken");
    expect(await cache.get({ ...parts, libraryId: "a/3" })).toBeNull();
  });

  it("keeps the cache policy gate for authenticated upstreams", () => {
    const on = { ...DEFAULT_CACHE_POLICY, enabled: true };
    expect(cachePermitted(DEFAULT_CACHE_POLICY, false)).toBe(false);
    expect(cachePermitted(on, false)).toBe(true);
    expect(cachePermitted(on, true)).toBe(false);
    expect(cachePermitted({ ...on, allowAuthenticated: true }, true)).toBe(true);
  });
});

// --- Client behavior against a scripted caller -------------------------------------------------------------------

type Script = (tool: DocsTool, args: Record<string, unknown>) => ToolCallOutcome | Promise<ToolCallOutcome>;
const ALL_TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
function scripted(script: Script, tools: readonly string[] = ALL_TOOLS): DocsToolCaller & { calls: Array<{ tool: DocsTool; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: DocsTool; args: Record<string, unknown> }> = [];
  return { calls, async callTool(tool, args) { const copy = { ...args }; calls.push({ tool, args: copy }); return script(tool, copy); },
    async listTools() { return { ok: true as const, tools }; } };
}
const text = (value: string): ToolCallOutcome => ({ ok: true, isError: false, text: value });
const toolError = (value: string): ToolCallOutcome => ({ ok: true, isError: true, text: value });
const PUBLIC = "public";

describe("DocsClient", () => {
  it("asks a question about a public repository and records what was used", async () => {
    const caller = scripted(() => text("useEffect cleanup runs before the next effect."));
    const client = new DocsClient({ caller, now: () => new Date("2026-10-19T00:00:00Z") });
    const result = await client.ask({ repoName: "facebook/react", visibility: PUBLIC, question: "How does useEffect cleanup work?" });
    expect(result).toMatchObject({ ok: true, repoName: "facebook/react", tool: "ask_wiki_question", retrievedAt: "2026-10-19T00:00:00.000Z", content: "useEffect cleanup runs before the next effect." });
    expect(caller.calls).toEqual([{ tool: "ask_wiki_question", args: { repoName: "facebook/react", question: "How does useEffect cleanup work?" } }]);
  });

  it("resolves a library name through the clear mapping and never forwards the visibility declaration", async () => {
    const caller = scripted(() => text("docs"));
    const result = await new DocsClient({ caller }).ask({ library: "next.js", question: "routing" });
    expect(result).toMatchObject({ ok: true, repoName: "vercel/next.js" });
    expect(caller.calls[0]!.args).toEqual({ repoName: "vercel/next.js", question: "routing" });
    expect(JSON.stringify(caller.calls)).not.toContain("visibility");
  });

  it("reports an unknown library instead of answering from unrelated results", async () => {
    const caller = scripted(() => text(STRUCTURE));
    const result = await new DocsClient({ caller }).ask({ library: "zzzz-no-such-lib-qq", question: "x" });
    expect(result).toMatchObject({ ok: false, stage: "validate", failure: { kind: "library_not_found" } });
    expect(caller.calls).toHaveLength(0);
  });

  it("reads the wiki structure and contents with only the repository name", async () => {
    const caller = scripted(tool => text(tool === "read_wiki_structure" ? STRUCTURE : "full wiki"));
    const client = new DocsClient({ caller });
    expect(await client.structure({ repoName: "facebook/react", visibility: PUBLIC })).toMatchObject({ ok: true, tool: "read_wiki_structure", content: STRUCTURE });
    expect(await client.contents({ repoName: "facebook/react", visibility: PUBLIC })).toMatchObject({ ok: true, tool: "read_wiki_contents", content: "full wiki" });
    expect(caller.calls.map(call => call.args)).toEqual([{ repoName: "facebook/react" }, { repoName: "facebook/react" }]);
  });

  it("returns typed failures for an unindexed repository, rate limit, network and empty documentation", async () => {
    const run = async (outcome: ToolCallOutcome) => new DocsClient({ caller: scripted(() => outcome) }).ask({ repoName: "acme/unindexed", visibility: PUBLIC, question: "x" });
    expect(await run(toolError(NOT_INDEXED))).toMatchObject({ ok: false, stage: "query", failure: { kind: "library_not_found" } });
    expect(await run({ ok: false, error: { code: "transport_unavailable", message: "m", details: { kind: "rate_limited", status: 429, retryAfterMs: 3000 } } }))
      .toMatchObject({ ok: false, failure: { kind: "rate_limited", retryAfterMs: 3000, retryable: true } });
    expect(await run({ ok: false, error: { code: "transport_unavailable", message: "m", details: { kind: "network" } } })).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(await run(text("   "))).toMatchObject({ ok: false, failure: { kind: "no_documentation" } });
  });

  it("validates its inputs before calling anything", async () => {
    const caller = scripted(() => text("x"));
    const client = new DocsClient({ caller });
    expect(await client.ask({ repoName: "facebook/react", visibility: PUBLIC, question: "  " })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(await client.ask({ question: "x" })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(await client.ask({ repoName: "facebook/react", question: "x" })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(await client.ask({ repoName: "facebook/react", visibility: PUBLIC, question: "token ghp_" + "a".repeat(36) })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(checkQuestion("x".repeat(5000))).toMatchObject({ ok: false });
    expect(caller.calls).toHaveLength(0);
    expect(client.metrics().refused).toBe(4);
  });

  it("serves a repeated question from the cache and counts it", async () => {
    const caller = scripted(() => text("cached documentation"));
    const client = new DocsClient({ caller, cache: new MemoryDocsCache(), cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    const input = { repoName: "a/b", visibility: PUBLIC, question: "x" };
    const first = await client.ask(input);
    const second = await client.ask(input);
    expect(first).toMatchObject({ ok: true, cache: { hit: false, stored: true } });
    expect(second).toMatchObject({ ok: true, cache: { hit: true, stored: false }, content: "cached documentation" });
    expect(caller.calls).toHaveLength(1);
    expect(client.metrics()).toMatchObject({ lookups: 2, cacheHits: 1, cacheMisses: 1, cacheStores: 1, toolCalls: 1 });
    expect(await client.ask({ ...input, noCache: true })).toMatchObject({ ok: true, cache: { hit: false, stored: false } });
  });

  it("never caches errors", async () => {
    const cache = new MemoryDocsCache();
    const failing = new DocsClient({ caller: scripted(() => toolError(NOT_INDEXED)), cache, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    await failing.ask({ repoName: "a/b", visibility: PUBLIC, question: "x" });
    expect(cache.stats().writes).toBe(0);
  });

  describe("probe", () => {
    it("is ok only when discovery and the read-only call work", async () => {
      const checks = await new DocsClient({ caller: scripted(() => text(STRUCTURE)) }).probe();
      expect(checks.map(check => [check.name, check.status])).toEqual([["discovery", "ok"], ["read_wiki_structure", "ok"]]);
    });
    it("does not call the tools when discovery shows them missing, and keeps each failure distinct", async () => {
      const missing: DocsToolCaller = { async callTool() { throw new Error("must not be called"); }, async listTools() { return { ok: true as const, tools: ["ask_wiki_question"] }; } };
      const first = await new DocsClient({ caller: missing }).probe();
      expect(first[0]).toMatchObject({ name: "discovery", status: "failed", failure: { kind: "protocol" } });
      expect(first.slice(1).every(check => check.status === "skipped")).toBe(true);
      const failed = await new DocsClient({ caller: scripted(() => toolError("Rate limit exceeded")) }).probe();
      expect(failed.find(check => check.name === "read_wiki_structure")).toMatchObject({ status: "failed", failure: { kind: "rate_limited" } });
    });
  });
});
