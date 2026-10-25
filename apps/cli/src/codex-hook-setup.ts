import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  approveCodexHooks,
  trustAllCodexHooks,
  revokeAllCodexHookTrust,
  codexHookPolicyPath,
  CodexHookPolicySchema,
  type CodexHookPolicy,
  CODEX_HOOK_APPROVAL_FILE,
  CodexHookApprovalSchema,
  CodexHookReviewSchema,
  createManagedCodexHookEnvironment,
  defaultCodexHookApprovalPath,
  inspectCodexHooks,
  type CodexHookApproval,
  type CodexHookReview,
  type CodexHookTrustOptions
} from "@bflow/agent-providers";
import { detectPlatform, defaultHostEnvironment } from "@bflow/machine-setup";
import { bold, cyan, greenTick, humanText, readableLabel, sanitizeIdentifier, statusTag } from "./presentation.js";
import { isolatedProviderHomes } from "./setup-defaults.js";
import type { CliContext, SetupCommandArgs } from "./types.js";

export type CodexHookSetupOutcome =
  | "no_hooks"
  | "already_approved"
  | "approval_required"
  | "approval_declined"
  | "approved"
  | "digest_mismatch"
  | "stale_review"
  | "unsupported"
  | "trust_revoked";

export interface CodexHookSetupOutput {
  readonly codexHooks: true;
  readonly mode: "check" | "dry_run" | "apply";
  readonly outcome: CodexHookSetupOutcome;
  readonly review: CodexHookReview;
  readonly approval?: CodexHookApproval | undefined;
  readonly policy?: CodexHookPolicy | undefined;
  readonly message?: string | undefined;
}

export interface CodexHookFormatOptions {
  readonly color?: boolean | undefined;
  readonly debug?: boolean | undefined;
}

function privateReviewText(value: string): string {
  let clean = humanText(value, 16_000);
  clean = clean.replace(/(--?(?:api[-_]?key|access[-_]?token|token|password|passwd|secret|authorization)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi,
    "$1[REDACTED]");
  clean = clean.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[REDACTED]");
  return clean;
}

function privateValue(value: unknown): unknown {
  if (typeof value === "string") return privateReviewText(value);
  if (Array.isArray(value)) return value.map(privateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [privateReviewText(key), privateValue(child)]));
  }
  return value;
}

/** Re-parse the package response at the CLI boundary, then redact strings before terminal or JSON output. */
function safeReview(input: CodexHookReview): CodexHookReview {
  const review = CodexHookReviewSchema.parse(input);
  return CodexHookReviewSchema.parse({
    ...review,
    codexHomeDirectory: sanitizeIdentifier(review.codexHomeDirectory),
    approvalStorePath: sanitizeIdentifier(review.approvalStorePath),
    sources: review.sources.map(source => ({ ...source, path: sanitizeIdentifier(source.path) })),
    hooks: review.hooks.map(hook => ({
      ...hook,
      ...(hook.matcher !== undefined ? { matcher: privateValue(hook.matcher) } : {}),
      command: privateReviewText(hook.command),
      dependencies: hook.dependencies.map(dependency => ({
        ...dependency,
        requestedPath: sanitizeIdentifier(dependency.requestedPath),
        resolvedPath: dependency.resolvedPath === null ? null : sanitizeIdentifier(dependency.resolvedPath)
      }))
    })),
    diagnostics: review.diagnostics.map(privateReviewText),
    unsupportedReasons: review.unsupportedReasons.map(privateReviewText)
  });
}

