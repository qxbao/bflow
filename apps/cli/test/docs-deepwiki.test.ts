import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDocsCommand } from "../src/docs-command.js";
import { parseCliArgs } from "../src/index.js";

let repo: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join("/tmp", "bflow-dwdocs-")));
  execFileSync("git", ["init", "--quiet", repo]);
  // The remote names a repository the operator never passed to the command. It must not be read as a lookup target.
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/private-product.git"], { cwd: repo });
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/** A Gateway stand-in that records every JSON-RPC request the docs command makes. */
function fakeGateway(toolResult?: unknown) {
  const requests: Array<{ method: string; params: any }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ method: body.method, params: body.params });
    const headers = { "content-type": "application/json", "mcp-session-id": "session-1" };
    const result = body.method === "tools/call" ? (toolResult ?? { status: "succeeded", output: [{ type: "text", text: "Hooks are scheduled by the reconciler." }] }) : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers });
  }) as typeof fetch;
  return { requests, fetchImpl, calls: () => requests.filter(item => item.method === "tools/call") };
}

const base = { command: "docs" as const, json: true, help: false };
function context(fetchImpl: typeof fetch) {
  return { cwd: repo, docs: { stateDirectory: join(repo, "state"), machineId: "m1", grantedRoles: ["developer"], fetchImpl,
    access: async () => ({ mode: "agent" as const, target: { endpoint: "http://127.0.0.1:1/mcp", token: "agent-token", registrationId: "reg-1" } }) } };
}
const secrets = {
  github: `ghp_${"a".repeat(36)}`, aws: `AKIA${"A".repeat(16)}`, pem: `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
  bearer: `Authorization: Bearer ${"x".repeat(30)}`, legacy: `ctx7sk-${"a".repeat(20)}`, openai: `sk-${"a".repeat(30)}`
};

describe("DeepWiki integration", () => {
  it("docs client refuses private repositories source upload and secrets", async () => {
    // Parsing: the repository is explicit, owner/repo shaped, and declared public. Nothing is inferred.
    const parsed = parseCliArgs(["docs", "ask", "--repo", "facebook/react", "--public", "--question", "How are hooks scheduled?", "--json"]);
    expect(parsed.ok && parsed.value).toMatchObject({ command: "docs", action: "ask", repo: "facebook/react", question: "How are hooks scheduled?", publicRepository: true, json: true });
    expect(parseCliArgs(["docs", "structure", "--repo", "facebook/react", "--public"]).ok).toBe(true);
    expect(parseCliArgs(["docs", "contents", "--repo", "facebook/react", "--public"]).ok).toBe(true);
    const reasons = (...args: string[]) => { const result = parseCliArgs(args); return result.ok ? "accepted" : result.error.message; };
    expect(reasons("docs", "ask", "--public", "--question", "x")).toMatch(/--repo/);
    expect(reasons("docs", "ask", "--repo", "facebook/react", "--question", "x")).toMatch(/--public/);
    expect(reasons("docs", "ask", "--repo", "git@github.com:acme/private-product.git", "--public", "--question", "x")).toMatch(/owner\/repo/);
    expect(reasons("docs", "search", "react")).toMatch(/Unknown subcommand/);
    expect(reasons("docs", "lookup", "react", "--query", "x")).toMatch(/Unknown subcommand/);

    // A public repository named by the operator is asked with exactly repoName and question.
    const allowed = fakeGateway();
    const answered = await executeDocsCommand({ ...base, action: "ask", repo: "facebook/react", question: "How are hooks scheduled?", publicRepository: true }, context(allowed.fetchImpl) as never);
    expect(answered).toMatchObject({ docs: true, action: "ask", ok: true, access: { mode: "agent" }, answer: { repoName: "facebook/react", tool: "ask_wiki_question", content: "Hooks are scheduled by the reconciler." } });
    expect(allowed.calls()).toHaveLength(1);
    expect(allowed.calls()[0]!.params).toMatchObject({ name: "ask_wiki_question", serviceId: "deepwiki", arguments: { repoName: "facebook/react", question: "How are hooks scheduled?" } });
    expect(Object.keys(allowed.calls()[0]!.params.arguments).sort()).toEqual(["question", "repoName"]);

    // The real Gateway replies with the MCP result envelope, not a bare output array.
    const ask1 = (fetchImpl: typeof fetch) => executeDocsCommand({ ...base, action: "ask", repo: "facebook/react", question: "How are hooks scheduled?", publicRepository: true }, context(fetchImpl) as never);
    const envelope = fakeGateway({ content: [{ type: "text", text: "Hooks are scheduled by the reconciler." }], structuredContent: { result: "Hooks are scheduled by the reconciler." } });
    expect(await ask1(envelope.fetchImpl)).toMatchObject({ ok: true, answer: { repoName: "facebook/react", tool: "ask_wiki_question", content: "Hooks are scheduled by the reconciler." } });
    expect(await ask1(fakeGateway({ structuredContent: { result: "Structured answer." } }).fetchImpl)).toMatchObject({ ok: true, answer: { content: "Structured answer." } });
    // Error, isError and unsupported shapes fail closed: no answer text is reported as documentation.
    for (const bad of [
      { content: [{ type: "text", text: "boom" }], isError: true },
      { status: "failed", content: [{ type: "text", text: "boom" }] },
      { error: { message: "boom" } },
      { content: "not-an-array", structuredContent: 42 },
      { unexpected: true }
    ]) {
      const outcome = await ask1(fakeGateway(bad).fetchImpl);
      expect(outcome).toMatchObject({ ok: false });
      expect(JSON.stringify(outcome)).not.toContain("boom");
    }

    // Everything below must be refused locally: not one tools/call reaches the Gateway.
    const blocked = fakeGateway();
    const ask = (overrides: Record<string, unknown>) => executeDocsCommand({ ...base, action: "ask", repo: "facebook/react", question: "How are hooks scheduled?", publicRepository: true, ...overrides } as never, context(blocked.fetchImpl) as never);
    const refusals = [
      await ask({ publicRepository: false }),
      await ask({ publicRepository: undefined }),
      await ask({ repo: undefined }),
      await ask({ repo: "git@github.com:acme/private-product.git" }),
      await ask({ repo: "https://github.com/acme/private-product" }),
      await ask({ repo: "../../etc/passwd" }),
      await ask({ question: `Why does this fail?\n\`\`\`ts\nconst token = load();\nexport default token;\n\`\`\`` }),
      await ask({ question: "explain ".repeat(300) }),
      ...await Promise.all(Object.values(secrets).map(secret => ask({ question: `Why is ${secret} rejected?` })))
    ];
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
      for (const secret of Object.values(secrets)) expect(JSON.stringify(refusal)).not.toContain(secret);
    }
    const structure = await executeDocsCommand({ ...base, action: "structure", repo: "facebook/react", publicRepository: false } as never, context(blocked.fetchImpl) as never);
    expect(structure).toMatchObject({ ok: false, failure: { kind: "invalid_arguments" } });
    expect(blocked.calls()).toEqual([]);
    expect(JSON.stringify(blocked.requests)).not.toMatch(/private-product/);
  });
});
