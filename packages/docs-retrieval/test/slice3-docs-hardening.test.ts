import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  type DocsTool,
  type DocsToolCaller,
  type ToolCallOutcome
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("Slice 3 Docs Retrieval hardening regressions", () => {
  it("D1: DocsClient unwraps nested MCP/Gateway JSON envelopes and fails closed without caching on inner error/unknown envelopes", async () => {
    const cache = new MemoryDocsCache();
    const policy = { ...DEFAULT_CACHE_POLICY, enabled: true };

    // 1. Nested Gateway MCPToolCallResult envelope with `{ content, structuredContent }`
    const wrappedSuccessCaller: DocsToolCaller = {
      async callTool() {
        return {
          ok: true,
          isError: false,
          text: JSON.stringify({
            schemaVersion: 3,
            callId: "c-1",
            status: "completed",
            output: {
              content: [{ type: "text", text: "# React Fiber\nReconciliation details." }],
              structuredContent: { result: "# React Fiber\nReconciliation details." }
            },
            observedAt: "2026-10-31T00:00:00.000Z"
          })
        };
      }
    };
    const okClient = new DocsClient({ caller: wrappedSuccessCaller, cache, cachePolicy: policy });
    const okRes = await okClient.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "How does Fiber work?"
    });
    expect(okRes).toMatchObject({
      ok: true,
      content: "# React Fiber\nReconciliation details."
    });

    // 2. Inner `{ status: "failed" }` envelope with `outcome.isError: false` must fail closed and NOT cache
    const innerFailedCaller: DocsToolCaller = {
      async callTool() {
        return {
          ok: true,
          isError: false,
          text: JSON.stringify({
            schemaVersion: 3,
            callId: "c-2",
            status: "failed",
            output: [{ type: "text", text: "Repository acme/secret not found" }],
            observedAt: "2026-10-31T00:00:00.000Z"
          })
        };
      }
    };
    const errClient = new DocsClient({ caller: innerFailedCaller, cache, cachePolicy: policy });
    const errRes = await errClient.ask({
      repoName: "acme/secret",
      visibility: "public",
      question: "Architecture?"
    });
    expect(errRes).toMatchObject({
      ok: false,
      stage: "query",
      failure: { kind: "library_not_found" }
    });
    expect(errClient.metrics().cacheStores).toBe(0);

    // 3. Inner MCP `{ isError: true, content: [...] }` envelope must fail closed
    const mcpErrorCaller: DocsToolCaller = {
      async callTool() {
        return {
          ok: true,
          isError: false,
          text: JSON.stringify({
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded (429)" }]
          })
        };
      }
    };
    const rateRes = await new DocsClient({ caller: mcpErrorCaller }).structure({
      repoName: "facebook/react",
      visibility: "public"
    });
    expect(rateRes).toMatchObject({
      ok: false,
      stage: "query",
      failure: { kind: "rate_limited", retryable: true }
    });
  });

  it("D2: DocsClient probe() and ask() interoperate with legacy DeepWiki ask_question tool name, and classifyGatewayError maps auth_missing/auth_rejected", async () => {
    const called: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const legacyCaller: DocsToolCaller = {
      async listTools() {
        return {
          ok: true,
          tools: ["ask_question", "read_wiki_contents", "read_wiki_structure"]
        };
      },
      async callTool(tool: DocsTool, args: Readonly<Record<string, unknown>>): Promise<ToolCallOutcome> {
        called.push({ tool, args: { ...args } });
        if ((tool as string) === "ask_wiki_question") {
          return {
            ok: false,
            error: {
              code: "validation",
              message: "Operation 'ask_wiki_question' is not part of the configured service capability"
            }
          };
        }
        return { ok: true, isError: false, text: "Legacy DeepWiki answer" };
      }
    };

    const client = new DocsClient({ caller: legacyCaller });
    const checks = await client.probe();
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["discovery", "ok"],
      ["read_wiki_structure", "ok"]
    ]);

    const answered = await client.ask({
      repoName: "facebook/react",
      visibility: "public",
      question: "What are hooks?"
    });
    expect(answered).toMatchObject({
      ok: true,
      repoName: "facebook/react",
      tool: "ask_wiki_question",
      content: "Legacy DeepWiki answer"
    });
    expect(called.some((c) => c.tool === "ask_question")).toBe(true);

    // classifyGatewayError maps auth_missing and auth_rejected accurately (non-retryable)
    expect(
      classifyGatewayError({
        code: "validation",
        message: "Credential secret://deepwiki is missing",
        details: { kind: "auth_missing" }
      })
    ).toMatchObject({ kind: "auth_missing", retryable: false });

    expect(
      classifyGatewayError({
        code: "validation",
        message: "Upstream rejected the credential (HTTP 401)",
        details: { kind: "auth_rejected", status: 401 }
      })
    ).toMatchObject({ kind: "auth_invalid", status: 401, retryable: false });
  });

  it("D3: MemoryDocsCache overwrite does not falsely evict other keys; FileDocsCache survives concurrent same-key writes and rejects symlinks", async () => {
    const keyA = { libraryId: "a/one", version: null, query: "q1", language: null };
    const keyB = { libraryId: "b/two", version: null, query: "q2", language: null };

    const mem = new MemoryDocsCache({ maxEntries: 2 });
    await mem.set(keyA, "v1", 60);
    await mem.set(keyB, "v2", 60);
    // Overwriting keyB in a full 2-entry cache must NOT evict keyA!
    await mem.set(keyB, "v2-updated", 60);
    expect((await mem.get(keyA))?.content).toBe("v1");
    expect((await mem.get(keyB))?.content).toBe("v2-updated");
    expect(mem.stats().evictions).toBe(0);

    const dir = await mkdtemp(join(tmpdir(), "bflow-docs-cache-s3-"));
    tempDirs.push(dir);
    const cacheDir = join(dir, "cache");
    const fileCache = new FileDocsCache({ directory: cacheDir });

    // 20 concurrent writes to the exact same cache key must not race on a shared `${pid}.tmp` filename
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => fileCache.set(keyA, `concurrent-doc-${i}`, 60))
    );
    const readBack = await fileCache.get(keyA);
    expect(readBack?.content).toMatch(/^concurrent-doc-\d+$/);

    // Symlink inside cache directory pointing outside must be rejected by lstat()
    const outsidePath = join(dir, "outside.json");
    await writeFile(
      outsidePath,
      JSON.stringify({
        schemaVersion: 1,
        libraryId: "b/two",
        version: null,
        language: null,
        content: "poisoned symlink content",
        storedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }),
      "utf8"
    );
    await symlink(outsidePath, join(cacheDir, `${cacheKey(keyB)}.json`));
    expect(await fileCache.get(keyB)).toBeNull();
  });
});
