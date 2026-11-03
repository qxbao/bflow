import { DirectorProgressSnapshotSchema, ParkedIssueSchema, ParkedIssueStatusSchema, type ParkedIssue, type ParkedIssueStatus } from "@bflow/contracts";
import { CLI_EXIT_CODES } from "./types.js";

const NO_SESSION = "BFLOW · Chưa có phiên — chạy /bflow-start trong CLI của bạn";
const FOLLOW_INTERVAL_MS = 2000;
const CLEAR = "\x1b[H\x1b[2J";

export type ProgressArgs = { readonly cmd: "progress"; readonly follow: boolean; readonly json: boolean };
export type QueueArgs =
  | { readonly cmd: "queue"; readonly sub: "list"; readonly status?: readonly ParkedIssueStatus[] | undefined; readonly json: boolean }
  | { readonly cmd: "queue"; readonly sub: "show"; readonly issueId: string; readonly json: boolean }
  | { readonly cmd: "queue"; readonly sub: "retry" | "dismiss"; readonly issueId: string };
export type DirectorProgressCliArgs = ProgressArgs | QueueArgs;
type ParseResult = { ok: true; value: DirectorProgressCliArgs } | { ok: false; message: string };

export const PROGRESS_HELP = `Cách dùng: bflow progress [--follow] [--json]

  --follow   Vẽ lại tiến độ mỗi 2 giây cho tới khi nhấn Ctrl+C
  --json     In ảnh chụp tiến độ dưới dạng một giá trị JSON`;

export const QUEUE_HELP = `Cách dùng: bflow queue <lệnh con>

  list [--status open,retrying,...] [--json]   Liệt kê hàng đợi lỗi
  show <issueId> [--json]                      Xem chi tiết một lỗi
  retry <issueId>                              Đánh dấu thử lại
  dismiss <issueId>                            Bỏ qua lỗi`;

export function parseProgressCliArgs(cmd: "progress" | "queue", args: readonly string[]): ParseResult {
  if (cmd === "progress") {
    let follow = false, json = false;
    for (const a of args) {
      if (a === "--follow" || a === "-f") follow = true;
      else if (a === "--json" || a === "-j") json = true;
      else return { ok: false, message: `Tham số không hợp lệ cho 'bflow progress': ${a}` };
    }
    return { ok: true, value: { cmd, follow, json } };
  }
  const [sub, ...rest] = args;
  if (sub === "list") {
    let json = false; let status: ParkedIssueStatus[] | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--json" || a === "-j") json = true;
      else if (a === "--status") {
        const v = rest[++i];
        if (v === undefined) return { ok: false, message: "--status cần giá trị, ví dụ open,retrying." };
        const parsed = v.split(",").map(s => ParkedIssueStatusSchema.safeParse(s.trim()));
        if (parsed.some(p => !p.success)) return { ok: false, message: "--status chỉ nhận open, retrying, resolved, dismissed." };
        status = parsed.map(p => (p as { data: ParkedIssueStatus }).data);
      } else return { ok: false, message: `Tham số không hợp lệ cho 'bflow queue list': ${a}` };
    }
    return { ok: true, value: { cmd, sub, status, json } };
  }
  if (sub === "show" || sub === "retry" || sub === "dismiss") {
    let json = false; let issueId: string | undefined;
    for (const a of rest) {
      if ((a === "--json" || a === "-j") && sub === "show") json = true;
      else if (a.startsWith("-")) return { ok: false, message: `Tham số không hợp lệ cho 'bflow queue ${sub}': ${a}` };
      else if (issueId === undefined) issueId = a;
      else return { ok: false, message: `Tham số thừa cho 'bflow queue ${sub}': ${a}` };
    }
    if (issueId === undefined) return { ok: false, message: `Thiếu mã lỗi: bflow queue ${sub} <issueId>` };
    return { ok: true, value: sub === "show" ? { cmd, sub, issueId, json } : { cmd, sub, issueId } };
  }
  return { ok: false, message: "Lệnh con không hợp lệ cho 'bflow queue'. Dùng: list, show, retry, dismiss." };
}

