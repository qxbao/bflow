import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DocsClient, FileDocsCache, MemoryDocsCache, cacheKey, cachePermitted, classifyGatewayError, classifyToolError, detectInstalledVersion,
  floorOfRange, parseResolveResult, selectLibrary, selectVersion, DEFAULT_CACHE_POLICY,
  type DocsTool, type DocsToolCaller, type ToolCallOutcome
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFile(join(here, "fixtures", name), "utf8");
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bflow-docs-")); roots.push(root);
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content); }
  return root;
}

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

describe("Context7 result parsing (captured from the hosted server)", () => {
  it("parses candidates with ids, scores and versions", async () => {
    const candidates = parseResolveResult(await fixture("resolve-react.txt"));
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const reactPackage = candidates.find(candidate => candidate.id === "/react/react");
    expect(reactPackage).toMatchObject({ title: "React", reputation: "High" });
    expect(reactPackage?.versions).toContain("v18.2.0");
    expect(candidates.find(candidate => candidate.id === "/reactjs/react.dev")?.versions).toEqual(["__branch__v18"]);
    expect(candidates.every(candidate => /^\/[^/]+\/.+/.test(candidate.id))).toBe(true);
  });

  it("ignores blocks without an id instead of inventing one", () => {
    expect(parseResolveResult("Available Libraries:\n\n- Title: Broken\n----------\n- Context7-compatible library ID: nope\n")).toEqual([]);
    expect(parseResolveResult("")).toEqual([]);
  });

  it("does not treat the nearest unrelated results as a match for an unknown library", async () => {
    const candidates = parseResolveResult(await fixture("resolve-unknown.txt"));
    expect(candidates.length).toBeGreaterThan(0);
    expect(selectLibrary(candidates, "zzzz-no-such-lib-qq")).toMatchObject({ status: "no_match" });
  });

  it("selects the exact-name library and prefers one that offers the project's version", async () => {
    const react = parseResolveResult(await fixture("resolve-react.txt"));
    const best = Math.max(...react.filter(candidate => candidate.title === "React").map(candidate => candidate.benchmarkScore ?? 0));
    expect(selectLibrary(react, "react").library?.benchmarkScore).toBe(best);
    expect(selectLibrary(react, "react", "18.2.0").library?.id).toBe("/react/react");
    const next = parseResolveResult(await fixture("resolve-nextjs.txt"));
    expect(selectLibrary(next, "next.js", "15.1.8").library?.id).toBe("/vercel/next.js");
  });
});

describe("version selection", () => {
  const library = { id: "/vercel/next.js", versions: ["v14.3.0-canary.87", "v13.5.11", "v15.1.8", "v12.3.7", "v16.0.3", "__branch__x", "v15.4.0-canary.82", "v16.1.0"] };
  it("uses the exact version when it is offered", () => {
    expect(selectVersion(library, "15.1.8")).toMatchObject({ libraryId: "/vercel/next.js/v15.1.8", versionUsed: "v15.1.8", match: "exact" });
    expect(selectVersion(library, "v16.0.3")).toMatchObject({ match: "exact" });
  });
  it("never moves to a newer release than the project uses", () => {
    expect(selectVersion(library, "15.1.9")).toMatchObject({ versionUsed: "v15.1.8", match: "minor" });
    expect(selectVersion(library, "15.3.0")).toMatchObject({ versionUsed: "v15.1.8", match: "major" });
    expect(selectVersion(library, "11.0.0")).toMatchObject({ versionUsed: null, match: "none", libraryId: "/vercel/next.js" });
    expect(selectVersion(library, "11.0.0").availableVersions).toContain("v16.1.0");
  });
  it("ignores prereleases and branches, and handles a request without a version", () => {
    expect(selectVersion({ id: "/a/b", versions: ["v2.0.0-canary.1", "__branch__main"] }, "2.0.0")).toMatchObject({ match: "none" });
    expect(selectVersion(library, null)).toMatchObject({ match: "unrequested", libraryId: "/vercel/next.js", versionUsed: null });
    expect(selectVersion(library, "banana")).toMatchObject({ match: "none" });
  });
});