function trustOptions(context?: CliContext): CodexHookTrustOptions {
  const rawIsolatedRoot = context?.setup?.isolatedRoot ?? process.env["BFLOW_HOME"];
  const isolatedRoot = rawIsolatedRoot ? resolve(rawIsolatedRoot) : undefined;
  const platform = context?.setup?.platform ?? detectPlatform(defaultHostEnvironment());
  const values: Record<string, string | undefined> = {};

  if (isolatedRoot) {
    const homes = isolatedProviderHomes(isolatedRoot);
    const codexHomeDirectory = homes.codexHome ?? join(isolatedRoot, "providers", "codex");
    Object.assign(values, createManagedCodexHookEnvironment(process.env, homes.homeDirectory));
    values["CODEX_HOME"] = codexHomeDirectory;
    const stateDirectory = join(isolatedRoot, "state");
    values["XDG_STATE_HOME"] = stateDirectory;
    return {
      codexHomeDirectory,
      approvalStorePath: join(stateDirectory, CODEX_HOOK_APPROVAL_FILE),
      environment: values
    };
  }

  const homeDirectory = platform.homeDir || process.env["HOME"] || homedir();
  Object.assign(values, createManagedCodexHookEnvironment(process.env, homeDirectory));
  if (process.env["CODEX_HOME"] !== undefined) values["CODEX_HOME"] = process.env["CODEX_HOME"];
  if (process.env["XDG_STATE_HOME"] !== undefined) values["XDG_STATE_HOME"] = process.env["XDG_STATE_HOME"];
  const codexHomeDirectory = resolve(values["CODEX_HOME"] ?? join(homeDirectory, ".codex"));
  values["CODEX_HOME"] = codexHomeDirectory;
  const approvalStorePath = context?.setup?.platform
    ? join(platform.paths.state, CODEX_HOOK_APPROVAL_FILE)
    : defaultCodexHookApprovalPath(values, homeDirectory);
  return {
    codexHomeDirectory,
    approvalStorePath,
    environment: values
  };
}

function translateHookStatus(status: CodexHookReview["status"]): string {
  switch (status) {
    case "approved":
      return "Đã phê duyệt";
    case "approval_required":
      return "Cần phê duyệt";
    case "none":
      return "Không có hook";
    case "unsupported":
      return "Không hỗ trợ";
    default:
      return readableLabel(status);
  }
}

function translateHookOutcome(outcome: CodexHookSetupOutcome): string {
  switch (outcome) {
    case "approved":
      return "Đã phê duyệt";
    case "already_approved":
      return "Đã phê duyệt trước đó";
    case "no_hooks":
      return "Không có hook nào được cấu hình";
    case "approval_required":
      return "Cần phê duyệt";
    case "approval_declined":
      return "Từ chối phê duyệt";
    case "digest_mismatch":
      return "Mã băm không khớp";
    case "stale_review":
      return "Bản chụp đã thay đổi (stale review)";
    case "unsupported":
      return "Không hỗ trợ";
    case "trust_revoked":
      return "Đã thu hồi tin cậy toàn bộ";
    default:
      return readableLabel(outcome);
  }
}

export function formatCodexHookReview(
  reviewInput: CodexHookReview,
  options?: CodexHookFormatOptions | undefined
): string {
  const useColor = Boolean(options?.color);
  const review = safeReview(reviewInput);
  if (review.approvalMode === "trust_all") {
    return [
      "Đánh giá Codex global hooks",
      `Trạng thái: Đã phê duyệt ${greenTick(useColor)}`,
      "Chính sách hook: Tin cậy toàn bộ global hooks hiện tại và tương lai",
      "Thư mục Codex: " + review.codexHomeDirectory,
      "Kho chính sách riêng: " + codexHookPolicyPath(review.approvalStorePath),
      "Mã băm chính sách (Policy digest): " + review.digest,
      ...review.diagnostics
        .filter((diagnostic) => /^(?:warning|cảnh báo):/i.test(diagnostic))
        .map((d) => `Cảnh báo: ${privateReviewText(d.replace(/^(?:warning|cảnh báo):\s*/i, ""))}`),
      "Tất cả global hooks hiện tại và tương lai đã được tin cậy theo chính sách người vận hành; bỏ qua kiểm tra mã nguồn.",
      "Quyền hạn Bflow, các hook bắt buộc, xác thực, sandbox và kiểm tra MCP vẫn giữ nguyên hiệu lực."
    ].join("\n");
  }
  const lines = [
    "Đánh giá Codex global hooks",
    "Trạng thái: " + translateHookStatus(review.status),
    "Thư mục Codex: " + review.codexHomeDirectory,
    "Kho phê duyệt riêng: " + review.approvalStorePath,
    "Mã băm bản chụp (Snapshot digest): " + review.digest,
    ""
  ];
  lines.push("Nguồn cấu hình (" + review.sources.length + "):");
  for (const source of review.sources) {
    lines.push(
      "  - " +
        source.kind +
        ": " +
        source.path +
        " (" +
        (source.exists ? "tồn tại" : "không có") +
        ")" +
        (source.sha256 ? " SHA-256 " + source.sha256 : "")
    );
  }
  lines.push("Danh sách Hooks (" + review.hooks.length + "):");
  for (const hook of review.hooks) {
    lines.push("  - Sự kiện (Event): " + privateReviewText(hook.event));
    if (hook.matcher !== undefined) {
      lines.push("    Bộ lọc (Matcher): " + JSON.stringify(privateValue(hook.matcher)));
    }
    lines.push("    Lệnh (Command): " + privateReviewText(hook.command));
    lines.push("    Mã băm hook (Hook digest): " + hook.digest);
    lines.push("    Phụ thuộc cục bộ đã ghim (" + hook.dependencies.length + "):");
    for (const dependency of hook.dependencies) {
      lines.push(
        "      - " +
          dependency.requestedPath +
          " -> " +
          (dependency.resolvedPath ?? "không có") +
          " (" +
          (dependency.exists ? "tồn tại" : "không có") +
          ")" +
          (dependency.sha256 ? " SHA-256 " + dependency.sha256 : "")
      );
    }
  }
  for (const diagnostic of review.diagnostics) {
    lines.push("Chẩn đoán: " + privateReviewText(diagnostic));
  }
  for (const reason of review.unsupportedReasons) {
    lines.push("Không hỗ trợ: " + privateReviewText(reason));
  }
  lines.push(
    "",
    "Phê duyệt này chỉ áp dụng cho bản chụp (snapshot) Codex hook đã kiểm tra ở trên. Nó không cấp quyền Bflow hay cô lập trình thông dịch hệ thống và dữ liệu runtime tùy ý."
  );
  return lines.join("\n");
}

