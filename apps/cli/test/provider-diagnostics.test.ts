import { describe, expect, it } from "vitest";
import { formatCommandError } from "../src/formatters.js";
import { resolveActionableRemediation } from "../src/presentation.js";
import { formatPlatformNotReady } from "../src/platform-options.js";

const affectedRoles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"];
const hookCause = "Global Codex hook configuration cannot be safely reviewed: Cannot inspect enabled plugin agy@agy-staff: Plugin installation has unsafe ownership or permissions";
const hookRemediation = "Use supported literal hook commands and inspect the reported dependencies. Or explicitly choose `bflow setup --codex-hooks --apply --trust-all --yes`.";

function sharedHookFailure(): string {
  return formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: affectedRoles.map(role => ({
    role, provider: "codex", required: true, status: "blocked", message: "Provider codex preflight health is blocked (authentication:codex_global_hooks_unsupported, permissions:codex_global_hooks_unsupported, launch_arguments:codex_global_hooks_unsupported)",
    checks: ["authentication", "permissions", "launch_arguments"].map(check => ({ check, status: "failed", code: "codex_global_hooks_unsupported",
      message: check === "authentication" ? `Provider execution probe was skipped because inherited state is blocked: ${hookCause}` : hookCause,
      remediation: hookRemediation }))
  })) }) + "\nAutomatic cleanup completed successfully.";
}

