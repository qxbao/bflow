/**
 * Real-app check driver. Runs INSIDE the Bubblewrap sandbox as `node app-check-driver.js <plan.json> <result.json>`.
 * It is self-contained: Node built-ins only, no imports from other bflow modules, because the sandbox mounts nothing
 * else from the repository. The only output contract is the result file, which the host validates with a strict schema.
 *
 * Evidence rules: the app is started from the owner argv inside the checkout and must answer its readiness path; a
 * check passes only when it has zero findings. Static HTML, a selector present in the raw markup or in a template,
 * and a successful screenshot are never sufficient: UI selectors must be present AND visible in the live DOM.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { dirname } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Details = Record<string, string | number | boolean | null>;
interface Finding { code: string; message: string; details?: Details }
interface Viewport { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number }
interface UiCheck { id: string; kind: "ui"; path: string; viewport: Viewport; expect: { selectors: string[]; text: string[] };
  noHorizontalOverflow: boolean; screenshot: boolean; timeoutMs: number }
interface JsonAssertion { pointer: string; equals?: Json; exists?: boolean; type?: string; minItems?: number }
interface ApiCheck { id: string; kind: "api"; request: { method: string; path: string; headers: Record<string, string>; body?: Json };
  expect: { status: number; headers?: Record<string, { equals?: string; contains?: string }>; json?: JsonAssertion[]; bodyContains?: string[] };
  timeoutMs: number }
type Check = UiCheck | ApiCheck;
interface Plan { schemaVersion: 1; checkout: string; port: number;
  app: { executable: string; args: string[]; env: Record<string, string>; readyPath: string; startTimeoutMs: number };
  contract?: { path: string }; browser?: { executable: string }; checks: Check[] }
interface CheckResult { checkId: string; kind: "ui" | "api"; status: "passed" | "failed"; startedAt: string; finishedAt: string;
  findings: Finding[]; observations: Record<string, Json>; screenshot?: string }
interface DriverResult { schemaVersion: 1; instanceId: string; origin: string; appReady: boolean;
  appExit?: { code: number | null; signal: string | null }; appStdoutTail: string; appStderrTail: string;
  notReadyReason?: "app_exited" | "app_not_ready"; readyAt?: string; browserReady?: boolean; browserVersion?: string; browserFailure?: string;
  startedAt: string; finishedAt: string; checks: CheckResult[]; driverError?: string }
interface Failure { message: string; details: Details }
type Contract = { ok: true; routes: { template: string[]; methods: Set<string> }[] } | { ok: false; message: string };

const MAX_FINDINGS = 50;
const MAX_MESSAGE = 2048;
const TAIL_BYTES = 8192;
const BODY_LIMIT = 64 * 1024;
const SCREENSHOT_LIMIT = 5 * 1024 * 1024;
const POLL_MS = 100;
const QUIET_MS = 300;
const METHODS = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const clip = (text: string, max = MAX_MESSAGE) => text.length > max ? `${text.slice(0, max - 3)}...` : text;
const tail = (text: string, max = TAIL_BYTES) => text.length > max ? text.slice(text.length - max) : text;
const errorMessage = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function addFinding(findings: Finding[], code: string, message: string, details?: Details): void {
  if (findings.length >= MAX_FINDINGS) return;
  findings.push({ code, message: clip(message), ...(details ? { details } : {}) });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

/* ---------- application process ---------- */

interface AppProcess { child: ChildProcess; stdout: string; stderr: string; exit?: { code: number | null; signal: string | null }; spawnError?: string }

function startApp(plan: Plan): AppProcess {
  const child = spawn(plan.app.executable, plan.app.args, {
    cwd: plan.checkout, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/bflow-home", TMPDIR: "/tmp", LANG: "C", HOST: "127.0.0.1", PORT: String(plan.port), ...plan.app.env }
  });
  const app: AppProcess = { child, stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => { app.stdout = tail(app.stdout + chunk.toString("utf8")); });
  child.stderr?.on("data", (chunk: Buffer) => { app.stderr = tail(app.stderr + chunk.toString("utf8")); });
  child.on("error", error => { app.spawnError = error.message; app.exit ??= { code: null, signal: null }; });
  child.on("exit", (code, signal) => { app.exit ??= { code, signal }; });
  return app;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
}

