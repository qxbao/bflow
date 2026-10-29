// Actual built `bflow web` process with an isolated BFLOW_HOME. No fake HTTP API, no
// in-process server: every request crosses real loopback TCP into the CLI composition.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSessionSummarySchema } from "@bflow/contracts/web";

export const repositoryRoot = resolve(__dirname, "../../../..");
export const cliBinary = join(repositoryRoot, "apps/cli/dist/bin.js");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export interface HttpResult { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }
export function http(origin: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult> {
  // Raw request target: WHATWG URL would normalize encoded dot segments before they reach the server.
  const url = new URL(origin);
  const payload = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return new Promise((accept, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: init.method ?? "GET", timeout: 20000, agent: false,
      headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...init.headers } }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => { let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
        accept({ status: res.statusCode!, headers: res.headers, text, json }); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export interface WebProcess { child: ChildProcess; origin: string; pairing: string; output: () => string; stop(signal?: NodeJS.Signals): Promise<number | null> }
/** `script` gives the CLI a real TTY: the pairing URL is printed only to an interactive terminal. */
export async function startWeb(home: string, port: number, extraEnv: Record<string, string> = {}, cwd = repositoryRoot): Promise<WebProcess> {
  const child = spawn("script", ["-q", "-c", `${quote(process.execPath)} ${quote(cliBinary)} web --port ${port} --no-open`, "/dev/null"], {
    cwd, env: { ...process.env, ...extraEnv, BFLOW_HOME: home }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buffer = "";
  child.stdout!.on("data", data => { buffer += String(data); });
  child.stderr!.on("data", data => { buffer += String(data); });
  const pairing = await waitForPairing(child, () => buffer, port);
  return { child, origin: `http://127.0.0.1:${port}`, pairing, output: () => buffer,
    stop: (signal = "SIGINT") => stopGroup(child, signal) };
}
export function waitForPairing(child: ChildProcess, output: () => string, port: number, timeoutMs = 20000): Promise<string> {
  return new Promise((accept, reject) => {
    const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/#bootstrap=[A-Za-z0-9_%+.-]+`);
    const timer = setInterval(() => { const match = output().match(pattern); if (match) { clearInterval(timer); clearTimeout(deadline); accept(match[0]); } }, 50);
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error("bflow web did not print pairing URL: " + output().slice(-400))); }, timeoutMs);
    child.once("exit", () => { setTimeout(() => { clearInterval(timer); clearTimeout(deadline); const match = output().match(pattern); match ? accept(match[0]) : reject(new Error("bflow web exited: " + output().slice(-400))); }, 100); });
  });
}
/** Terminal Ctrl-C reaches the CLI through the pty, not `script` itself: signal the node
 * descendant only and let `script` exit when it does. Signalling the whole group would let
 * `script` kill the CLI mid-close, which is not what an interactive Ctrl-C does. */
export async function stopGroup(child: ChildProcess, signal: NodeJS.Signals): Promise<number | null> {
  if (child.exitCode !== null || !child.pid) return child.exitCode;
  const target = cliDescendant(child.pid) ?? -child.pid;
  return new Promise(accept => {
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} accept(null); }, 15000);
    child.once("exit", code => { clearTimeout(timer); accept(code); });
    try { process.kill(target, signal); } catch { clearTimeout(timer); accept(child.exitCode); }
  });
}
export function cliDescendant(root: number): number | undefined {
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    const children = execFileSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean);
    for (const childPid of children) {
      const command = execFileSync("ps", ["-o", "args=", "-p", String(childPid)], { encoding: "utf8" });
      if (command.includes(cliBinary) && command.startsWith(process.execPath)) return childPid;
      queue.push(childPid);
    }
  }
  return undefined;
}
export function bootstrapSecret(pairing: string): string {
  return new URLSearchParams(new URL(pairing).hash.slice(1)).get("bootstrap")!;
}
export interface Paired { cookie: string; csrf: string; headers: Record<string, string>; setCookie: string; summary: ReturnType<typeof WebSessionSummarySchema.parse> }
export async function pair(origin: string, pairing: string): Promise<Paired> {
  const response = await http(origin, "/api/v1/session/bootstrap", { method: "POST", headers: { origin }, body: { apiVersion: 1, secret: bootstrapSecret(pairing) } });
  if (response.status !== 200) throw new Error(`bootstrap failed: ${response.status} ${response.text}`);
  const setCookie = String([response.headers["set-cookie"]].flat()[0]);
  const cookie = setCookie.split(";")[0]!;
  const summary = WebSessionSummarySchema.parse(response.json);
  return { cookie, csrf: summary.csrfToken, setCookie, summary, headers: { cookie, origin, "x-bflow-csrf": summary.csrfToken } };
}
export async function scratchRepository(prefix: string): Promise<{ scratch: string; home: string; repository: string }> {
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  const repository = join(scratch, "kho thử nghiệm");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=w09", "-c", "user.email=w09@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init"]);
  return { scratch, home: join(scratch, "home"), repository };
}
export const removeScratch = (path: string) => rm(path, { recursive: true, force: true });
export function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => accept(typeof address === "object" && address ? address.port : 0)); });
    }, reject);
  });
}