type HostOptions = { repositoryPath: string; sessionId: string };
export interface DirectorProgressDeps {
  readonly cwd: string;
  readonly identify: (cwd: string) => Promise<{ root: string; sessionName: string }>;
  readonly ownerCall: (opts: HostOptions, method: string, input: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly render: (snapshot: ReturnType<typeof DirectorProgressSnapshotSchema.parse>, options: { width: number; height: number; now: Date }) => string[];
  readonly now: () => Date;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly stdout: { write(chunk: string): unknown; columns?: number | undefined; rows?: number | undefined };
  readonly stderr: { write(chunk: string): unknown };
}

export async function defaultDirectorProgressDeps(cwd: string): Promise<DirectorProgressDeps> {
  const runtime = await import("@bflow/runtime");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return {
    cwd,
    identify: async dir => (await import("./repository.js")).identifyRepository(dir),
    ownerCall: (opts, method, input, timeoutMs) => runtime.callDirectorOwnerHost(opts, method as never, input, timeoutMs),
    render: (snapshot, options) => runtime.renderDirectorProgress(snapshot, options),
    now: () => new Date(),
    sleep: (ms, signal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    }),
    signal: controller.signal,
    stdout: process.stdout,
    stderr: process.stderr
  };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function runProgressCommand(args: ProgressArgs, deps: DirectorProgressDeps): Promise<number> {
  const frame = async (): Promise<{ ok: true; lines: string[]; json: string } | { ok: false; message: string }> => {
    try {
      const repository = await deps.identify(deps.cwd);
      const raw = await deps.ownerCall({ repositoryPath: repository.root, sessionId: repository.sessionName }, "director_progress", {});
      const snapshot = DirectorProgressSnapshotSchema.parse(raw);
      return { ok: true, json: JSON.stringify(snapshot), lines: deps.render(snapshot, { width: deps.stdout.columns ?? 80, height: deps.stdout.rows ?? 24, now: deps.now() }) };
    } catch (error) {
      const message = errorText(error);
      return { ok: false, message: /Host unavailable|Foreign host|Not a Git/i.test(message) ? NO_SESSION : `${NO_SESSION}\n(${message})` };
    }
  };
  if (!args.follow) {
    const f = await frame();
    if (!f.ok) { deps.stderr.write(`${f.message}\n`); return CLI_EXIT_CODES.RUNTIME_ERROR; }
    deps.stdout.write(args.json ? `${f.json}\n` : `${f.lines.join("\n")}\n`);
    return 0;
  }
  while (!deps.signal.aborted) {
    const f = await frame();
    if (deps.signal.aborted) break;
    if (args.json) deps.stdout.write(f.ok ? `${f.json}\n` : `${JSON.stringify({ ok: false, message: NO_SESSION })}\n`);
    else deps.stdout.write(`${CLEAR}${f.ok ? f.lines.join("\n") : f.message}\n`);
    await deps.sleep(FOLLOW_INTERVAL_MS, deps.signal);
  }
  return 0;
}

const STATUS_VI: Record<string, string> = { open: "mở", retrying: "đang thử lại", resolved: "đã xử lý", dismissed: "đã bỏ qua" };
function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const pts = Array.from(flat);
  return pts.length > max ? `${pts.slice(0, max - 1).join("")}…` : flat;
}
function table(issues: readonly ParkedIssue[]): string {
  const rows = [["Mã", "Loại", "Trạng thái", "Task", "Tóm tắt"], ...issues.map(i => [i.issueId, i.kind, STATUS_VI[i.status] ?? i.status, i.taskKey ?? "-", oneLine(i.summary, 60)])];
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map(r => Array.from(r[c]!).length)));
  return rows.map(r => r.map((cell, c) => cell + " ".repeat(widths[c]! - Array.from(cell).length)).join("  ").trimEnd()).join("\n");
}

export async function runQueueCommand(args: QueueArgs, deps: DirectorProgressDeps): Promise<number> {
  try {
    const repository = await deps.identify(deps.cwd);
    const opts = { repositoryPath: repository.root, sessionId: repository.sessionName };
    if (args.sub === "list") {
      const issues = ParkedIssueSchema.array().parse(await deps.ownerCall(opts, "director_issues", args.status ? { status: args.status } : {}));
      if (args.json) deps.stdout.write(`${JSON.stringify(issues)}\n`);
      else deps.stdout.write(issues.length === 0 ? "Hàng đợi lỗi trống.\n" : `${table(issues)}\n`);
      return 0;
    }
    if (args.sub === "show") {
      const issue = ParkedIssueSchema.parse(await deps.ownerCall(opts, "director_issue", { issueId: args.issueId }));
      if (args.json) { deps.stdout.write(`${JSON.stringify(issue)}\n`); return 0; }
      const lines = [
        `Mã: ${issue.issueId}`, `Loại: ${issue.kind}`, `Trạng thái: ${STATUS_VI[issue.status] ?? issue.status}`,
        `Lượt chạy: ${issue.runId}`, `Task: ${issue.taskKey ?? "-"}`, `Số lần thử: ${issue.attempts}`,
        `Tóm tắt: ${oneLine(issue.summary, 500)}`,
        ...(issue.suggestedAction ? [`Gợi ý: ${oneLine(issue.suggestedAction, 500)}`] : []),
        ...(issue.evidence.length ? ["Bằng chứng:", ...issue.evidence.map(e => `  ${e}`)] : []),
        `Tạo lúc: ${issue.createdAt}`, `Cập nhật: ${issue.updatedAt}`
      ];
      deps.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    const status = args.sub === "retry" ? "retrying" : "dismissed";
    const issue = ParkedIssueSchema.parse(await deps.ownerCall(opts, "director_issue_status", { issueId: args.issueId, status }));
    deps.stdout.write(`Lỗi ${issue.issueId}: ${STATUS_VI[issue.status] ?? issue.status}.\n`);
    return 0;
  } catch (error) {
    const message = errorText(error);
    deps.stderr.write(/Host unavailable|Foreign host/i.test(message) ? "Chưa có host đang chạy. Chạy `bflow up` hoặc /bflow-start trước.\n" : `${message}\n`);
    return CLI_EXIT_CODES.RUNTIME_ERROR;
  }
}