/** Terminates the app's whole process group: TERM, a 2 s grace period, then KILL for any remaining member. */
async function stopApp(app: AppProcess): Promise<void> {
  killGroup(app.child, "SIGTERM");
  await waitFor(() => app.exit !== undefined, 2000);
  killGroup(app.child, "SIGKILL");
}

async function waitReady(origin: string, plan: Plan, app: AppProcess): Promise<boolean> {
  const deadline = Date.now() + plan.app.startTimeoutMs;
  while (Date.now() < deadline) {
    if (app.exit) return false;
    try {
      const response = await fetch(origin + plan.app.readyPath, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return true;
    } catch { /* not listening yet */ }
    await sleep(POLL_MS);
  }
  return false;
}

/* ---------- API checks ---------- */

const isObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value);
const jsonType = (value: Json): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
const preview = (value: Json | undefined) => value === undefined ? "(absent)" : clip(JSON.stringify(value) ?? "null", 512);

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index] ?? null));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key] ?? null, b[key] ?? null));
  }
  return false;
}

/** RFC 6901 resolution; "" is the document root. */
function resolvePointer(document: Json, pointer: string): { found: true; value: Json } | { found: false } {
  let current: Json = document;
  if (pointer === "") return { found: true, value: current };
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!/^(0|[1-9]\d*)$/.test(token) || index >= current.length) return { found: false };
      current = current[index] ?? null;
    } else if (isObject(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token] ?? null;
    } else return { found: false };
  }
  return { found: true, value: current };
}

function evaluateJsonAssertion(document: Json, assertion: JsonAssertion): Failure | undefined {
  const resolved = resolvePointer(document, assertion.pointer);
  const label = assertion.pointer === "" ? "(root)" : assertion.pointer;
  const actual = resolved.found ? preview(resolved.value) : "(absent)";
  const fail = (what: string): Failure => ({ message: `${label} ${what}`, details: { assertion: `${label} ${what}`, actual } });
  if (assertion.exists !== undefined) {
    return resolved.found === assertion.exists ? undefined : fail(assertion.exists ? "must exist" : "must be absent");
  }
  if (!resolved.found) return fail("is absent");
  if (assertion.equals !== undefined) return deepEqual(resolved.value, assertion.equals) ? undefined : fail(`must equal ${preview(assertion.equals)}`);
  if (assertion.type !== undefined) {
    if (jsonType(resolved.value) !== assertion.type) return fail(`must have type ${assertion.type}`);
    if (assertion.minItems !== undefined && Array.isArray(resolved.value) && resolved.value.length < assertion.minItems) return fail(`must have at least ${assertion.minItems} items`);
  }
  return undefined;
}

/** Reads at most `limit` bytes; the caller's abort signal still bounds the wait for the rest of the body. */
async function readBounded(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

async function loadContract(origin: string, path: string): Promise<Contract> {
  try {
    const response = await fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, message: `contract ${path} responded with status ${response.status}` };
    }
    const { text, truncated } = await readBounded(response, BODY_LIMIT);
    if (truncated) return { ok: false, message: "contract document exceeds the size limit" };
    const document = JSON.parse(text) as { paths?: Record<string, Record<string, unknown> | null> };
    if (!document.paths || typeof document.paths !== "object") return { ok: false, message: "contract has no paths object" };
    const routes = Object.entries(document.paths).map(([template, item]) => ({
      template: template.split("/"),
      methods: new Set(Object.keys(item ?? {}).map(method => method.toLowerCase()).filter(method => METHODS.has(method)))
    }));
    return { ok: true, routes };
  } catch (error) {
    return { ok: false, message: clip(`contract ${path} could not be read: ${errorMessage(error)}`) };
  }
}

