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
import { bold, cyan, humanText, readableLabel, sanitizeIdentifier, statusTag } from "./presentation.js";
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

export function formatCodexHookReview(reviewInput: CodexHookReview): string {
  const review = safeReview(reviewInput);
  if (review.approvalMode === "trust_all") return [
    "Codex global hook review", "Status: approved", "Hook policy: trust all current and future global hooks",
    "Codex home: " + review.codexHomeDirectory,
    "Private policy store: " + codexHookPolicyPath(review.approvalStorePath),
    "Policy digest: " + review.digest,
    ...review.diagnostics.filter(diagnostic => diagnostic.startsWith("Warning:")).map(privateReviewText),
    "All current and future global hooks are trusted by operator policy; source inspection is skipped.",
    "Bflow permissions, required hooks, auth, sandbox and MCP checks remain in effect."
  ].join("\n");
  const lines = [
    "Codex global hook review",
    "Status: " + readableLabel(review.status),
    "Codex home: " + review.codexHomeDirectory,
    "Private approval store: " + review.approvalStorePath,
    "Snapshot digest: " + review.digest,
    ""
  ];
  lines.push("Sources (" + review.sources.length + "):");
  for (const source of review.sources) {
    lines.push("  - " + source.kind + ": " + source.path + " (" + (source.exists ? "present" : "absent") + ")" +
      (source.sha256 ? " SHA-256 " + source.sha256 : ""));
  }
  lines.push("Hooks (" + review.hooks.length + "):");
  for (const hook of review.hooks) {
    lines.push("  - Event: " + privateReviewText(hook.event));
    if (hook.matcher !== undefined) lines.push("    Matcher: " + JSON.stringify(privateValue(hook.matcher)));
    lines.push("    Command: " + privateReviewText(hook.command));
    lines.push("    Hook digest: " + hook.digest);
    lines.push("    Pinned local dependencies (" + hook.dependencies.length + "):");
    for (const dependency of hook.dependencies) {
      lines.push("      - " + dependency.requestedPath + " -> " + (dependency.resolvedPath ?? "absent") +
        " (" + (dependency.exists ? "present" : "absent") + ")" +
        (dependency.sha256 ? " SHA-256 " + dependency.sha256 : ""));
    }
  }
  for (const diagnostic of review.diagnostics) lines.push("Diagnostic: " + privateReviewText(diagnostic));
  for (const reason of review.unsupportedReasons) lines.push("Unsupported: " + privateReviewText(reason));
  lines.push("", "Approval covers only this inspected Codex hook snapshot. It does not grant Bflow permissions or isolate system interpreters and arbitrary runtime data.");
  return lines.join("\n");
}

export function formatCodexHookSetupOutput(output: CodexHookSetupOutput, useColor = false): string {
  const review = formatCodexHookReview(output.review).split("\n");
  review[0] = useColor ? cyan(bold(review[0]!), true) : review[0]!;
  const state = ["no_hooks", "already_approved", "approved", "trust_revoked"].includes(output.outcome) ? "passed"
    : ["approval_required", "approval_declined"].includes(output.outcome) ? "waiting" : "failed";
  const lines = [review.join("\n"), "", "Result: " + readableLabel(output.outcome) + " " + statusTag(state, useColor)];
  if (output.message) lines.push(privateReviewText(output.message));
  if (output.approval) lines.push("Approval receipt: " + output.approval.approvalStorePath + " (digest " + output.approval.digest + ")");
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
    ? `Trust ALL current and future global hooks for ${sanitizeIdentifier(review.codexHomeDirectory)}? Source inspection will be skipped; hook files and provider settings are preserved.`
    : formatCodexHookReview(review);
  if (context?.setup?.confirm) {
    context.io?.stderr(text);
    return context.setup.confirm(text);
  }
  process.stderr.write(text + "\n\n");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(y|yes)$/i.test((await terminal.question(trustAll ? "Trust all global hooks? [y/N] " : "Approve these exact Codex hooks? [y/N] ")).trim()); }
  finally { terminal.close(); }
}

async function persistApproval(review: CodexHookReview, expectedDigest: string, options: CodexHookTrustOptions,
  mode: CodexHookSetupOutput["mode"]): Promise<CodexHookSetupOutput> {
  try {
    const approval = await approveCodexHooks(review, { ...options, expectedDigest, approvedBy: "cli-operator" });
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    if (after.digest !== expectedDigest || after.status !== "approved") {
      return output(mode, after.status === "unsupported" ? "unsupported" : "stale_review", after,
        "Codex hook state changed before approval could be confirmed; review the new snapshot.");
    }
    return output(mode, "approved", after, "Only the inspected Codex hook snapshot was approved.", approval);
  } catch (error) {
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    const changed = after.digest !== expectedDigest;
    return output(mode, after.status === "unsupported" ? "unsupported" : changed ? "stale_review" : "approval_required", after,
      humanText(error instanceof Error ? error.message : String(error), 500));
  }
}