export function formatCodexHookSetupOutput(
  output: CodexHookSetupOutput,
  options?: boolean | CodexHookFormatOptions | undefined,
  debugArg?: boolean | undefined
): string {
  const useColor = typeof options === "boolean" ? options : Boolean(options?.color);
  const debug =
    typeof options === "object" && options !== null
      ? Boolean(options.debug)
      : Boolean(debugArg);
  const safe = safeReview(output.review);
  if (
    !debug &&
    output.mode !== "dry_run" &&
    ["no_hooks", "already_approved", "approved"].includes(output.outcome)
  ) {
    const title = translateHookOutcome(output.outcome);
    const lines = [
      `Codex global hooks: ${title} ${statusTag("passed", useColor)} ${greenTick(useColor)}`,
      `Thư mục Codex: ${safe.codexHomeDirectory}`,
      safe.approvalMode === "trust_all"
        ? "Phạm vi: Toàn bộ global hooks hiện tại và tương lai"
        : "Phạm vi: Chỉ bản chụp (snapshot) Codex hook đã kiểm tra"
    ];
    if (safe.approvalMode === "trust_all") {
      lines.push("Biên nhận chính sách: " + codexHookPolicyPath(safe.approvalStorePath));
    } else if (output.outcome !== "no_hooks") {
      lines.push("Biên nhận phê duyệt: " + safe.approvalStorePath);
    }
    if (output.message) lines.push(privateReviewText(output.message));
    lines.push(
      ...safe.diagnostics
        .filter((diagnostic) => /^(?:warning|cảnh báo):/i.test(diagnostic))
        .map((d) => `Cảnh báo: ${privateReviewText(d.replace(/^(?:warning|cảnh báo):\s*/i, ""))}`)
    );
    return lines.join("\n");
  }
  const review = formatCodexHookReview(safe, { color: useColor, debug }).split("\n");
  review[0] = useColor ? cyan(bold(review[0]!), true) : review[0]!;
  const isPassed = ["no_hooks", "already_approved", "approved", "trust_revoked"].includes(
    output.outcome
  );
  const state = isPassed
    ? "passed"
    : ["approval_required", "approval_declined"].includes(output.outcome)
    ? "waiting"
    : "failed";
  const lines = [
    review.join("\n"),
    "",
    `Kết quả: ${translateHookOutcome(output.outcome)} ${statusTag(state, useColor)}${
      isPassed ? ` ${greenTick(useColor)}` : ""
    }`
  ];
  if (output.message) lines.push(privateReviewText(output.message));
  if (output.approval) {
    lines.push(
      "Biên nhận phê duyệt: " +
        sanitizeIdentifier(output.approval.approvalStorePath) +
        " (mã băm " +
        output.approval.digest +
        ")"
    );
  }
  if (safe.status === "approval_required") {
    lines.push(
      "👉 Tiếp theo: Kiểm tra kỹ danh sách ở trên, sau đó chạy: bflow setup --codex-hooks --apply --yes --hook-digest " +
        safe.digest
    );
  } else if (safe.status === "unsupported") {
    lines.push(
      "👉 Tiếp theo: Xử lý các nguồn hook không được hỗ trợ ở trên, sau đó chạy lại: bflow setup --codex-hooks --plan"
    );
  }
  return lines.join("\n");
}

