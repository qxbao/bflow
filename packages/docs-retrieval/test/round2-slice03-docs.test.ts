import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_POLICY,
  DocsClient,
  FileDocsCache,
  MemoryDocsCache,
  cacheKey,
  classifyGatewayError,
  type DocsToolCaller
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("Round 2 Slice 03 — Docs Retrieval & Cross-Slice Module Hardening", () => {
  it("R2-D1: DocsClient enforces client-side timeout/abort on hung caller streams, rejects HTML/JSON error pages without caching, and classifies top-level cancelled errors", async () => {
    // 1. Hung caller ignoring options.timeoutMs / options.signal must still time out within client timeoutMs
    const hungCaller: DocsToolCaller = {
      async listTools() {
        return await new Promise(() => {
          // hung discovery stream
        });
      },
      async callTool() {
        return await new Promise(() => {
          // hung body stream
        });
      }
    };
    const hungClient = new DocsClient({ caller: hungCaller, timeoutMs: 65 });
    const t0 = Date.now();
    const hungAsk = await hungClient.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "How does concurrent rendering work?"
    });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(hungAsk).toMatchObject({
      ok: false,
      stage: "query",
      failure: { kind: "timeout", retryable: true }
    });

    const tProbe = Date.now();
    const probeChecks = await hungClient.probe();
    expect(Date.now() - tProbe).toBeLessThan(800);
    expect(probeChecks[0]).toMatchObject({
      name: "discovery",
      status: "failed",
      failure: { kind: "timeout" }
    });

    // >32-bit timeoutMs must not overflow into immediate 1ms timeout
    const fastCaller: DocsToolCaller = {
      async callTool() {
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true, isError: false, text: "# React Docs\nHooks reference." };
      }
    };
    const largeTimeoutRes = await new DocsClient({
      caller: fastCaller,
      timeoutMs: 3_000_000_000
    }).structure({ repoName: "facebook/react", visibility: "public" });
    expect(largeTimeoutRes).toMatchObject({ ok: true, content: "# React Docs\nHooks reference." });

    // 2. HTML error pages (429 / 502 / Cloudflare) & plain JSON {"error": ...} envelopes returned with isError:false must fail closed & NEVER cache
    const cache = new MemoryDocsCache();
    const policy = { ...DEFAULT_CACHE_POLICY, enabled: true };
    let payloadIndex = 0;
    const errorPayloads = [
      "<!DOCTYPE html>\n<html><head><title>429 Too Many Requests</title></head><body>Rate limit exceeded</body></html>",
      "<html><head><title>502 Bad Gateway</title></head><body>nginx/1.25.0</body></html>",
      JSON.stringify({ error: { code: 503, message: "Upstream worker temporarily unavailable" } })
    ];
    const htmlCaller: DocsToolCaller = {
      async callTool() {
        const text = errorPayloads[payloadIndex++] ?? errorPayloads[0]!;
        return { ok: true, isError: false, text };
      }
    };
    const htmlClient = new DocsClient({ caller: htmlCaller, cache, cachePolicy: policy });

    const html429 = await htmlClient.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "What is useActionState?"
    });
    expect(html429).toMatchObject({
      ok: false,
      stage: "query",
      failure: { kind: "rate_limited", retryable: true }
    });

    const html502 = await htmlClient.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "What is useOptimistic?"
    });
    expect(html502).toMatchObject({
      ok: false,
      stage: "query",
      failure: { kind: "unavailable", retryable: true }
    });

    const jsonErr = await htmlClient.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "What is Suspense?"
    });
    expect(jsonErr.ok).toBe(false);
    expect(htmlClient.metrics().cacheStores).toBe(0);
    expect(cache.stats().writes).toBe(0);

    // 3. Top-level error.code === "cancelled" without details.kind maps to "unavailable"
    expect(
      classifyGatewayError({
        code: "cancelled",
        message: "Caller aborted request"
      })
    ).toMatchObject({
      kind: "unavailable",
      message: "The request was cancelled."
    });
  });

  it("R2-D2: DocsCache evicts corrupted NaN expiresAt entries, normalizes libraryId casing, blocks empty/non-positive-TTL poisoning, and sweeps stale .tmp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bflow-r2-docs-cache-"));
    tempDirs.push(dir);
    const cacheDir = join(dir, "cache");
    const fileCache = new FileDocsCache({ directory: cacheDir });
    const memCache = new MemoryDocsCache();

    // 1. Case-insensitive libraryId normalization for cacheKey, get, and invalidate
    const upperKey = { libraryId: "Facebook/React", version: null, query: "hooks?", language: null };
    const lowerKey = { libraryId: "facebook/react", version: null, query: "hooks?", language: null };
    expect(cacheKey(upperKey)).toBe(cacheKey(lowerKey));

    await fileCache.set(upperKey, "# Hooks\nuseState and useEffect", 300);
    expect((await fileCache.get(lowerKey))?.content).toBe("# Hooks\nuseState and useEffect");
    expect(await fileCache.invalidate({ libraryId: "FACEBOOK/REACT" })).toBe(1);
    expect(await fileCache.get(lowerKey)).toBeNull();

    await memCache.set(upperKey, "# Hooks", 300);
    expect((await memCache.get(lowerKey))?.content).toBe("# Hooks");
    expect(await memCache.invalidate({ libraryId: "facebook/react" })).toBe(1);

    // 2. Corrupted expiresAt ("not-an-iso-date" -> NaN) on disk must NOT become an immortal cache hit
    const corruptKey = { libraryId: "vercel/next.js", version: null, query: "routing", language: null };
    await writeFile(
      join(cacheDir, `${cacheKey(corruptKey)}.json`),
      JSON.stringify({
        schemaVersion: 1,
        libraryId: "vercel/next.js",
        version: null,
        language: null,
        content: "stale corrupted entry",
        storedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "corrupted-timestamp"
      }),
      "utf8"
    );
    expect(await fileCache.get(corruptKey)).toBeNull();
    const afterCorruptFiles = await readdir(cacheDir);
    expect(afterCorruptFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // 3. Empty/whitespace content or invalid TTL must never poison cache
    const poisonKey = { libraryId: "vitejs/vite", version: null, query: "plugins", language: null };
    await memCache.set(poisonKey, "   \n\t  ", 300);
    await memCache.set(poisonKey, "valid text", 0);
    await memCache.set(poisonKey, "valid text", Number.NaN);
    expect(await memCache.get(poisonKey)).toBeNull();

    await fileCache.set(poisonKey, "   ", 300);
    await fileCache.set(poisonKey, "valid text", -5);
    expect(await fileCache.get(poisonKey)).toBeNull();

    // 4. Stale orphan *.tmp file left behind by a crashed writer is cleaned up during prune()
    const orphanTmp = join(cacheDir, "orphan.json.99999.deadbeef.tmp");
    await writeFile(orphanTmp, "partial-crash-bytes", "utf8");
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(orphanTmp, oldTime, oldTime);

    await fileCache.set(lowerKey, "# Fresh Docs", 300);
    const remainingFiles = await readdir(cacheDir);
    expect(remainingFiles.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("R2-D3: All 4 Slice 3 packages load cleanly via ESM without circular-import TDZ errors", async () => {
    const [herdrMod, gatewayMod, servicesMod, docsMod] = await Promise.all([
      import("../../herdr-adapter/src/index.js"),
      import("../../mcp-gateway/src/index.js"),
      import("../../mcp-services/src/index.js"),
      import("../src/index.js")
    ]);

    expect(typeof herdrMod.HerdrCliTransport).toBe("function");
    expect(typeof gatewayMod.BflowSharedMCPGateway).toBe("function");
    expect(typeof gatewayMod.DefaultMCPServiceManager).toBe("function");
    expect(typeof gatewayMod.StreamableHttpGatewayServer).toBe("function");
    expect(typeof servicesMod.BackendResourceManager).toBe("function");
    expect(typeof servicesMod.DedicatedBrowserRuntime).toBe("function");
    expect(typeof servicesMod.BflowOSServiceManager).toBe("function");
    expect(typeof docsMod.DocsClient).toBe("function");
    expect(typeof docsMod.FileDocsCache).toBe("function");
  });
});