/** Hook-only setup path. It never creates or invokes the general machine setup plan. */
export async function executeCodexHookSetup(args: SetupCommandArgs, context?: CliContext): Promise<CodexHookSetupOutput> {
  if (!args.codexHooks) throw new Error("Codex hook setup requires --codex-hooks.");
  if (args.mode === "repair") throw new Error("Codex hook review does not support repair mode.");
  const options = trustOptions(context);
  const review = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
  if ((args.trustAllHooks || args.revokeAllHookTrust) && (args.mode !== "apply" || args.hookDigest !== undefined || (args.trustAllHooks && args.revokeAllHookTrust)))
    throw new Error("Choose one hook policy action with --apply, without --hook-digest.");
  if (args.revokeAllHookTrust) {
    await revokeAllCodexHookTrust(options);
    return output(args.mode, "trust_revoked", await inspectCodexHooks(options), "All-hook trust was revoked; exact snapshot review is active again.");
  }
  if (args.trustAllHooks) {
    if (review.approvalMode === "trust_all") return output(args.mode, "already_approved", review, "All current and future global hooks are already trusted.");
    if (!args.yes) {
      if (!canPrompt(args, context)) return output(args.mode, "approval_required", review,
        "Use --trust-all --yes to explicitly trust all current and future global hooks, or confirm interactively.");
      if (!(await askForApproval(review, context, true))) return output(args.mode, "approval_declined", review,
        "All-hook trust was declined; no policy was written.");
    }
    const policy = CodexHookPolicySchema.parse(await trustAllCodexHooks({ ...options, approvedBy: "cli-operator" }));
    const after = CodexHookReviewSchema.parse(await inspectCodexHooks(options));
    if (after.status !== "approved" || after.approvalMode !== "trust_all")
      return output(args.mode, "unsupported", after, "The explicit hook policy could not be confirmed.");
    // The persisted policy was validated above; display sanitization must not fail a completed grant.
    const safePolicy: CodexHookPolicy = { ...policy, codexHomeDirectory: sanitizeIdentifier(policy.codexHomeDirectory),
      approvalStorePath: sanitizeIdentifier(policy.approvalStorePath), approvedBy: privateReviewText(policy.approvedBy) };
    return { ...output(args.mode, "approved", after, "All current and future global hooks are trusted; their source inventory no longer blocks startup."), policy: safePolicy };
  }

  if (review.status === "unsupported") return output(args.mode, "unsupported", review,
    "Snapshot review is unsupported; no approval state was changed. To trust all current/future hooks explicitly, use --apply --trust-all --yes.");
  if (review.status === "none") return output(args.mode, "no_hooks", review, "No Codex global hooks are configured.");
  if (review.status === "approved") return output(args.mode, "already_approved", review, review.approvalMode === "trust_all"
    ? "All current and future global hooks are already trusted." : "This exact Codex hook snapshot is already approved.");
  if (args.mode !== "apply") return output(args.mode, "approval_required", review, "Use --apply to review this snapshot for approval.");

  // `--yes` is never a substitute for the reviewed digest, even for direct callers bypassing the CLI parser.
  if (args.yes && args.hookDigest === undefined) return output(args.mode, "approval_required", review,
    "Non-interactive hook approval requires both --yes and --hook-digest <exact snapshot digest>.");

  if (args.hookDigest !== undefined) {
    if (!args.yes) return output(args.mode, "approval_required", review, "Non-interactive approval requires both --yes and --hook-digest.");
    if (args.hookDigest !== review.digest) return output(args.mode, "digest_mismatch", review,
      "The supplied hook digest does not match the current reviewed snapshot; no approval was written.");
    return persistApproval(review, args.hookDigest, options, args.mode);
  }

  if (!canPrompt(args, context)) return output(args.mode, "approval_required", review,
    "This session cannot prompt. Review the inventory and rerun with --yes --hook-digest <exact snapshot digest>.");
  if (!(await askForApproval(review, context))) return output(args.mode, "approval_declined", review,
    "Codex hook approval was declined; no approval state was written.");
  return persistApproval(review, review.digest, options, args.mode);
}

export function codexHookSetupSucceeded(result: CodexHookSetupOutput): boolean {
  if (result.mode === "dry_run") return true;
  if (result.outcome === "unsupported") return false;
  if (result.mode === "check") return ["no_hooks", "already_approved"].includes(result.outcome);
  return ["no_hooks", "already_approved", "approved", "trust_revoked"].includes(result.outcome);
}