function routeDeclared(routes: { template: string[]; methods: Set<string> }[], method: string, path: string): boolean {
  const requested = (path.split("?")[0] ?? "").split("/");
  return routes.some(route => route.template.length === requested.length && route.methods.has(method.toLowerCase()) &&
    route.template.every((segment, index) => /^\{[^}]+\}$/.test(segment) ? requested[index] !== "" : segment === requested[index]));
}

function evaluateApi(expect: ApiCheck["expect"], status: number, headers: Headers, text: string, truncated: boolean, findings: Finding[]): void {
  if (status !== expect.status) addFinding(findings, "api_assertion_failed", `status ${status} does not equal ${expect.status}`, { assertion: "status", actual: String(status) });
  for (const [name, rule] of Object.entries(expect.headers ?? {})) {
    const actual = headers.get(name);
    const label = `header ${name}`;
    if (actual === null) addFinding(findings, "api_assertion_failed", `${label} is absent`, { assertion: label, actual: "(absent)" });
    else if (rule.equals !== undefined && actual !== rule.equals) addFinding(findings, "api_assertion_failed", `${label} must equal ${JSON.stringify(rule.equals)}`, { assertion: label, actual: clip(actual, 512) });
    else if (rule.contains !== undefined && !actual.includes(rule.contains)) addFinding(findings, "api_assertion_failed", `${label} must contain ${JSON.stringify(rule.contains)}`, { assertion: label, actual: clip(actual, 512) });
  }
  const needsBody = (expect.json?.length ?? 0) > 0 || (expect.bodyContains?.length ?? 0) > 0;
  if (!needsBody) return;
  if (truncated) { addFinding(findings, "api_body_too_large", `response body exceeds ${BODY_LIMIT} bytes`); return; }
  for (const needle of expect.bodyContains ?? []) {
    if (!text.includes(needle)) addFinding(findings, "api_assertion_failed", `body must contain ${JSON.stringify(needle)}`, { assertion: `body contains ${JSON.stringify(needle)}`, actual: clip(text, 512) });
  }
  if (!expect.json?.length) return;
  let document: Json;
  try { document = JSON.parse(text) as Json; }
  catch { addFinding(findings, "api_body_not_json", "response body is not JSON but JSON assertions are configured"); return; }
  for (const assertion of expect.json) {
    const failure = evaluateJsonAssertion(document, assertion);
    if (failure) addFinding(findings, "api_assertion_failed", failure.message, failure.details);
  }
}

async function runApiCheck(origin: string, check: ApiCheck, contract: (() => Promise<Contract>) | undefined): Promise<CheckResult> {
  const startedAt = nowIso(), findings: Finding[] = [], observations: Record<string, Json> = {};
  if (contract) {
    const loaded = await contract();
    if (!loaded.ok) addFinding(findings, "api_contract_unavailable", loaded.message);
    else if (!routeDeclared(loaded.routes, check.request.method, check.request.path))
      addFinding(findings, "api_route_not_in_contract", `${check.request.method} ${check.request.path} is not declared in the contract`);
  }
  const headers: Record<string, string> = { ...check.request.headers };
  const body = check.request.body === undefined ? undefined : JSON.stringify(check.request.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await fetch(origin + check.request.path, {
      method: check.request.method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(check.timeoutMs)
    });
    const { text, truncated } = await readBounded(response, BODY_LIMIT);
    observations.status = response.status;
    observations.contentType = clip(response.headers.get("content-type") ?? "", 256);
    observations.bodyBytes = text.length;
    evaluateApi(check.expect, response.status, response.headers, text, truncated, findings);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") addFinding(findings, "api_timeout", `no complete response within ${check.timeoutMs} ms`);
    else addFinding(findings, "api_request_failed", errorMessage(error));
  }
  return finish(check.id, "api", startedAt, findings, observations);
}