describe("provider readiness diagnostics", () => {
  it("groups the shared seven-role hook failure into one cause with the affected roles and a safe next step", () => {
    const text = formatCommandError({ code: "validation", retryable: false, message: sharedHookFailure() }, "up", false);
    expect(text.match(/Plugin installation has unsafe ownership or permissions/g)).toHaveLength(1);
    expect(text.match(/agy@agy-staff/g)).toHaveLength(1);
    expect(text).toContain("Vai trò bị ảnh hưởng (7): conversation, coordinator, planner, architect, specifier, reviewer, qa");
    expect(text).toContain("Kiểm tra bị chặn: authentication, permissions, launch arguments");
    expect(text.match(/codex_global_hooks_unsupported/g)).toHaveLength(1);
    expect(text).toContain("Chưa có khung pane nào được mở.");
    expect(text).toContain("Automatic cleanup completed successfully.");
    expect(text).toContain("bflow setup --codex-hooks --plan");
    expect(text).not.toContain("--trust-all");
    expect(text.split("\n").length).toBeLessThan(16);
  });

  it("keeps different failures, providers, optional roles and cleanup failures visible", () => {
    const report = formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: [
      { role: "conversation", provider: "codex", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "auth_expired", message: "OAuth access token expired", remediation: "Run codex login" }] },
      { role: "reviewer", provider: "codex", required: false, status: "unsupported", checks: [{ check: "permissions", status: "failed", code: "permission_denied", message: "Workspace trust required", remediation: "Review workspace trust" }] },
      { role: "qa", provider: "agy", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "auth_expired", message: "OAuth access token expired", remediation: "Check Agy authentication" }] }
    ] });
    const text = formatCommandError({ code: "validation", retryable: false, message: report + "\nAutomatic cleanup failed: host still running." }, "up", false);
    expect(text).toContain("Vai trò bị ảnh hưởng (1): conversation");
    expect(text).toContain("reviewer (tùy chọn, unsupported)");
    expect(text).toContain("Vai trò bị ảnh hưởng (1): qa");
    for (const value of ["codex", "agy", "auth_expired", "permission_denied", "Workspace trust required", "Run codex login", "Check Agy authentication", "Automatic cleanup failed: host still running."]) expect(text).toContain(value);
  });

  it("preserves the complete original readiness report in JSON", () => {
    const error = { code: "validation" as const, retryable: false, message: sharedHookFailure(), details: { stage: "preflight" } };
    expect(JSON.parse(formatCommandError(error, "up", true))).toEqual({ ok: false, command: "up", error });
  });

  it("keeps different causes with the same provider, code and remedy separate, including extra role context", () => {
    const message = formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: [
      { role: "conversation", provider: "codex", required: true, status: "blocked", message: "Conversation needs a fresh login receipt", checks: [{ check: "authentication", status: "failed", code: "probe_failed", message: "Network unreachable", remediation: "Check connectivity" }] },
      { role: "qa", provider: "codex", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "probe_failed", message: "Model endpoint unavailable", remediation: "Check connectivity" }] }
    ] });
    const text = formatCommandError({ code: "validation", retryable: false, message }, "up", false);
    for (const value of ["Network unreachable", "Model endpoint unavailable", "Conversation needs a fresh login receipt"]) expect(text).toContain(value);
    expect(text.match(/Mã lỗi: probe_failed/g)).toHaveLength(2);
  });

  it("retains unknown report content rather than silently dropping it during grouping", () => {
    const message = sharedHookFailure() + "\nNew diagnostic field: preserve this context";
    const text = formatCommandError({ code: "validation", retryable: false, message }, "up", false);
    expect(text).toContain("New diagnostic field: preserve this context");
    expect(text).toContain("Blocked roles:");
  });

  it("bounds many distinct grouped failures and keeps a visible truncation notice", () => {
    const message = formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: Array.from({ length: 60 }, (_, index) => ({
      role: `role-${index}`, provider: "codex", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "probe_failed", message: `Distinct failure ${index}`, remediation: "Check provider status" }]
    })) });
    const text = formatCommandError({ code: "validation", retryable: false, message: message + "\nAutomatic cleanup failed: host still running." }, "up", false);
    expect(text).toContain("truncated");
    expect(text).toContain("Automatic cleanup failed: host still running.");
    expect(text.split("\n").length).toBeLessThanOrEqual(260);
    expect(text.length).toBeLessThan(65_000);
  });

  it("preserves specific safe hook recovery instructions for snapshot drift", () => {
    const message = formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: [
      { role: "conversation", provider: "codex", required: true, status: "blocked", checks: [{ check: "permissions", status: "failed", code: "codex_global_hooks_snapshot_drift", message: "Prepared Codex hook snapshot cannot be verified", remediation: "Prepare a new launch and re-run provider activation after the exact hook inventory is approved." }] }
    ] });
    const text = formatCommandError({ code: "validation", retryable: false, message }, "up", false);
    expect(text).toContain("Prepare a new launch and re-run provider activation");
  });

  it("redacts secrets and terminal controls before grouping without collapsing different remedies", () => {
    const report = formatPlatformNotReady({ ready: false, generation: 1, checkedAt: "2026-10-20T00:00:00.000Z", roles: [
      { role: "conversation", provider: "codex", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "probe_failed", message: '\u001b[31mUpstream failed SERVICE_TOKEN="private\ncredential-tail"\u001b[0m', remediation: "Check account A" }] },
      { role: "qa", provider: "codex", required: true, status: "blocked", checks: [{ check: "authentication", status: "failed", code: "probe_failed", message: '\u001b[31mUpstream failed SERVICE_TOKEN="private\ncredential-tail"\u001b[0m', remediation: "Check account B" }] }
    ] });
    const text = formatCommandError({ code: "validation", retryable: false, message: report }, "up", false);
    expect(text).not.toMatch(/private|credential-tail|\u001b/);
    expect(text).toContain("REDACTED");
    expect(text).toContain("Check account A");
    expect(text).toContain("Check account B");
    expect(text.match(/Vai trò bị ảnh hưởng \(1\)/g)).toHaveLength(2);
  });

  it.each([
    '--password "first credential-tail"',
    '--password "first credential-tail',
    "SERVICE_TOKEN='first credential-tail'",
    'SERVICE_TOKEN="first credential-tail',
    '--password "first credential-tail\\',
    '{"access_token":"first credential-tail"}',
    '{"password":"first credential-tail"}',
    '{"client_secret":"first credential-tail"}'
  ])("redacts quoted credential tails even in incomplete diagnostic text: %s", (input) => {
    const message = "Provider readiness is not satisfied; no panes were started.\n" + input;
    expect(formatCommandError({ code: "validation", retryable: false, message }, "up", false)).not.toContain("credential-tail");
  });
  it("redacts command-line credentials inside a full readiness report", () => {
    const message = 'Provider readiness is not satisfied; no panes were started.\n  codex: failed --password "synthetic-private-password" --api-key=synthetic-private-key';
    const text = formatCommandError({ code: "validation", retryable: false, message }, "up", false);
    expect(text).not.toContain("synthetic-private-password");
    expect(text).not.toContain("synthetic-private-key");
    expect(text).toContain("REDACTED");
  });
  it("retains the binary cause and last blocked role in human output while redacting credentials", () => {
    const checks = Array.from({ length: 12 }, (_, index) => `  role-${index}: hooks blocked; token=private-token-value`);
    const text = formatCommandError({ code: "validation", retryable: false,
      message: ["Provider readiness is not satisfied; no panes were started.", "Blocked roles:",
        "  binary (binary_untrusted): Executable '/trusted/codex' is group/world writable (777)", ...checks].join("\n") }, "up", false);
    expect(text).toContain("group/world writable (777)");
    expect(text).toContain("role-11");
    expect(text).not.toContain("private-token-value");
  });
  it("points hook failures to their review while retaining uncertain-delivery priority", () => {
    const message = "Provider readiness is not satisfied; no panes were started.\ncodex_global_hooks_unsupported";
    expect(resolveActionableRemediation({ code: "validation", retryable: false, message }, "up")).toContain("setup --codex-hooks --plan");
    expect(resolveActionableRemediation({ code: "unknown_delivery", retryable: false, message }, "up")).toContain("đối soát");
  });
  it("bounds a large readiness report after redaction without terminal controls", () => {
    const message = "Provider readiness is not satisfied; no panes were started.\n" + "\u001b[2Jtoken=hidden-value\n".repeat(500);
    const text = formatCommandError({ code: "validation", retryable: false, message }, "up", false);
    expect(text).toContain("truncated");
    expect(text).not.toContain("hidden-value");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(65_000);
  });
});