function output(mode: CodexHookSetupOutput["mode"], outcome: CodexHookSetupOutcome, review: CodexHookReview,
  message?: string, approval?: CodexHookApproval): CodexHookSetupOutput {
  const safeApproval = approval ? CodexHookApprovalSchema.parse({
    ...CodexHookApprovalSchema.parse(approval),
    codexHomeDirectory: sanitizeIdentifier(approval.codexHomeDirectory),
    approvalStorePath: sanitizeIdentifier(approval.approvalStorePath),
    approvedBy: privateReviewText(approval.approvedBy)
  }) : undefined;
  return {
    codexHooks: true,
    mode,
    outcome,
    review: safeReview(review),
    ...(safeApproval ? { approval: safeApproval } : {}),
    ...(message ? { message: privateReviewText(message) } : {})
  };
}

function canPrompt(args: SetupCommandArgs, context?: CliContext): boolean {
  if (args.json) return false;
  return context?.setup?.confirm !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

async function askForApproval(review: CodexHookReview, context?: CliContext, trustAll = false): Promise<boolean> {
  const text = trustAll
    ? `Tin cậy TOÀN BỘ global hooks hiện tại và tương lai cho ${sanitizeIdentifier(review.codexHomeDirectory)}? Sẽ bỏ qua kiểm tra mã nguồn; các tệp hook và cài đặt provider được giữ nguyên.`
    : formatCodexHookReview(review);
  if (context?.setup?.confirm) {
    context.io?.stderr(text);
    return context.setup.confirm(text);
  }
  process.stderr.write(text + "\n\n");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(y|yes)$/i.test((await terminal.question(trustAll ? "Tin cậy toàn bộ global hooks? [y/N] " : "Phê duyệt chính xác các Codex hooks này? [y/N] ")).trim()); }
  finally { terminal.close(); }
}

async function persistApproval(review: CodexHookReview, expectedDigest: string, options: CodexHookTrustOptions,
  mode: CodexHookSetupOutput["mode"]): Promise<CodexHookSetupOutput> {
  try {
    const approval = await approveCodexHooks(review, { ...options, expectedDigest, approvedBy: "cli-operator" });
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    if (after.digest !== expectedDigest || after.status !== "approved") {
      return output(mode, after.status === "unsupported" ? "unsupported" : "stale_review", after,
        "Trạng thái Codex hook đã thay đổi trước khi xác nhận phê duyệt; vui lòng kiểm tra lại bản chụp mới.");
    }
    return output(mode, "approved", after, "Chỉ bản chụp Codex hook đã kiểm tra mới được phê duyệt.", approval);
  } catch (error) {
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    const changed = after.digest !== expectedDigest;
    return output(mode, after.status === "unsupported" ? "unsupported" : changed ? "stale_review" : "approval_required", after,
      humanText(error instanceof Error ? error.message : String(error), 500));
  }
}