function finish(checkId: string, kind: "ui" | "api", startedAt: string, findings: Finding[], observations: Record<string, Json>, screenshot?: string): CheckResult {
  return { checkId, kind, status: findings.length === 0 ? "passed" : "failed", startedAt, finishedAt: nowIso(), findings, observations, ...(screenshot ? { screenshot } : {}) };
}

/* ---------- browser over CDP (fd 3 writes, fd 4 reads, NUL-terminated JSON) ---------- */

type Listener = (method: string, params: any) => void;

class Cdp {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Map<string, Listener>();

  constructor(private readonly writer: Writable, reader: Readable) {
    writer.on("error", () => this.failAll("CDP pipe closed"));
    reader.setEncoding("utf8");
    reader.on("data", (chunk: string) => this.receive(chunk));
    reader.on("close", () => this.failAll("CDP pipe closed"));
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  listen(sessionId: string, listener: Listener): void { this.listeners.set(sessionId, listener); }
  unlisten(sessionId: string): void { this.listeners.delete(sessionId); }

  failAll(reason: string): void {
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error(`${pending.method}: ${reason}`)); }
    this.pending.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf("\0");
      if (end < 0) return;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message: any;
      try { message = JSON.parse(raw); } catch { continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "error"}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const listener = this.listeners.get(message.sessionId ?? "");
      try { listener?.(message.method, message.params ?? {}); } catch { /* a listener must never break the pipe */ }
    }
  }
}

interface Browser { child: ChildProcess; cdp: Cdp; version: string; stderr: { text: string } }

async function launchBrowser(executable: string): Promise<Browser> {
  const stderr = { text: "" };
  const child = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--mute-audio",
    `--user-data-dir=/tmp/bflow-chrome-${randomUUID()}`, "--remote-debugging-pipe", "about:blank"], {
    detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/bflow-home", TMPDIR: "/tmp", LANG: "C" }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr.text = tail(stderr.text + chunk.toString("utf8")); });
  const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  child.on("exit", () => cdp.failAll("browser exited"));
  child.on("error", error => cdp.failAll(error.message));
  try {
    const version = await cdp.send("Browser.getVersion", {}, undefined, 10000);
    return { child, cdp, version: clip(String(version.product ?? "unknown"), 256), stderr };
  } catch (error) {
    killGroup(child, "SIGKILL");
    throw new Error(`${errorMessage(error)}; stderr: ${tail(stderr.text, 2048)}`);
  }
}

async function closeBrowser(browser: Browser): Promise<void> {
  await browser.cdp.send("Browser.close", {}, undefined, 2000).catch(() => undefined);
  await waitFor(() => browser.child.exitCode !== null || browser.child.signalCode !== null, 2000);
  killGroup(browser.child, "SIGKILL");
  browser.cdp.failAll("browser closed");
}

const isFavicon = (url: string | undefined) => {
  if (!url) return false;
  try { return new URL(url).pathname === "/favicon.ico"; } catch { return false; }
};

