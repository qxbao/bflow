import type { JsonValue } from "@bflow/contracts";
import { CLI_EXIT_CODES } from "./types.js";

export type DirectorProvider = "claude" | "codex" | "agy";
const PROVIDERS: readonly DirectorProvider[] = ["claude", "codex", "agy"];
const MAX_HOOK_STDIN_BYTES = 1024 * 1024;
const HOOK_NOTE_TIMEOUT_MS = 3000;
const HOOK_STDIN_DEADLINE_MS = 2000;

export type DirectorArgs =
  | { readonly sub: "start"; readonly provider?: DirectorProvider | undefined; readonly json: boolean }
  | { readonly sub: "call"; readonly tool: string; readonly argsJson: string; readonly json: boolean }
  | { readonly sub: "mcp" }
  | { readonly sub: "hook"; readonly provider: "claude" | "codex" }
  | { readonly sub: "help" };

export const DIRECTOR_HELP = `Cách dùng: bflow director <lệnh con>

  start [--provider claude|codex|agy] [--json]   Đăng ký phiên Director và in token (chỉ dùng trong skill /bflow-start)
  call <tool> [--json] [<argsJson>]              Gọi một tool Director (cần biến BFLOW_DIRECTOR_TOKEN)
  mcp                                            Máy chủ MCP qua stdio cho Director
  hook <claude|codex>                            Hook ghi lại tin nhắn người dùng (luôn thoát 0)`;

export function parseDirectorArgs(args: readonly string[]): { ok: true; value: DirectorArgs } | { ok: false; message: string } {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h") return { ok: true, value: { sub: "help" } };
  if (sub === "start") {
    let provider: DirectorProvider | undefined; let json = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--json" || a === "-j") json = true;
      else if (a === "--provider") {
        const v = rest[++i];
        if (!PROVIDERS.includes(v as DirectorProvider)) return { ok: false, message: "--provider phải là claude, codex hoặc agy." };
        provider = v as DirectorProvider;
      } else return { ok: false, message: `Tham số không hợp lệ cho 'bflow director start': ${a}` };
    }
    return { ok: true, value: { sub, provider, json } };
  }
  if (sub === "call") {
    let tool: string | undefined; let argsJson: string | undefined; let json = false;
    for (const a of rest) {
      if (a === "--json" || a === "-j") json = true;
      else if (tool === undefined) tool = a;
      else if (argsJson === undefined) argsJson = a;
      else return { ok: false, message: `Tham số thừa cho 'bflow director call': ${a}` };
    }
    if (tool === undefined || tool.startsWith("-")) return { ok: false, message: "Thiếu tên tool: bflow director call <tool> [<argsJson>]" };
    return { ok: true, value: { sub, tool, argsJson: argsJson ?? "{}", json } };
  }
  if (sub === "mcp") return rest.length === 0 ? { ok: true, value: { sub } } : { ok: false, message: "'bflow director mcp' không nhận tham số." };
  if (sub === "hook") {
    const p = rest[0];
    if ((p !== "claude" && p !== "codex") || rest.length !== 1) return { ok: false, message: "Cách dùng: bflow director hook <claude|codex>" };
    return { ok: true, value: { sub, provider: p } };
  }
  return { ok: false, message: `Lệnh con không hợp lệ '${sub}' cho 'bflow director'. Dùng: start, call, mcp, hook.` };
}

export interface DirectorRepositoryIdentity { readonly root: string; readonly sessionName: string }
type HostOptions = { repositoryPath: string; sessionId: string };