/** Hook-only setup path. It never creates or invokes the general machine setup plan. */
export async function executeCodexHookSetup(args: SetupCommandArgs, context?: CliContext,
  observer?: { step(message: string): void; confirm<T>(action: () => Promise<T>): Promise<T> }): Promise<CodexHookSetupOutput> {
  if (!args.codexHooks) throw new Error("Codex hook setup requires --codex-hooks.");
  if (args.mode === "repair") throw new Error("Codex hook review does not support repair mode.");
  const progress = (message: string) => { try { observer?.step(message); } catch { /* observational only */ } };
  const confirm = (review: CodexHookReview, trustAll = false) => observer
    ? observer.confirm(() => askForApproval(review, context, trustAll)) : askForApproval(review, context, trustAll);
  progress("Inspecting Codex global hooks and approval state...");
  const options = trustOptions(context);
  const review = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
  if ((args.trustAllHooks || args.revokeAllHookTrust) && (args.mode !== "apply" || args.hookDigest !== undefined || (args.trustAllHooks && args.revokeAllHookTrust)))
    throw new Error("Choose one hook policy action with --apply, without --hook-digest.");
  if (args.revokeAllHookTrust) {
    await revokeAllCodexHookTrust(options);
    return output(args.mode, "trust_revoked", await inspectCodexHooks(options), "Đã thu hồi chính sách tin cậy toàn bộ hook; chế độ kiểm tra chính xác từng bản chụp đã hoạt động trở lại.");
  }
  if (args.trustAllHooks) {
    if (review.approvalMode === "trust_all") return output(args.mode, "already_approved", review, "Toàn bộ global hooks hiện tại và tương lai đã được tin cậy trước đó.");
    if (!args.yes) {
      if (!canPrompt(args, context)) return output(args.mode, "approval_required", review,
        "Dùng --trust-all --yes để tin cậy rõ ràng toàn bộ global hooks hiện tại và tương lai, hoặc xác nhận tương tác.");
      if (!(await confirm(review, true))) return output(args.mode, "approval_declined", review,
        "Đã từ chối tin cậy toàn bộ hook; không có chính sách nào được ghi.");
    }
    progress("Saving explicit global-hook trust policy...");
    const policy = CodexHookPolicySchema.parse(await trustAllCodexHooks({ ...options, approvedBy: "cli-operator" }));
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    if (after.status !== "approved" || after.approvalMode !== "trust_all")
      return output(args.mode, "unsupported", after, "Không thể xác nhận chính sách hook tường minh.");
    // The persisted policy was validated above; display sanitization must not fail a completed grant.
    const safePolicy: CodexHookPolicy = { ...policy, codexHomeDirectory: sanitizeIdentifier(policy.codexHomeDirectory),
      approvalStorePath: sanitizeIdentifier(policy.approvalStorePath), approvedBy: privateReviewText(policy.approvedBy) };
    return { ...output(args.mode, "approved", after, "Toàn bộ global hooks hiện tại và tương lai đã được tin cậy; danh sách mã nguồn của chúng không còn chặn khởi động."), policy: safePolicy };
  }

  if (review.status === "unsupported") return output(args.mode, "unsupported", review,
    "Không hỗ trợ kiểm tra bản chụp; trạng thái phê duyệt không thay đổi. Để tin cậy toàn bộ hook hiện tại/tương lai, dùng --apply --trust-all --yes.");
  if (review.status === "none") return output(args.mode, "no_hooks", review, "Không có Codex global hooks nào được cấu hình.");
  if (review.status === "approved") return output(args.mode, "already_approved", review, review.approvalMode === "trust_all"
    ? "Toàn bộ global hooks hiện tại và tương lai đã được tin cậy trước đó." : "Bản chụp Codex hook chính xác này đã được phê duyệt trước đó.");
  if (args.mode !== "apply") return output(args.mode, "approval_required", review, "Dùng --apply để kiểm tra và phê duyệt bản chụp này.");

  // `--yes` is never a substitute for the reviewed digest, even for direct callers bypassing the CLI parser.
  if (args.yes && args.hookDigest === undefined) return output(args.mode, "approval_required", review,
    "Phê duyệt hook không tương tác yêu cầu cả --yes và --hook-digest <mã-băm-chính-xác>.");

  if (args.hookDigest !== undefined) {
    if (!args.yes) return output(args.mode, "approval_required", review, "Phê duyệt không tương tác yêu cầu cả --yes và --hook-digest.");
    if (args.hookDigest !== review.digest) return output(args.mode, "digest_mismatch", review,
      "Mã băm hook cung cấp không khớp với bản chụp hiện tại; không có phê duyệt nào được ghi.");
    progress("Saving approval for the reviewed hook snapshot...");
    return persistApproval(review, args.hookDigest, options, args.mode);
  }

  if (!canPrompt(args, context)) return output(args.mode, "approval_required", review,
    "Phiên này không hỗ trợ hỏi tương tác. Hãy xem kỹ danh sách và chạy lại với --yes --hook-digest <mã-băm-chính-xác>.");
  if (!(await confirm(review))) return output(args.mode, "approval_declined", review,
    "Đã từ chối phê duyệt Codex hook; trạng thái phê duyệt không thay đổi.");
  progress("Saving approval for the reviewed hook snapshot...");
  return persistApproval(review, review.digest, options, args.mode);
}

export function codexHookSetupSucceeded(result: CodexHookSetupOutput): boolean {
  if (result.mode === "dry_run") return true;
  if (result.outcome === "unsupported") return false;
  if (result.mode === "check") return ["no_hooks", "already_approved"].includes(result.outcome);
  return ["no_hooks", "already_approved", "approved", "trust_revoked"].includes(result.outcome);
}