/** Live DOM probe: each selector must match a visible element; each text must appear in the rendered body. */
function probeExpression(selectors: string[], texts: string[]): string {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const texts = ${JSON.stringify(texts)};
    const missing = [];
    for (const selector of selectors) {
      let ok = false;
      try {
        const element = document.querySelector(selector);
        ok = Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
      } catch { ok = false; }
      if (!ok) missing.push("selector " + selector);
    }
    const body = document.body ? document.body.innerText : "";
    for (const text of texts) if (!body.includes(text)) missing.push("text " + JSON.stringify(text));
    const root = document.documentElement;
    return { missing, bodyLength: body.trim().length, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, href: location.href };
  })()`;
}

async function evaluate(cdp: Cdp, sessionId: string, expression: string): Promise<any> {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sessionId, 5000);
  if (response.exceptionDetails) throw new Error(clip(String(response.exceptionDetails.text ?? "page evaluation failed")));
  return response.result?.value;
}

async function runUiCheck(cdp: Cdp, origin: string, check: UiCheck, resultDir: string): Promise<CheckResult> {
  const startedAt = nowIso(), findings: Finding[] = [], observations: Record<string, Json> = {};
  const url = origin + check.path;
  const state = { loaded: false, quietSince: Date.now() as number | undefined, inFlight: new Map<string, string>() };
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  let session: string | undefined;
  try {
    session = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId as string;
    const sessionId = session;
    cdp.listen(sessionId, (method, params) => {
      switch (method) {
        case "Page.loadEventFired": state.loaded = true; break;
        case "Runtime.exceptionThrown": {
          const details = params.exceptionDetails ?? {};
          addFinding(findings, "ui_page_error", String(details.exception?.description ?? details.text ?? "uncaught exception"));
          break;
        }
        case "Runtime.consoleAPICalled":
          if (params.type === "error") {
            const text = (params.args ?? []).map((arg: any) => String(arg.value ?? arg.description ?? arg.type)).join(" ");
            addFinding(findings, "ui_console_error", text);
          }
          break;
        case "Log.entryAdded":
          if (params.entry?.level === "error" && !isFavicon(params.entry.url)) addFinding(findings, "ui_console_error", String(params.entry.text ?? ""));
          break;
        case "Network.requestWillBeSent":
          if (!isFavicon(params.request?.url)) { state.inFlight.set(params.requestId, String(params.request?.url)); state.quietSince = undefined; }
          break;
        case "Network.loadingFinished":
        case "Network.loadingFailed": {
          const requestUrl = state.inFlight.get(params.requestId);
          if (requestUrl === undefined) break;
          state.inFlight.delete(params.requestId);
          if (state.inFlight.size === 0) state.quietSince = Date.now();
          if (method === "Network.loadingFailed" && params.canceled !== true) addFinding(findings, "ui_request_failed", `${requestUrl}: ${String(params.errorText ?? "failed")}`);
          break;
        }
        case "Network.responseReceived": {
          const responseUrl = String(params.response?.url ?? "");
          const status = Number(params.response?.status ?? 0);
          if (status >= 400 && !isFavicon(responseUrl)) {
            const main = params.type === "Document" && responseUrl === url;
            addFinding(findings, "ui_http_error", `${status} ${responseUrl}`, { status, main });
          }
          break;
        }
        default: break;
      }
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: check.viewport.width, height: check.viewport.height,
      deviceScaleFactor: check.viewport.deviceScaleFactor ?? 1, mobile: check.viewport.mobile ?? false }, sessionId);
    const navigation = await cdp.send("Page.navigate", { url }, sessionId);
    const navigationFailed = typeof navigation.errorText === "string";
    if (navigationFailed) addFinding(findings, "ui_navigation_failed", String(navigation.errorText));

    let missing: string[] = [], settled = false;
    const deadline = Date.now() + check.timeoutMs;
    if (!navigationFailed) {
      const expression = probeExpression(check.expect.selectors, check.expect.text);
      while (Date.now() < deadline) {
        if (state.loaded) {
          const probe = await evaluate(cdp, sessionId, expression);
          missing = Array.isArray(probe?.missing) ? probe.missing.map(String) : [];
          if (missing.length === 0 && state.quietSince !== undefined && Date.now() - state.quietSince >= QUIET_MS) { settled = true; break; }
        }
        await sleep(POLL_MS);
      }
      if (!settled) {
        if (!state.loaded) addFinding(findings, "ui_timeout", `page did not finish loading within ${check.timeoutMs} ms`);
        else if (missing.length > 0) addFinding(findings, "ui_expect_missing", `not present and visible before the deadline: ${missing.join(", ")}`, { missing: clip(missing.join(", "), 512) });
        else addFinding(findings, "ui_timeout", `network did not settle within ${check.timeoutMs} ms`);
      }
    }
    try {
      const final = await evaluate(cdp, sessionId, probeExpression([], []));
      observations.href = clip(String(final?.href ?? ""), 512);
      observations.innerWidth = Number(final?.innerWidth ?? 0);
      observations.innerHeight = Number(final?.innerHeight ?? 0);
      observations.scrollWidth = Number(final?.scrollWidth ?? 0);
      observations.clientWidth = Number(final?.clientWidth ?? 0);
      observations.bodyTextLength = Number(final?.bodyLength ?? 0);
      if (settled) {
        if (Number(final?.bodyLength ?? 0) === 0) addFinding(findings, "ui_empty", "the rendered page has no text");
        if (Number(final?.innerWidth) !== check.viewport.width) addFinding(findings, "ui_viewport_mismatch", `window width ${final?.innerWidth} is not ${check.viewport.width}`);
        if (check.noHorizontalOverflow && Number(final?.scrollWidth) > Number(final?.clientWidth))
          addFinding(findings, "ui_horizontal_overflow", `document scroll width ${final?.scrollWidth} exceeds client width ${final?.clientWidth}`);
      }
    } catch (error) {
      addFinding(findings, "ui_probe_failed", errorMessage(error));
    }
    let screenshot: string | undefined;
    if (check.screenshot) {
      try {
        const captured = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId, 15000);
        const bytes = Buffer.from(String(captured.data ?? ""), "base64");
        if (bytes.length > SCREENSHOT_LIMIT) observations.screenshot = "too_large";
        else {
          writeFileSync(`${resultDir}/${check.id}.png`, bytes, { mode: 0o600 });
          screenshot = `${check.id}.png`;
          observations.screenshot = "written";
        }
      } catch (error) {
        observations.screenshot = clip(`failed: ${errorMessage(error)}`, 256);
      }
    }
    return finish(check.id, "ui", startedAt, findings, observations, screenshot);
  } finally {
    if (session) cdp.unlisten(session);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/* ---------- driver entry ---------- */

async function main(planPath: string, resultPath: string): Promise<void> {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const origin = `http://127.0.0.1:${plan.port}`;
  const result: DriverResult = { schemaVersion: 1, instanceId: randomUUID(), origin, appReady: false, appStdoutTail: "", appStderrTail: "",
    startedAt: nowIso(), finishedAt: "", checks: [] };
  const app = startApp(plan);
  let browser: Browser | undefined;
  try {
    result.appReady = await waitReady(origin, plan, app);
    if (result.appReady) result.readyAt = nowIso();
    else result.notReadyReason = app.exit ? "app_exited" : "app_not_ready";
    if (result.appReady) {
      const contractPath = plan.contract?.path;
      let contractPromise: Promise<Contract> | undefined;
      const contract = contractPath === undefined ? undefined : () => (contractPromise ??= loadContract(origin, contractPath));
      for (const check of plan.checks) {
        if (check.kind === "api") result.checks.push(await runApiCheck(origin, check, contract));
      }
      if (plan.checks.some(check => check.kind === "ui")) {
        try {
          if (!plan.browser) throw new Error("browser executable missing from plan");
          browser = await launchBrowser(plan.browser.executable);
          result.browserReady = true;
          result.browserVersion = browser.version;
        } catch (error) {
          result.browserReady = false;
          result.browserFailure = clip(errorMessage(error));
        }
        if (browser) {
          for (const check of plan.checks) {
            if (check.kind === "ui") result.checks.push(await runUiCheck(browser.cdp, origin, check, dirname(resultPath)));
          }
        }
      }
    }
  } catch (error) {
    result.driverError = clip(errorMessage(error));
  } finally {
    if (browser) await closeBrowser(browser).catch(() => undefined);
    if (app.exit) result.appExit = app.exit;
    if (app.spawnError) result.driverError ??= clip(`app could not start: ${app.spawnError}`);
    await stopApp(app);
    result.appStdoutTail = app.stdout;
    result.appStderrTail = app.stderr;
    result.finishedAt = nowIso();
    const temporary = `${resultPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
    renameSync(temporary, resultPath);
  }
}

const [planArgument, resultArgument] = process.argv.slice(2);
if (!planArgument || !resultArgument) {
  process.exitCode = 2;
} else {
  main(planArgument, resultArgument).then(() => process.exit(0), () => process.exit(1));
}
