import { describe, expect, it } from "vitest";
import { formatCommandError } from "../src/formatters.js";
import { resolveActionableRemediation } from "../src/presentation.js";

describe("provider readiness diagnostics", () => {
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
    expect(resolveActionableRemediation({ code: "unknown_delivery", retryable: false, message }, "up")).toContain("reconcile");
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
