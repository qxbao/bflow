// W09 fault/security acceptance against the actual built `bflow web` process (no host/provider).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebApiErrorSchema, WebOperationSchema, WebProjectSchema } from "@bflow/contracts/web";
import { freePort, http, pair, removeScratch, scratchRepository, startWeb, bootstrapSecret, type Paired, type WebProcess } from "./fixtures/web-process.js";

let env: Awaited<ReturnType<typeof scratchRepository>>, web: WebProcess, port: number, session: Paired, projectId: string;
beforeAll(async () => {
  env = await scratchRepository("bflow-w09-faults-");
  port = await freePort();
  web = await startWeb(env.home, port);
  session = await pair(web.origin, web.pairing);
  const created = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: { apiVersion: 1, path: env.repository } });
  projectId = WebProjectSchema.parse(created.json).projectId;
});
afterAll(async () => { await web?.stop("SIGINT"); if (env) await removeScratch(env.scratch); });

describe("AC09 Origin/Host/CSRF at the real HTTP boundary", () => {
  it("rejects DNS-rebinding Host values, cross-site metadata and null/foreign Origin even with a valid cookie", async () => {
    const authenticated = { cookie: session.cookie };
    for (const headers of [
      { ...authenticated, host: `rebind.attacker.test:${port}` },
      { ...authenticated, host: `localhost:${port}` },
      { ...authenticated, host: `127.0.0.1:${port + 1}` },
      { ...authenticated, origin: "null" },
      { ...authenticated, origin: `http://localhost:${port}` },
      { ...authenticated, "sec-fetch-site": "cross-site" },
      { ...authenticated, "sec-fetch-site": "same-site" }
    ]) {
      const result = await http(web.origin, "/api/v1/projects", { headers });
      expect(result.status, JSON.stringify(headers)).toBe(403);
      expect(WebApiErrorSchema.parse(result.json).code).toBe("forbidden");
      expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    }
    // SSE and artifact reads without a session never stream.
    expect((await http(web.origin, `/api/v1/projects/${projectId}/events`)).status).toBe(401);
    expect((await http(web.origin, `/api/v1/projects/${projectId}/artifacts/a1`)).status).toBe(401);
  });

  it("mutations need exact Origin plus the session CSRF token; no mutation through GET", async () => {
    const body = { apiVersion: 1, path: env.repository };
    for (const headers of [
      { cookie: session.cookie, origin: web.origin },
      { cookie: session.cookie, origin: web.origin, "x-bflow-csrf": "forged" },
      { cookie: session.cookie, "x-bflow-csrf": session.csrf },
      { cookie: session.cookie, origin: "http://evil.test", "x-bflow-csrf": session.csrf }
    ]) expect((await http(web.origin, "/api/v1/projects", { method: "POST", headers, body })).status).toBe(403);
    const operationId = randomUUID();
    expect((await http(web.origin, `/api/v1/projects/${projectId}/session/start?operationId=${operationId}`, { headers: { cookie: session.cookie } })).status).toBe(404);
    expect((await http(web.origin, `/api/v1/projects/${projectId}/operations/${operationId}`, { headers: { cookie: session.cookie } })).status).not.toBe(200);
  });

  it("rejects unknown fields, foreign project scope, traversal and oversized bodies", async () => {
    const unknown = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: { apiVersion: 1, path: env.repository, authenticatedUser: "root" } });
    expect(unknown.status).toBe(400);
    const command = { apiVersion: 1, commandId: randomUUID(), projectId: "project-00000000000000000000000000000000", kind: "cancel", runId: "run-1",
      expectedVersion: { revisionToken: "v1" }, reason: "foreign" };
    expect((await http(web.origin, `/api/v1/projects/${projectId}/commands`, { method: "POST", headers: session.headers, body: command })).status).toBe(403);
    expect((await http(web.origin, `/api/v1/projects/${command.projectId}/runs`, { headers: { cookie: session.cookie } })).status).toBe(404);
    for (const path of ["/api/v1/projects/..%2f..%2fetc/runs", "/assets/..%2f..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const result = await http(web.origin, path, { headers: { cookie: session.cookie } });
      expect(result.status, path).toBeGreaterThanOrEqual(400);
      expect(result.text).not.toContain("root:");
    }
    const big = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: JSON.stringify({ apiVersion: 1, path: "x".repeat(300000) }) });
    expect(big.status).toBe(413);
  });
});

describe("AC08 lifecycle operation recovery through a Local Server restart", () => {
  it("keeps one lifecycle effect per operation ID and observes it after restart without resending", async () => {
    const before = execFileSync("git", ["-C", env.repository, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
    const operationId = randomUUID();
    const start = await http(web.origin, `/api/v1/projects/${projectId}/session/start`, { method: "POST", headers: session.headers, body: { apiVersion: 1, operationId } });
    expect(start.status).toBe(202);
    const first = WebOperationSchema.parse(start.json);
    expect(first.operationId).toBe(operationId);
    // An uninitialized repository can never be started implicitly; the operation is never `applied`.
    const settled = await poll(async () => WebOperationSchema.parse((await http(web.origin, `/api/v1/projects/${projectId}/operations/${operationId}`, { headers: { cookie: session.cookie } })).json),
      operation => operation.state !== "accepted" && operation.state !== "running");
    expect(settled.state).not.toBe("applied");
    const replay = await http(web.origin, `/api/v1/projects/${projectId}/session/start`, { method: "POST", headers: session.headers, body: { apiVersion: 1, operationId } });
    expect(WebOperationSchema.parse(replay.json).operationId).toBe(operationId);
    const receipts = join(env.home, "state", "web", "lifecycle-receipts");
    const receiptCount = (await readdir(receipts, { recursive: true }).catch(() => [])).length;

    await web.stop("SIGINT");
    web = await startWeb(env.home, port);
    session = await pair(web.origin, web.pairing);
    const observed = await http(web.origin, `/api/v1/projects/${projectId}/operations/${operationId}`, { headers: { cookie: session.cookie } });
    expect(observed.status).toBe(200);
    const after = WebOperationSchema.parse(observed.json);
    expect(after.operationId).toBe(operationId);
    expect(after.state).toBe(settled.state);
    expect((await readdir(receipts, { recursive: true }).catch(() => [])).length).toBe(receiptCount);
    expect(execFileSync("git", ["-C", env.repository, "status", "--porcelain", "--ignored"], { encoding: "utf8" })).toBe(before);
    // Neither stdout nor private receipts carry a bootstrap or cookie value.
    const leaked = [bootstrapSecret(web.pairing), session.cookie.split("=")[1]!, session.csrf];
    for (const file of await readdir(receipts, { recursive: true }).catch(() => [] as string[])) {
      const text = await readFile(join(receipts, file), "utf8").catch(() => "");
      for (const secret of leaked) expect(text).not.toContain(secret);
    }
  });
});

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