describe("failure classification", () => {
  it("separates the tool errors the server reports with HTTP 200", () => {
    expect(classifyToolError("Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.")).toMatchObject({ kind: "auth_invalid", retryable: false });
    expect(classifyToolError('Version "v1.0.0" not found for library "/react/react". Available versions: v19.2.7, v18.2.0, v19.2.8'))
      .toMatchObject({ kind: "version_not_found", libraryId: "/react/react", availableVersions: ["v19.2.7", "v18.2.0", "v19.2.8"] });
    expect(classifyToolError('Library "/nobody/nothing-xyz" not found. Please check the library ID or your access permissions.')).toMatchObject({ kind: "library_not_found" });
    expect(classifyToolError("Input validation error: Invalid arguments for tool query-docs: libraryId: Invalid input")).toMatchObject({ kind: "invalid_arguments" });
    expect(classifyToolError("Rate limit exceeded, retry later")).toMatchObject({ kind: "rate_limited", retryable: true });
    expect(classifyToolError("something else entirely")).toMatchObject({ kind: "upstream_error" });
  });

  it("maps the Gateway driver's structured transport errors", () => {
    const err = (details: Record<string, unknown>, code = "transport_unavailable") => ({ code, message: "m", details });
    expect(classifyGatewayError(err({ kind: "rate_limited", status: 429, retryAfterMs: 5000 }))).toMatchObject({ kind: "rate_limited", retryAfterMs: 5000, status: 429, retryable: true });
    expect(classifyGatewayError(err({ kind: "auth_rejected", status: 401 }, "validation"))).toMatchObject({ kind: "auth_invalid", retryable: false });
    expect(classifyGatewayError(err({ kind: "auth_missing" }, "validation"))).toMatchObject({ kind: "auth_missing" });
    expect(classifyGatewayError(err({ kind: "network" }))).toMatchObject({ kind: "network", retryable: true });
    expect(classifyGatewayError(err({ kind: "timeout" }, "timeout"))).toMatchObject({ kind: "timeout" });
    expect(classifyGatewayError({ code: "validation", message: "Requested tools are not offered by the configured services" })).toMatchObject({ kind: "permission_denied" });
    expect(classifyGatewayError({ code: "transport_unavailable", message: "down" })).toMatchObject({ kind: "unavailable" });
  });
});

describe("documentation cache", () => {
  const parts = { libraryId: "/a/b", version: "v1.0.0", query: "How do I X?", language: null };

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
    await memory.set(parts, "x", 10); await memory.set({ ...parts, libraryId: "/c/d" }, "y", 10);
    expect(await memory.invalidate({ libraryId: "/a/b" })).toBe(1);
    expect(await memory.invalidate()).toBe(1);
    const directory = await mkdtemp(join(tmpdir(), "bflow-doc-cache-")); roots.push(directory);
    const file = new FileDocsCache({ directory, now: () => now });
    await file.set(parts, "x", 10); await file.set({ ...parts, libraryId: "/c/d" }, "y", 10);
    expect(await file.invalidate({ libraryId: "/c/d" })).toBe(1);
    now += 11_000;
    expect(await file.get(parts)).toBeNull();
    expect(file.stats().expired).toBe(1);
  });

  it("evicts the oldest entries beyond the limit and treats damaged files as misses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bflow-doc-cache-")); roots.push(directory);
    const cache = new FileDocsCache({ directory, maxEntries: 2 });
    for (const library of ["/a/1", "/a/2", "/a/3"]) { await cache.set({ ...parts, libraryId: library }, "d", 60); await new Promise(resolve => setTimeout(resolve, 15)); }
    expect((await readdir(directory)).filter(name => name.endsWith(".json"))).toHaveLength(2);
    expect(cache.stats().evictions).toBe(1);
    await writeFile(join(directory, `${cacheKey({ ...parts, libraryId: "/a/3" })}.json`), "{broken");
    expect(await cache.get({ ...parts, libraryId: "/a/3" })).toBeNull();
  });

  it("does not cache authenticated answers unless the operator opts in", () => {
    const on = { ...DEFAULT_CACHE_POLICY, enabled: true };
    expect(cachePermitted(DEFAULT_CACHE_POLICY, false)).toBe(false);
    expect(cachePermitted(on, false)).toBe(true);
    expect(cachePermitted(on, true)).toBe(false);
    expect(cachePermitted({ ...on, allowAuthenticated: true }, true)).toBe(true);
  });
});

// --- Client behavior against a scripted caller -------------------------------------------------------------------

