import { describe, expect, it } from "vitest";
import * as docs from "../src/index.js";

// Namespace access keeps this file loading before the implementation exists, so an absent export fails an assertion.
const api = docs as Record<string, any>;
type Call = { tool: string; args: Record<string, unknown> };

function caller(answer = "Reconciliation compares fiber trees."): { calls: Call[]; callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>; listTools: () => Promise<unknown> } {
  const calls: Call[] = [];
  return { calls,
    async callTool(tool, args) { calls.push({ tool, args: { ...args } }); return { ok: true, isError: false, text: answer }; },
    async listTools() { return { ok: true, tools: ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"] }; } };
}

describe("DeepWiki integration", () => {
  it("docs client sends repoName and question for a public repository", async () => {
    expect(api.DEEPWIKI_SERVICE).toBe("deepwiki");
    expect([...(api.DEEPWIKI_TOOL_NAMES ?? [])]).toEqual(["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"]);
    expect(typeof api.DocsClient).toBe("function");
    expect(typeof api.DocsClient?.prototype?.ask).toBe("function");

    const scripted = caller();
    const client = new api.DocsClient({ caller: scripted, now: () => new Date("2026-10-30T00:00:00Z") });
    const answered = await client.ask({ repoName: "facebook/react", visibility: "public", question: "How does reconciliation work?" });
    expect(answered).toMatchObject({ ok: true, repoName: "facebook/react", tool: "ask_wiki_question", content: "Reconciliation compares fiber trees.", retrievedAt: "2026-10-30T00:00:00.000Z" });
    // Exactly repoName and question leave the machine: no visibility declaration, project path, version or library id.
    expect(scripted.calls).toEqual([{ tool: "ask_wiki_question", args: { repoName: "facebook/react", question: "How does reconciliation work?" } }]);
    expect(Object.keys(scripted.calls[0]!.args).sort()).toEqual(["question", "repoName"]);

    // The other two tools take the repository name only.
    expect(await client.structure({ repoName: "facebook/react", visibility: "public" })).toMatchObject({ ok: true, tool: "read_wiki_structure" });
    expect(await client.contents({ repoName: "facebook/react", visibility: "public" })).toMatchObject({ ok: true, tool: "read_wiki_contents" });
    expect(scripted.calls.slice(1)).toEqual([{ tool: "read_wiki_structure", args: { repoName: "facebook/react" } }, { tool: "read_wiki_contents", args: { repoName: "facebook/react" } }]);

    // A clear mapping resolves a well-known library name to its public repository; nothing is guessed for other names.
    const mapped = caller();
    expect(await new api.DocsClient({ caller: mapped }).ask({ library: "react", question: "What is a hook?" })).toMatchObject({ ok: true, repoName: "facebook/react" });
    expect(mapped.calls[0]!.args).toEqual({ repoName: "facebook/react", question: "What is a hook?" });
    const unknown = caller();
    expect(await new api.DocsClient({ caller: unknown }).ask({ library: "zzzz-no-such-lib-qq", question: "x" })).toMatchObject({ ok: false, failure: { kind: "library_not_found" } });
    expect(unknown.calls).toEqual([]);

    // The probe reads one public repository's structure after discovery and reports each step.
    const probing = caller("Available pages for facebook/react");
    const checks = await new api.DocsClient({ caller: probing }).probe();
    expect(checks.map((check: { name: string; status: string }) => [check.name, check.status])).toEqual([["discovery", "ok"], ["read_wiki_structure", "ok"]]);
    expect(probing.calls).toEqual([{ tool: "read_wiki_structure", args: { repoName: "facebook/react" } }]);

    // The Context7 resolve/query API is gone from the public surface.
    for (const name of ["parseResolveResult", "selectLibrary", "selectVersion"]) expect(api[name], name).toBeUndefined();
    expect(api.DocsClient?.prototype?.lookup).toBeUndefined();
    expect(api.DocsClient?.prototype?.search).toBeUndefined();
  });
});
