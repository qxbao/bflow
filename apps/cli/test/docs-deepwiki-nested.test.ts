import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDocsCommand } from "../src/docs-command.js";

let repo: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join("/tmp", "bflow-dwnested-")));
  execFileSync("git", ["init", "--quiet", repo]);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

function gateway(toolResult: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const result = body.method === "tools/call" ? toolResult : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
  }) as typeof fetch;
}
const ask = (fetchImpl: typeof fetch) => executeDocsCommand({ command: "docs", json: true, help: false, action: "ask", repo: "facebook/react", question: "How are hooks scheduled?", publicRepository: true } as never,
  { cwd: repo, docs: { stateDirectory: join(repo, "state"), machineId: "m1", grantedRoles: ["developer"], fetchImpl,
    access: async () => ({ mode: "agent" as const, target: { endpoint: "http://127.0.0.1:1/mcp", token: "t", registrationId: "r" } }) } } as never);

describe("DeepWiki nested Gateway output envelope", () => {
  it("decodes the real {status, output:{content, structuredContent}} shape and fails closed on inner errors", async () => {
    const text = "Hooks are scheduled by the reconciler.";
    expect(await ask(gateway({ status: "completed", output: { content: [{ type: "text", text }], structuredContent: { result: text } } }))).toMatchObject({ ok: true, answer: { content: text } });
    expect(await ask(gateway({ status: "completed", output: { structuredContent: { result: "Structured." } } }))).toMatchObject({ ok: true, answer: { content: "Structured." } });
    for (const bad of [
      { status: "completed", output: { content: [{ type: "text", text: "boom" }], isError: true } },
      { status: "completed", output: { error: { message: "boom" } } },
      { status: "failed", output: { content: [{ type: "text", text: "boom" }] } },
      { status: "completed", output: { unexpected: true } }
    ]) {
      const outcome = await ask(gateway(bad));
      expect(outcome).toMatchObject({ ok: false });
      expect(JSON.stringify(outcome)).not.toContain("boom");
    }
  });
});
