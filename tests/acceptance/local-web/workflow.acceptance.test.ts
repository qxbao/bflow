// W09 HTTP acceptance against the actual built `bflow web` (CLI composition + Local Server).
// Evidence level: local integration without a Runtime host or provider. These tests never
// claim a live workflow; the live browser workflow is apps/web/e2e/workflow.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebApiErrorSchema, WebOperationSchema, WebPageSchema, WebProjectSchema, WebProjectSessionSchema, WebSessionSummarySchema } from "@bflow/contracts/web";
import { cliBinary, freePort, http, pair, removeScratch, scratchRepository, startWeb, bootstrapSecret, type WebProcess } from "./fixtures/web-process.js";

let env: Awaited<ReturnType<typeof scratchRepository>>, web: WebProcess, port: number;
const treeSnapshot = (repository: string) => execFileSync("git", ["-C", repository, "status", "--porcelain", "--ignored", "--untracked-files=all"], { encoding: "utf8" });
beforeAll(async () => { env = await scratchRepository("bflow-w09-workflow-"); port = await freePort(); web = await startWeb(env.home, port); });
afterAll(async () => { await web?.stop("SIGINT"); if (env) await removeScratch(env.scratch); });

describe("AC01 bflow web lifecycle", () => {
  it("serves the built UI on loopback, pairs once and recovers CSRF through GET /session", async () => {
    const page = await http(web.origin, "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain('<div id="root">');
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const first = await pair(web.origin, web.pairing);
    expect(first.setCookie).toMatch(/HttpOnly/);
    expect(first.setCookie).toMatch(/SameSite=Strict/);
    expect(first.setCookie).not.toMatch(/Domain=/i);
    expect(first.setCookie).toMatch(/Max-Age=43200/);
    // One-time bootstrap: the same fragment secret cannot mint a second session.
    const replay = await http(web.origin, "/api/v1/session/bootstrap", { method: "POST", headers: { origin: web.origin }, body: { apiVersion: 1, secret: bootstrapSecret(web.pairing) } });
    expect(replay.status).toBe(401);
    const refreshed = await http(web.origin, "/api/v1/session", { headers: { cookie: first.cookie } });
    expect(refreshed.status).toBe(200);
    expect(WebSessionSummarySchema.parse(refreshed.json).csrfToken).toBe(first.csrf);
    expect(refreshed.headers["cache-control"]).toBe("no-store");
  });

  it("a second invocation reuses the verified owner, refuses a different port and keeps the private locator 0600", async () => {
    const reuse = spawnSync("script", ["-q", "-c", `'${process.execPath}' '${cliBinary}' web --port ${port} --no-open`, "/dev/null"],
      { env: { ...process.env, BFLOW_HOME: env.home }, encoding: "utf8", timeout: 20000 });
    expect(reuse.status).toBe(0);
    const url = reuse.stdout.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/#bootstrap=[A-Za-z0-9_%+.-]+`))?.[0];
    expect(url).toBeDefined();
    expect(bootstrapSecret(url!)).not.toBe(bootstrapSecret(web.pairing));
    await pair(web.origin, url!);
    const other = await freePort();
    const refused = spawnSync(process.execPath, [cliBinary, "web", "--port", String(other), "--no-open"], { env: { ...process.env, BFLOW_HOME: env.home }, encoding: "utf8", timeout: 20000 });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain(`Web đã chạy tại ${web.origin}`);
    // Redirected (non-TTY) output never contains a bootstrap secret.
    const redirected = spawnSync(process.execPath, [cliBinary, "web", "--port", String(port), "--no-open"], { env: { ...process.env, BFLOW_HOME: env.home }, encoding: "utf8", timeout: 20000 });
    expect(redirected.status).toBe(0);
    expect(redirected.stdout + redirected.stderr).not.toMatch(/bootstrap=/);
    const state = join(env.home, "state", "web");
    const locator = await lstat(join(state, "instance.json"));
    expect(locator.mode & 0o077).toBe(0);
    expect(await readFile(join(state, "instance.json"), "utf8")).not.toContain(bootstrapSecret(web.pairing));
  });
});

describe("AC02/AC03 project registration and honest readiness without a host", () => {
  it("registers an absolute Git path read-only, de-duplicates it and never initializes the repository", async () => {
    const before = treeSnapshot(env.repository);
    const session = await pair(web.origin, await reissue());
    const created = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: { apiVersion: 1, path: env.repository } });
    expect(created.status).toBe(201);
    const project = WebProjectSchema.parse(created.json);
    const again = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: { apiVersion: 1, path: env.repository + "/" } });
    expect([200, 201]).toContain(again.status);
    expect(WebProjectSchema.parse(again.json).projectId).toBe(project.projectId);
    for (const path of ["relative/path", join(env.scratch, "missing"), env.home]) {
      const rejected = await http(web.origin, "/api/v1/projects", { method: "POST", headers: session.headers, body: { apiVersion: 1, path } });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      WebApiErrorSchema.parse(rejected.json);
    }
    const list = WebPageSchema(WebProjectSchema).parse((await http(web.origin, "/api/v1/projects", { headers: { cookie: session.cookie } })).json);
    expect(list.items.map(item => item.projectId)).toEqual([project.projectId]);
    // Readiness is an inspection, never an init/install/index.
    const inspected = await http(web.origin, `/api/v1/projects/${project.projectId}/session/inspect`, { method: "POST", headers: session.headers, body: { apiVersion: 1 } });
    // W09-F01 fix: an uninitialized repository is a not-ready report with an actionable check.
    expect(inspected.status).toBe(200);
    expect(inspected.json).toMatchObject({ ready: false, checks: [{ id: "repository-config", state: "failed" }] });
    expect(inspected.json.checks[0].message).toContain("bflow init");
    // No host exists: the session is readable as not ready, runs are honestly unavailable.
    const projectSession = await http(web.origin, `/api/v1/projects/${project.projectId}/session`, { headers: { cookie: session.cookie } });
    expect(projectSession.status).toBe(200);
    expect(WebProjectSessionSchema.parse(projectSession.json).state).not.toBe("ready");
    const runs = await http(web.origin, `/api/v1/projects/${project.projectId}/runs`, { headers: { cookie: session.cookie } });
    expect(runs.status).toBe(503);
    expect(WebApiErrorSchema.parse(runs.json).code).toBe("unavailable");
    expect(treeSnapshot(env.repository)).toBe(before);
    await expect(stat(join(env.repository, ".bflow"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a structured command against a project without a host is not applied and is observable by the same ID without resend", async () => {
    const session = await pair(web.origin, await reissue());
    const project = WebPageSchema(WebProjectSchema).parse((await http(web.origin, "/api/v1/projects", { headers: { cookie: session.cookie } })).json).items[0]!;
    const commandId = randomUUID();
    const command = { apiVersion: 1, commandId, projectId: project.projectId, kind: "create_request", title: "Thử nghiệm", requestKind: "feature",
      objective: "Không có host", acceptanceCriteria: [{ description: "Không áp dụng", verificationMethod: "automated_test" }], constraints: [] };
    const response = await http(web.origin, `/api/v1/projects/${project.projectId}/commands`, { method: "POST", headers: session.headers, body: command });
    // The host is absent: the server must not report `applied`; it may refuse or keep the ID uncertain.
    if (response.status === 202) expect(WebOperationSchema.parse(response.json).state).not.toBe("applied");
    else WebApiErrorSchema.parse(response.json);
    const changed = await http(web.origin, `/api/v1/projects/${project.projectId}/commands`, { method: "POST", headers: session.headers, body: { ...command, title: "Khác" } });
    if (response.status === 202) expect(changed.status).toBe(409);
    const observed = await http(web.origin, `/api/v1/projects/${project.projectId}/operations/${commandId}`, { headers: { cookie: session.cookie } });
    if (observed.status === 200) expect(WebOperationSchema.parse(observed.json).state).not.toBe("applied");
    else WebApiErrorSchema.parse(observed.json);
    expect(treeSnapshot(env.repository)).toBe("");
  });
});

