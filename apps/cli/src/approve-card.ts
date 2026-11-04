import type { ContractError } from "@bflow/contracts";
import { CLI_EXIT_CODES, type ApproveCardCommandArgs, type CliExitCode } from "./types.js";

type HostOptions = { repositoryPath: string; sessionId: string };

/** D-DIR-02 result of `bflow approve <#n>`; the human decision is recorded and queued by the running host. */
export interface ApproveCardOutput {
  readonly approvalId: string;
  readonly runId: string;
  readonly kind: "approval" | "user_decision";
  readonly queued: true;
  readonly code: string;
  readonly outcome: ApproveCardCommandArgs["outcome"];
  readonly runLabel?: string | undefined;
  readonly selectedOption?: string | undefined;
  readonly alreadyRecorded: boolean;
}

export interface ApproveCardDeps {
  readonly cwd: string;
  readonly identify: (cwd: string) => Promise<{ root: string; sessionName: string }>;
  readonly hostCall: (opts: HostOptions, input: unknown) => Promise<unknown>;
  readonly parseValue: (value: unknown) => ApproveCardOutput;
  readonly pid: number;
  readonly tty: boolean;
}

export async function defaultApproveCardDeps(cwd: string): Promise<ApproveCardDeps> {
  const runtime = await import("@bflow/runtime");
  return {
    cwd,
    identify: async dir => (await import("./repository.js")).identifyRepository(dir),
    hostCall: (opts, input) => runtime.callHumanDecisionHost(opts, input),
    parseValue: value => runtime.HumanDecisionCliValueSchema.parse(value),
    pid: process.pid,
    // Diagnostics only: whether the command came from an interactive terminal.
    tty: Boolean(process.stdin.isTTY)
  };
}

const NO_HOST = "Không có phiên Bflow đang chạy trong kho này; chạy `bflow up` rồi thử lại.";

export function describeApproveCard(output: ApproveCardOutput): string {
  const outcome = output.outcome === "approved" ? "duyệt" : output.outcome === "rejected" ? "từ chối"
    : output.outcome === "changes_requested" ? "yêu cầu sửa"
      : `chọn phương án${output.selectedOption ? ` "${output.selectedOption}"` : ""}`;
  return `Đã ghi quyết định cho thẻ ${output.code}${output.runLabel ? ` (${output.runLabel})` : ""}: ${outcome}.` +
    (output.alreadyRecorded ? " (Quyết định này đã được ghi trước đó; không gửi lại.)" : "");
}

/** Sends the decision to the already running host (owner token); never starts a host or composes a legacy Runtime. */
export async function executeApproveCard(args: ApproveCardCommandArgs, deps: ApproveCardDeps):
  Promise<{ exitCode: CliExitCode; ok: true; data: ApproveCardOutput } | { exitCode: CliExitCode; ok: false; error: ContractError }> {
  let repository: { root: string; sessionName: string };
  try { repository = await deps.identify(deps.cwd); }
  catch (error) {
    return { exitCode: CLI_EXIT_CODES.RUNTIME_ERROR, ok: false,
      error: { code: "validation", retryable: false, message: error instanceof Error ? error.message : String(error) } };
  }
  let raw: unknown;
  try {
    raw = await deps.hostCall({ repositoryPath: repository.root, sessionId: repository.sessionName }, {
      code: args.card, outcome: args.outcome, ...(args.reason !== undefined ? { reason: args.reason } : {}),
      ...(args.choice !== undefined ? { choice: args.choice } : {}), tty: deps.tty, pid: deps.pid });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: CLI_EXIT_CODES.RUNTIME_ERROR, ok: false, error: /Host unavailable|Foreign host/i.test(message)
      ? { code: "transport_unavailable", retryable: true, message: NO_HOST }
      : { code: "transport_unavailable", retryable: true, message } };
  }
  const result = raw as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (result?.ok === true) return { exitCode: CLI_EXIT_CODES.SUCCESS, ok: true, data: deps.parseValue(result.value) };
  const code = result?.error?.code, message = typeof result?.error?.message === "string" ? result.error.message : "Host trả về kết quả không hợp lệ";
  const error: ContractError = code === "not_found" ? { code: "not_found", retryable: false, message }
    : code === "conflict" ? { code: "conflict", retryable: true, message }
      : code === "validation" ? { code: "validation", retryable: false, message }
        : { code: "corruption", retryable: false, message };
  return { exitCode: CLI_EXIT_CODES.RUNTIME_ERROR, ok: false, error };
}
