import { describe, expect, it } from "vitest";
import { parseCliArgs, runCli, getHelpText } from "../src/index.js";
import { executeApproveCard, describeApproveCard, type ApproveCardDeps, type ApproveCardOutput } from "../src/approve-card.js";
import type { ApproveCardCommandArgs, ApproveCommandArgs } from "../src/types.js";

// B2a Task 9 (D-DIR-02): `bflow approve <#n>` — the user's own decision on a pending card.

function card(argv: string[]): ApproveCardCommandArgs {
  const result = parseCliArgs(["approve", ...argv]);
  if (!result.ok) throw new Error(result.error.message);
  expect("card" in result.value).toBe(true);
  return result.value as ApproveCardCommandArgs;
}
function parseError(argv: string[]): string {
  const result = parseCliArgs(["approve", ...argv]);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error.message;
}

describe("bflow approve <#n> parsing", () => {
  it("accepts #3, 3 and n3, normalised to #3, defaulting to approved", () => {
    for (const value of ["#3", "3", "n3"]) expect(card([value])).toMatchObject({ command: "approve", card: "#3", outcome: "approved", json: false });
    expect(card(["#12", "--json"])).toMatchObject({ card: "#12", json: true });
    expect(card(["--json", "#4"])).toMatchObject({ card: "#4", json: true });
  });
  it("maps --reject, --changes and --choice", () => {
    expect(card(["#3", "--reject"])).toMatchObject({ outcome: "rejected" });
    expect(card(["#3", "--changes", "x"])).toMatchObject({ outcome: "changes_requested", reason: "x" });
    expect(card(["#3", "--choice", "2"])).toMatchObject({ outcome: "answer", choice: 2 });
  });
  it("refuses conflicting flags and bad values", () => {
    expect(parseError(["#3", "--reject", "--changes", "x"])).toBe("Chỉ chọn một: --reject, --changes hoặc --choice");
    expect(parseError(["#3", "--reject", "--choice", "1"])).toBe("Chỉ chọn một: --reject, --changes hoặc --choice");
    expect(parseError(["#3", "--changes", "x", "--choice", "1"])).toBe("Chỉ chọn một: --reject, --changes hoặc --choice");
    expect(parseError(["#3", "--choice", "7"])).toContain("--choice");
    expect(parseError(["#3", "--changes", "   "])).toContain("--changes");
    expect(parseError(["#3", "--decision", "rejected"])).toContain("Unknown option '--decision'");
    expect(parseError(["#3", "#4"])).toContain("Unexpected positional");
  });
  it("keeps approve <task-id> on the legacy branch", () => {
    const result = parseCliArgs(["approve", "task-1"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("card" in result.value).toBe(false);
      expect(result.value as ApproveCommandArgs).toMatchObject({ command: "approve", taskId: "task-1", decision: "approved" });
    }
    const withRun = parseCliArgs(["approve", "--run", "7", "qa"]);
    expect(withRun.ok && withRun.value).toMatchObject({ taskId: "qa", runId: "7" });
    expect("card" in (withRun.ok ? withRun.value : {})).toBe(false);
  });
  it("help documents the quoted card form", () => {
    expect(getHelpText("approve")).toContain("bflow approve '#3'");
  });
});

function deps(response: unknown, calls: unknown[] = []): ApproveCardDeps {
  return { cwd: "/repo", identify: async () => ({ root: "/repo", sessionName: "bf-1" }),
    hostCall: async (options, input) => { calls.push({ options, input }); if (response instanceof Error) throw response; return response; },
    parseValue: value => value as ApproveCardOutput, pid: 77, tty: true };
}
const value: ApproveCardOutput = { approvalId: "apr-1", runId: "run-1", kind: "approval", queued: true, code: "#3", outcome: "approved",
  runLabel: "việc #2", alreadyRecorded: false };

describe("bflow approve <#n> execution", () => {
  it("sends the owner-token decision and prints the Vietnamese confirmation", async () => {
    const calls: unknown[] = [];
    const result = await executeApproveCard(card(["#3", "--changes", "Sửa lỗi"]), deps({ ok: true, value }, calls));
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ options: { repositoryPath: "/repo", sessionId: "bf-1" },
      input: { code: "#3", outcome: "changes_requested", reason: "Sửa lỗi", tty: true, pid: 77 } }]);
    expect(describeApproveCard(value)).toBe("Đã ghi quyết định cho thẻ #3 (việc #2): duyệt.");
    expect(describeApproveCard({ ...value, outcome: "rejected" })).toBe("Đã ghi quyết định cho thẻ #3 (việc #2): từ chối.");
  });
  it("runCli prints text, or the JSON envelope with --json", async () => {
    const out: string[] = [];
    const io = { stdout: (m: string) => { out.push(m); }, stderr: (m: string) => { out.push(`ERR ${m}`); } };
    const text = await runCli(["approve", "#3"], { io, approveCard: deps({ ok: true, value }) });
    expect(text).toMatchObject({ ok: true, exitCode: 0, stdout: "Đã ghi quyết định cho thẻ #3 (việc #2): duyệt." });
    const json = await runCli(["approve", "3", "--json"], { io, approveCard: deps({ ok: true, value }) });
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, command: "approve", data: value });
  });
  it("reports host refusals and a missing host", async () => {
    const conflict = await executeApproveCard(card(["#3"]), deps({ ok: false, error: { code: "conflict", retryable: true, message: "Thẻ #3: việc đã kết thúc (completed)" } }));
    expect(conflict).toMatchObject({ ok: false, exitCode: 1, error: { code: "conflict", message: "Thẻ #3: việc đã kết thúc (completed)" } });
    const missing = await executeApproveCard(card(["#3"]), deps({ ok: false, error: { code: "not_found", retryable: false, message: "Không tìm thấy thẻ #3 đang chờ" } }));
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found", message: "Không tìm thấy thẻ #3 đang chờ" } });
    const down = await executeApproveCard(card(["#3"]), deps(new Error("Host unavailable")));
    expect(down).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
    expect(!down.ok && down.error.message).toContain("bflow up");
    const out: string[] = [];
    const failed = await runCli(["approve", "#3"], { io: { stdout: m => { out.push(m); }, stderr: m => { out.push(m); } },
      approveCard: deps({ ok: false, error: { code: "conflict", retryable: true, message: "Thẻ #3: thẻ không còn chờ quyết định" } }) });
    expect(failed.ok).toBe(false);
    expect(failed.stderr).toContain("Thẻ #3: thẻ không còn chờ quyết định");
  });
});