type Script = (tool: DocsTool, args: Record<string, unknown>) => ToolCallOutcome | Promise<ToolCallOutcome>;
function scripted(script: Script): DocsToolCaller & { calls: Array<{ tool: DocsTool; args: Record<string, unknown> }> } {
  const calls: Array<{ tool: DocsTool; args: Record<string, unknown> }> = [];
  return { calls, async callTool(tool, args) { const copy = { ...args }; calls.push({ tool, args: copy }); return script(tool, copy); },
    async listTools() { return { ok: true as const, tools: ["resolve-library-id", "query-docs"] }; } };
}
const text = (value: string): ToolCallOutcome => ({ ok: true, isError: false, text: value });
const toolError = (value: string): ToolCallOutcome => ({ ok: true, isError: true, text: value });

describe("DocsClient", () => {
  it("resolves, selects the installed version, queries and records the version used", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }), "package-lock.json": JSON.stringify({ packages: { "node_modules/react": { version: "18.2.0" } } }) });
    const resolve = await fixture("resolve-react.txt");
    const caller = scripted(tool => tool === "resolve-library-id" ? text(resolve) : text("### useEffect docs for 18.2.0"));
    const client = new DocsClient({ caller, now: () => new Date("2026-10-19T00:00:00Z") });
    const result = await client.lookup({ library: "react", query: "useEffect cleanup", projectRoot: root, language: "javascript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ libraryId: "/react/react/v18.2.0", requestedVersion: "18.2.0", versionUsed: "v18.2.0", versionSource: "installed", versionMatch: "exact",
      retrievedAt: "2026-10-19T00:00:00.000Z", cache: { hit: false, stored: false } });
    expect(result.installed).toMatchObject({ source: "package-lock.json" });
    expect(caller.calls.map(call => call.tool)).toEqual(["resolve-library-id", "query-docs"]);
    expect(caller.calls[1]!.args).toEqual({ libraryId: "/react/react/v18.2.0", query: "useEffect cleanup", language: "javascript" });
  });

  it("does not silently use a newer version when the project's is not offered, and says so", async () => {
    const resolve = await fixture("resolve-nextjs.txt");
    const caller = scripted(tool => tool === "resolve-library-id" ? text(resolve) : text("docs"));
    const client = new DocsClient({ caller });
    const result = await client.lookup({ library: "next.js", query: "routing", version: "11.0.0" });
    expect(result).toMatchObject({ ok: true, versionUsed: null, versionMatch: "none", versionSource: "explicit" });
    if (result.ok) expect(result.warnings.join(" ")).toContain("No documentation matches version 11.0.0");
  });

  it("reports an unknown library instead of answering from unrelated results", async () => {
    const caller = scripted(async () => text(await fixture("resolve-unknown.txt")));
    const result = await new DocsClient({ caller }).lookup({ library: "zzzz-no-such-lib-qq", query: "x" });
    expect(result).toMatchObject({ ok: false, stage: "resolve", failure: { kind: "library_not_found" } });
    expect(caller.calls.map(call => call.tool)).toEqual(["resolve-library-id"]);
  });

  it("retries once with the server's spelling when a version id is rejected", async () => {
    const caller = scripted((tool, args) => {
      if (tool === "query-docs" && args["libraryId"] === "/org/lib/1.2.0") return toolError('Version "1.2.0" not found for library "/org/lib". Available versions: v1.2.0, v1.1.0');
      return text("docs");
    });
    const result = await new DocsClient({ caller }).lookup({ libraryId: "/org/lib", query: "x", version: "1.2.0" });
    expect(result).toMatchObject({ ok: true, libraryId: "/org/lib/v1.2.0", versionUsed: "v1.2.0" });
    expect(caller.calls.map(call => call.args["libraryId"])).toEqual(["/org/lib/1.2.0", "/org/lib/v1.2.0"]);
  });

  it("returns typed failures for auth, rate limit, network and empty documentation", async () => {
    const run = async (outcome: ToolCallOutcome) => new DocsClient({ caller: scripted(() => outcome) }).lookup({ libraryId: "/a/b", query: "x" });
    expect(await run(toolError("Invalid API key. Please check your API key."))).toMatchObject({ ok: false, failure: { kind: "auth_invalid" } });
    expect(await run({ ok: false, error: { code: "transport_unavailable", message: "m", details: { kind: "rate_limited", status: 429, retryAfterMs: 3000 } } }))
      .toMatchObject({ ok: false, failure: { kind: "rate_limited", retryAfterMs: 3000, retryable: true } });
    expect(await run({ ok: false, error: { code: "transport_unavailable", message: "m", details: { kind: "network" } } })).toMatchObject({ ok: false, failure: { kind: "network" } });
    expect(await run(text("   "))).toMatchObject({ ok: false, failure: { kind: "no_documentation" } });
  });

  it("validates its inputs before calling anything", async () => {
    const caller = scripted(() => text("x"));
    const client = new DocsClient({ caller });
    expect(await client.lookup({ library: "react", query: "  " })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(await client.lookup({ query: "x" })).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(caller.calls).toHaveLength(0);
  });

  it("serves a repeated lookup from the cache and counts it", async () => {
    const caller = scripted(() => text("cached documentation"));
    const client = new DocsClient({ caller, cache: new MemoryDocsCache(), cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    const first = await client.lookup({ libraryId: "/a/b", query: "x" });
    const second = await client.lookup({ libraryId: "/a/b", query: "x" });
    expect(first).toMatchObject({ ok: true, cache: { hit: false, stored: true } });
    expect(second).toMatchObject({ ok: true, cache: { hit: true, stored: false }, content: "cached documentation" });
    expect(caller.calls.filter(call => call.tool === "query-docs")).toHaveLength(1);
    expect(client.metrics()).toMatchObject({ lookups: 2, cacheHits: 1, cacheMisses: 1, cacheStores: 1, queryCalls: 1 });
    const bypass = await client.lookup({ libraryId: "/a/b", query: "x", noCache: true });
    expect(bypass).toMatchObject({ ok: true, cache: { hit: false, stored: false } });
  });

  it("never caches errors and skips the cache when the policy forbids authenticated answers", async () => {
    const cache = new MemoryDocsCache();
    const failing = new DocsClient({ caller: scripted(() => toolError("Library \"/a/b\" not found.")), cache, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    await failing.lookup({ libraryId: "/a/b", query: "x" });
    expect(cache.stats().writes).toBe(0);
    const authenticated = new DocsClient({ caller: scripted(() => text("private docs")), cache, authenticated: true, cachePolicy: { ...DEFAULT_CACHE_POLICY, enabled: true } });
    expect(await authenticated.lookup({ libraryId: "/a/b", query: "x" })).toMatchObject({ ok: true, cache: { stored: false } });
    expect(cache.stats().writes).toBe(0);
    expect(authenticated.metrics().cacheSkippedByPolicy).toBe(1);
  });

  it("search lists candidates and the version choice for the project", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: { react: "18.2.0" } }) });
    const caller = scripted(async () => text(await fixture("resolve-react.txt")));
    const result = await new DocsClient({ caller }).search({ library: "react", projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toBe("selected");
    expect(result.selected?.id).toBe("/react/react");
    expect(result.version).toMatchObject({ libraryId: "/react/react/v18.2.0", match: "exact" });
    expect(result.installed).toMatchObject({ version: "18.2.0" });
  });

  describe("probe", () => {
    it("is ok only when discovery and both tools work", async () => {
      const resolve = await fixture("resolve-react.txt");
      const checks = await new DocsClient({ caller: scripted(tool => tool === "resolve-library-id" ? text(resolve) : text("docs")) }).probe();
      expect(checks.map(check => [check.name, check.status])).toEqual([["discovery", "ok"], ["resolve-library-id", "ok"], ["query-docs", "ok"]]);
    });
    it("does not call the tools when discovery shows them missing, and keeps each failure distinct", async () => {
      const missing: DocsToolCaller = { async callTool() { throw new Error("must not be called"); }, async listTools() { return { ok: true as const, tools: ["resolve-library-id"] }; } };
      const first = await new DocsClient({ caller: missing }).probe();
      expect(first[0]).toMatchObject({ name: "discovery", status: "failed", failure: { kind: "protocol" } });
      expect(first.slice(1).every(check => check.status === "skipped")).toBe(true);
      const unauthorized = await new DocsClient({ caller: scripted(() => toolError("Invalid API key.")) }).probe();
      expect(unauthorized.find(check => check.name === "resolve-library-id")).toMatchObject({ status: "failed", failure: { kind: "auth_invalid" } });
      expect(unauthorized.find(check => check.name === "query-docs")?.status).toBe("skipped");
    });
  });
});
