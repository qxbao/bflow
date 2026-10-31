import { describe, expect, it } from "vitest";
import { GatewayDocsCaller, readEvent } from "../src/docs-gateway.js";

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

function stringStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return byteStream(chunks.map((c) => encoder.encode(c)));
}

describe("Slice 1 — docs-gateway SSE framing & structuredContent unwrapping", () => {
  it("parses SSE frames when CRLF delimiters (\\r\\n\\r\\n) split across Uint8Array chunk boundaries", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      result: { content: [{ type: "text", text: "split crlf ok" }] }
    });
    const nextPayload = JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} });
    const raw = `event: message\r\ndata: ${payload}\r\n\r\nevent: message\r\ndata: ${nextPayload}`;
    // Split right between \r and \n inside the \r\n\r\n event boundary so failing to split concatenates two data: lines!
    const splitAt = raw.indexOf("\r\n\r\n") + 3; // "...\r\n\r" | "\nevent: message..."
    const parsed = await readEvent(stringStream(raw.slice(0, splitAt), raw.slice(splitAt)), 11);
    expect(parsed).toMatchObject({
      id: 11,
      result: { content: [{ type: "text", text: "split crlf ok" }] }
    });

    // Also split inside the first \r\n of the data line ("...\r" | "\n\r\n")
    const splitFirst = raw.indexOf("\r\n\r\n") + 1;
    const parsedFirst = await readEvent(stringStream(raw.slice(0, splitFirst), raw.slice(splitFirst)), 11);
    expect(parsedFirst).toMatchObject({ id: 11 });
  });

  it("parses standalone CR (\\r) line endings and flushes multi-byte UTF-8 split across chunks at EOF", async () => {
    const crPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      result: { content: [{ type: "text", text: "standalone CR ok" }] }
    });
    expect(await readEvent(stringStream(`event: message\rdata: ${crPayload}\r\r`), 12)).toMatchObject({
      id: 12
    });

    // 4-byte UTF-8 sequence 🚀 (F0 9F 9A 80) split across two Uint8Array chunks, closing at EOF without trailing blank line
    const utf8Text = `event: message\r\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      result: { content: [{ type: "text", text: "Rocket 🚀 docs" }] }
    })}`;
    const bytes = new TextEncoder().encode(utf8Text);
    const rocketStart = bytes.indexOf(0xf0);
    expect(rocketStart).toBeGreaterThan(0);
    const chunk1 = bytes.slice(0, rocketStart + 2);
    const chunk2 = bytes.slice(rocketStart + 2);
    const utf8Parsed = await readEvent(byteStream([chunk1, chunk2]), 13);
    expect(utf8Parsed).toMatchObject({
      id: 13,
      result: { content: [{ type: "text", text: "Rocket 🚀 docs" }] }
    });
  });

  it("extracts matching JSON-RPC responses from batch array SSE and JSON frames", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 99, result: { ignored: true } },
      { jsonrpc: "2.0", id: 14, result: { content: [{ type: "text", text: "from batch" }] } }
    ]);
    expect(await readEvent(stringStream(`data: ${batch}\n\n`), 14)).toMatchObject({
      id: 14,
      result: { content: [{ type: "text", text: "from batch" }] }
    });

    const caller = new GatewayDocsCaller(
      { endpoint: "http://127.0.0.1:4321/mcp", token: "tok", registrationId: "reg-1" },
      (async (_url: unknown, init?: RequestInit) => {
        const req = JSON.parse(String(init?.body));
        const headers = { "content-type": "application/json", "mcp-session-id": "sess-batch" };
        if (req.method === "initialize") {
          return new Response(JSON.stringify([{ jsonrpc: "2.0", id: req.id, result: {} }]), { status: 200, headers });
        }
        return new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 777, result: {} },
            {
              jsonrpc: "2.0",
              id: req.id,
              result: { status: "completed", output: [{ type: "text", text: "Batch tool answer." }] }
            }
          ]),
          { status: 200, headers }
        );
      }) as typeof fetch
    );
    const out = await caller.callTool("ask_wiki_question", { repoName: "facebook/react", question: "hooks" });
    expect(out).toEqual({ ok: true, isError: false, text: "Batch tool answer." });
  });

  it("unwraps preserveStructuredToolOutput { content, structuredContent } envelopes without stringifying the wrapper", async () => {
    const callWithResult = async (toolResult: unknown) => {
      const caller = new GatewayDocsCaller(
        { endpoint: "http://127.0.0.1:4321/mcp", token: "tok", registrationId: "reg-1" },
        (async (_url: unknown, init?: RequestInit) => {
          const req = JSON.parse(String(init?.body));
          const headers = { "content-type": "application/json", "mcp-session-id": "sess-1" };
          const result = req.method === "tools/call" ? toolResult : {};
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers });
        }) as typeof fetch
      );
      return caller.callTool("ask_wiki_question", { repoName: "facebook/react", question: "hooks" });
    };

    // Empty content array + structuredContent with string field `answer` / `markdown` / `text`
    expect(
      await callWithResult({
        status: "completed",
        output: { content: [], structuredContent: { answer: "Unwrapped structured answer." } }
      })
    ).toEqual({ ok: true, isError: false, text: "Unwrapped structured answer." });

    expect(
      await callWithResult({
        status: "completed",
        output: { structuredContent: { markdown: "# Structured Markdown" } }
      })
    ).toEqual({ ok: true, isError: false, text: "# Structured Markdown" });

    // Empty content array + arbitrary structuredContent object -> serializes structuredContent only, NEVER { content, structuredContent }
    const objectStructured = await callWithResult({
      status: "completed",
      output: { content: [], structuredContent: { sections: ["Intro", "Hooks"] } }
    });
    expect(objectStructured).toEqual({
      ok: true,
      isError: false,
      text: JSON.stringify({ sections: ["Intro", "Hooks"] })
    });
    if (objectStructured.ok) {
      expect(objectStructured.text).not.toContain("structuredContent");
    }

    // Malformed content field still fails closed
    const malformed = await callWithResult({
      status: "completed",
      output: { content: "not-an-array", structuredContent: { result: "should fail" } }
    });
    expect(malformed.ok).toBe(false);
  });
});