export interface DirectorCommandDeps {
  readonly cwd: string;
  readonly identify: (cwd: string) => Promise<DirectorRepositoryIdentity>;
  readonly ensureUp: (cwd: string) => Promise<void>;
  readonly ownerCall: (opts: HostOptions, method: "director_register" | "director_hook_note", input: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly toolCall: (opts: HostOptions, token: string, name: string, args: Record<string, JsonValue>) => Promise<unknown>;
  readonly runMcp: (options: { call(name: string, token: string, args: Record<string, JsonValue>): Promise<unknown>; input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) => Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
  readonly hookStdinDeadlineMs?: number | undefined;
}

export async function defaultDirectorDeps(cwd: string): Promise<DirectorCommandDeps> {
  const runtime = await import("@bflow/runtime");
  return {
    cwd,
    identify: async dir => (await import("./repository.js")).identifyRepository(dir),
    ensureUp: async dir => {
      const { EnvironmentLifecycle } = await import("./environment.js");
      const lifecycle = new EnvironmentLifecycle(dir, { onProgress: m => { process.stderr.write(`${m}\n`); } });
      const status = await lifecycle.status();
      if (status.server === "running" && status.configuration === "valid" && status.manifest !== null) return;
      await lifecycle.up();
    },
    ownerCall: (opts, method, input, timeoutMs) => runtime.callDirectorOwnerHost(opts, method, input, timeoutMs),
    toolCall: (opts, token, name, args) => runtime.callDirectorTool(opts, token, name, args),
    runMcp: options => runtime.runDirectorMcp(options),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  };
}

export function detectProvider(env: Readonly<Record<string, string | undefined>>): DirectorProvider {
  if (env.CLAUDECODE === "1") return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return "codex";
  if (env.ANTIGRAVITY_AGENT || Object.keys(env).some(k => k.startsWith("AGY_"))) return "agy";
  return "claude";
}

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function scrub(text: string): string { return text.replace(/[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{16,}/g, "[đã ẩn]"); }

function startFix(message: string): string {
  if (/Not a Git working repository/i.test(message)) return "Chạy lệnh trong một kho Git (hoặc `git init`), rồi thử lại.";
  if (/Host unavailable|Foreign host/i.test(message)) return "Chạy `bflow up` trong kho này để khởi động host, rồi thử lại.";
  if (/config|cấu hình|init/i.test(message)) return "Chạy `bflow init` trong kho này rồi thử lại.";
  return "Chạy `bflow doctor` để xem nguyên nhân, sửa theo hướng dẫn rồi thử lại.";
}

async function readLimited(stream: NodeJS.ReadableStream, maxBytes: number, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const finish = (fn: () => void) => {
      if (done) return; done = true; clearTimeout(timer);
      stream.removeListener("data", onData); stream.removeListener("end", onEnd);
      // Keep an error listener so a late stream error cannot become an uncaught exception.
      stream.removeListener("error", onError); stream.on("error", () => {});
      try { stream.pause(); } catch {}
      try { (stream as { destroy?: () => void }).destroy?.(); } catch {}
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > maxBytes) { finish(() => reject(new Error("stdin too large"))); return; }
      chunks.push(b);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (e: Error) => finish(() => reject(e));
    const timer = setTimeout(() => finish(() => reject(new Error("stdin timeout"))), deadlineMs);
    timer.unref?.();
    stream.on("data", onData); stream.on("end", onEnd); stream.on("error", onError);
  });
}

export async function runDirectorCommand(args: DirectorArgs, deps: DirectorCommandDeps): Promise<number> {
  switch (args.sub) {
    case "help": deps.stdout.write(`${DIRECTOR_HELP}\n`); return 0;
    case "start": return runStart(args, deps);
    case "call": return runCall(args, deps);
    case "mcp": return runMcp(deps);
    case "hook": return runHook(args.provider, deps);
  }
}

async function runStart(args: Extract<DirectorArgs, { sub: "start" }>, deps: DirectorCommandDeps): Promise<number> {
  const provider = args.provider ?? detectProvider(deps.env);
  try {
    const repository = await deps.identify(deps.cwd);
    await deps.ensureUp(deps.cwd);
    const registered = await deps.ownerCall({ repositoryPath: repository.root, sessionId: repository.sessionName }, "director_register", { provider });
    if (!isRecord(registered) || typeof registered.token !== "string") throw new Error("Host trả về phản hồi đăng ký không hợp lệ.");
    const presence = isRecord(registered.session) ? registered.session.presence : undefined;
    const out = { ok: true, token: registered.token, cursor: "", sessionId: repository.sessionName, repositoryRoot: repository.root, provider, presence };
    deps.stdout.write(args.json ? `${JSON.stringify(out)}\n` : `Director đã sẵn sàng (nhà cung cấp ${provider}, phiên ${repository.sessionName}).\n`);
    return 0;
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    const fix = startFix(message);
    deps.stdout.write(args.json ? `${JSON.stringify({ ok: false, message, fix })}\n` : `${message}\n${fix}\n`);
    return CLI_EXIT_CODES.RUNTIME_ERROR;
  }
}

async function runCall(args: Extract<DirectorArgs, { sub: "call" }>, deps: DirectorCommandDeps): Promise<number> {
  const fail = (message: string, code: number = CLI_EXIT_CODES.RUNTIME_ERROR): number => {
    deps.stdout.write(args.json ? `${JSON.stringify({ ok: false, message })}\n` : `${message}\n`);
    return code;
  };
  const token = deps.env.BFLOW_DIRECTOR_TOKEN;
  if (!token) return fail("BFLOW_DIRECTOR_TOKEN chưa được đặt. Chạy `bflow director start --json` và đặt biến này.");
  let parsed: unknown;
  try { parsed = JSON.parse(args.argsJson); } catch { return fail("argsJson không phải JSON hợp lệ.", CLI_EXIT_CODES.USAGE_ERROR); }
  if (!isRecord(parsed)) return fail("argsJson phải là một đối tượng JSON.", CLI_EXIT_CODES.USAGE_ERROR);
  if (Object.prototype.hasOwnProperty.call(parsed, "token")) return fail("argsJson không được chứa khoá `token`; dùng BFLOW_DIRECTOR_TOKEN.", CLI_EXIT_CODES.USAGE_ERROR);
  try {
    const repository = await deps.identify(deps.cwd);
    const result = await deps.toolCall({ repositoryPath: repository.root, sessionId: repository.sessionName }, token, args.tool, parsed as Record<string, JsonValue>);
    deps.stdout.write(`${JSON.stringify(result ?? null)}\n`);
    return 0;
  } catch (error) {
    return fail(scrub((error instanceof Error ? error.message : String(error)).split(token).join("[đã ẩn]")));
  }
}

async function runMcp(deps: DirectorCommandDeps): Promise<number> {
  try {
    const repository = await deps.identify(deps.cwd);
    const opts = { repositoryPath: repository.root, sessionId: repository.sessionName };
    await deps.runMcp({
      call: (name, token, a) => deps.toolCall(opts, token, name, a),
      input: deps.stdin,
      output: deps.stdout as unknown as NodeJS.WritableStream
    });
    return 0;
  } catch (error) {
    deps.stderr.write(`${scrub(error instanceof Error ? error.message : String(error))}\n`);
    return CLI_EXIT_CODES.RUNTIME_ERROR;
  }
}

async function runHook(provider: "claude" | "codex", deps: DirectorCommandDeps): Promise<number> {
  try {
    if (deps.env.HERDR_PANE_ID) return 0;
    const raw = await readLimited(deps.stdin, MAX_HOOK_STDIN_BYTES, deps.hookStdinDeadlineMs ?? HOOK_STDIN_DEADLINE_MS);
    const payload: unknown = JSON.parse(raw);
    const prompt = isRecord(payload) ? payload.prompt : undefined;
    if (typeof prompt !== "string" || prompt.trim() === "") return 0;
    const repository = await deps.identify(deps.cwd);
    await deps.ownerCall({ repositoryPath: repository.root, sessionId: repository.sessionName }, "director_hook_note", { provider, prompt }, HOOK_NOTE_TIMEOUT_MS);
  } catch (error) {
    if (deps.env.BFLOW_DEBUG) { try { deps.stderr.write(`director hook: ${scrub(error instanceof Error ? error.message : String(error))}\n`); } catch {} }
  }
  return 0;
}

/** Hook entry point: any failure, including loading dependencies, yields exit 0 with nothing on stdout. */
export async function runDirectorHookSafely(provider: "claude" | "codex", makeDeps: () => Promise<DirectorCommandDeps>, env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  try {
    return await runHook(provider, await makeDeps());
  } catch (error) {
    if (env.BFLOW_DEBUG) { try { process.stderr.write(`director hook: ${scrub(error instanceof Error ? error.message : String(error))}\n`); } catch {} }
    return 0;
  }
}