describe("AC12 traditional CLI semantics are not re-advertised as a host API", () => {
  it("keeps legacy run/approve/resume/cancel help unchanged in kind and documents web as a separate surface", () => {
    const help = (args: string[]) => spawnSync(process.execPath, [cliBinary, ...args], { env: { ...process.env, BFLOW_HOME: env.home }, encoding: "utf8" });
    const top = help(["--help"]);
    expect(top.status).toBe(0);
    expect(top.stdout).toMatch(/web\s+Mở web localhost: bflow web \[--port N\] \[--no-open\]/);
    for (const command of ["run", "approve", "resume", "cancel"]) {
      const result = help([command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/\bweb\b|local[_ -]?web|interaction host|user_interaction/i);
    }
    expect(help(["approve", "--help"]).stdout).toContain("--decided-by");
    expect(help(["web", "--help"]).stdout).toContain("Ctrl-C chỉ đóng web; phiên dự án tiếp tục chạy");
    expect(help(["web", "--json"]).status).not.toBe(0);
  });
});

describe("AC01 Ctrl-C closes only the web owner", () => {
  it("SIGHUP (terminal closed) cleans up like Ctrl-C, and a SIGKILLed owner is recovered without PID takeover", async () => {
    const state = join(env.home, "state", "web");
    expect(await web.stop("SIGHUP")).not.toBeNull();
    expect((await readdir(state)).includes("instance.json")).toBe(false);
    web = await startWeb(env.home, port);
    expect(await web.stop("SIGKILL")).not.toBeNull();
    expect((await readdir(state)).includes("instance.json")).toBe(true);
    web = await startWeb(env.home, port);
    expect(web.output()).toContain("Đã dọn web instance cũ");
    const session = await pair(web.origin, web.pairing);
    expect(WebPageSchema(WebProjectSchema).parse((await http(web.origin, "/api/v1/projects", { headers: { cookie: session.cookie } })).json).items).toHaveLength(1);
  });

  it("SIGINT removes the locator and frees the port; a new owner starts on the same port", async () => {
    const state = join(env.home, "state", "web");
    const previous = await pair(web.origin, await reissue());
    expect(await web.stop("SIGINT")).not.toBeNull();
    expect((await readdir(state)).includes("instance.json")).toBe(false);
    web = await startWeb(env.home, port);
    expect((await http(web.origin, "/api/v1/projects", { headers: { cookie: previous.cookie } })).status).toBe(401);
    const session = await pair(web.origin, web.pairing);
    // Browser sessions are memory-only: the old cookie does not survive the owner restart,
    // but the project registry (BFLOW_HOME web state) does.
    const list = await http(web.origin, "/api/v1/projects", { headers: { cookie: session.cookie } });
    expect(WebPageSchema(WebProjectSchema).parse(list.json).items).toHaveLength(1);
  });
});

async function reissue(): Promise<string> {
  const result = spawnSync("script", ["-q", "-c", `'${process.execPath}' '${cliBinary}' web --port ${port} --no-open`, "/dev/null"],
    { env: { ...process.env, BFLOW_HOME: env.home }, encoding: "utf8", timeout: 20000 });
  const url = result.stdout.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/#bootstrap=[A-Za-z0-9_%+.-]+`))?.[0];
  if (!url) throw new Error("reuse invocation did not print a pairing URL: " + result.stdout + result.stderr);
  return url;
}
