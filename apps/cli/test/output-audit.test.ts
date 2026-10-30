import { describe, expect, it } from "vitest";
import { EnvironmentDoctorReportSchema, SetupReceiptSchema } from "@bflow/contracts";
import type { DocsFailureKind } from "@bflow/docs-retrieval";
import { formatCommandError, formatCommandSuccess, formatEnvironmentStatus } from "../src/formatters.js";
import { stripAnsi } from "../src/presentation.js";
import type { EnvironmentStatus } from "../src/environment.js";
import type { SetupCommandOutput } from "../src/types.js";

const status: EnvironmentStatus = { workspaceRoot: "/work/shop", sessionName: "shop", server: "stopped", configuration: "valid", manifest: null, liveObservation: false, issues: [] };

describe("CLI output audit", () => {
  it.each([
    [{ ...status }, "bflow up"],
    [{ ...status, server: "unknown" as const, issues: ["Server observation failed"] }, "bflow doctor"],
    [{ ...status, server: "running" as const, issues: ["Agent health unavailable"] }, "bflow doctor"]
  ])("never labels incomplete environment observations healthy", (data, next) => {
    const text = formatEnvironmentStatus(data);
    expect(text).not.toContain("[OK]");
    expect(text).toContain(next);
    for (const issue of data.issues) expect(text).toContain(issue);
    expect(text).toContain("persisted (may be stale)");
  });

  it("shows doctor failures once and keeps all failures ahead of healthy detail, including skipped and legacy checks", () => {
    const healthy = Array.from({ length: 25 }, (_, i) => ({ checkId: `tool-${i}`, component: `tool-${i}`, status: "pass", reason: `Internal successful probe ${i}`, remediation: "" }));
    const report = EnvironmentDoctorReportSchema.parse({ schemaVersion: 2, workspaceRoot: "/work/shop", healthy: false, checkedAt: "2026-10-20T00:00:00.000Z",
      checks: [...healthy.map(check => ({ checkId: check.checkId, name: check.component, status: "passed", message: check.reason })),
        { checkId: "broken", name: "broken", status: "failed", message: "Pinned binary changed", remediation: "Review the tool installation" },
        { checkId: "legacy", name: "legacy", status: "warn", message: "Legacy session needs reconciliation", remediation: "Run bflow doctor --json" }],
      metadata: { groups: { tools: [...healthy, { checkId: "broken", component: "broken", status: "fail", reason: "Pinned binary changed", remediation: "Review the tool installation" },
        { checkId: "optional", component: "optional", status: "skipped", reason: "Optional backend disabled", remediation: "" }] } }
    });
    const text = formatCommandSuccess("doctor", report, false);
    expect(text.match(/Pinned binary changed/g)).toHaveLength(1);
    expect(text).not.toContain("Internal successful probe");
    for (const value of ["Review the tool installation", "Legacy session needs reconciliation", "[BỎ QUA] optional: Optional backend disabled", "Đạt (25): tool-0, tool-1"]) expect(text).toContain(value);
    expect(stripAnsi(formatCommandSuccess("doctor", report, false, { color: true }))).toBe(text);
    expect(formatCommandSuccess("doctor", report, false, { color: true })).toContain("\x1b[31m");
    expect(JSON.parse(formatCommandSuccess("doctor", report, true)).data).toEqual(report);
  });

  it("retains every skipped doctor check identity, reason and action", () => {
    const checks = Array.from({ length: 10 }, (_, i) => ({ checkId: `deepwiki-check-${i}`, component: "deepwiki", status: "skipped",
      reason: `Documentation check ${i} was not requested`, remediation: `Inspect documentation setting ${i}` }));
    checks[0] = { checkId: "deepwiki-enabled", component: "deepwiki", status: "skipped",
      reason: "DeepWiki is not enabled for this repository (environment.deepwiki.enabled).",
      remediation: "Set environment.deepwiki.enabled: true in .bflow/config.yml to let granted roles read public repository documentation." };
    const report = EnvironmentDoctorReportSchema.parse({ schemaVersion: 2, workspaceRoot: "/work/shop", healthy: true,
      checkedAt: "2026-10-20T00:00:00.000Z", checks: [{ checkId: "node", name: "Node", status: "passed", message: "Node available" }], metadata: { groups: { mcp: checks } } });
    const output = formatCommandSuccess("doctor", report, false);
    for (const check of checks) for (const detail of [check.checkId, check.reason, check.remediation]) expect(output).toContain(detail);
    expect(JSON.parse(formatCommandSuccess("doctor", report, true)).data).toEqual(report);
  });

  it.each([
    ["auth_invalid", "needs no credential"],
    ["auth_missing", "needs no credential"],
    ["version_not_found", "bflow docs structure"],
    ["library_not_found", "bflow docs structure"],
    ["permission_denied", "grant"],
    ["network", "bflow docs status"],
    ["protocol", "bflow docs status"],
    ["rate_limited", "wait"]
  ] as const)("offers a specific next step for docs %s without changing JSON", (kind: DocsFailureKind, next) => {
    const output = { docs: true as const, action: "ask" as const, ok: false, access: { mode: "none" as const, reason: "Documentation access unavailable" }, warnings: [],
      failure: { kind, message: "Documentation request failed", retryable: false, retryAfterMs: kind === "rate_limited" ? 5000 : undefined, availableVersions: kind === "version_not_found" ? ["v1", "v2"] : undefined } };
    const text = formatCommandSuccess("docs", output, false);
    expect(text).toContain("Next:");
    expect(text.toLowerCase()).toContain(next.toLowerCase());
    if (kind === "rate_limited") expect(text).toContain("5s");
    expect(JSON.parse(formatCommandSuccess("docs", output, true)).data).toEqual(JSON.parse(JSON.stringify(output)));
  });

  it("gives path-permission and input-file advice while preserving uncertain-delivery priority", () => {
    const permission = { code: "validation" as const, retryable: false, message: "EACCES: permission denied, open '/work/file'" };
    expect(formatCommandError(permission, "init", false)).toMatch(/👉 Tiếp theo:.*quyền sở hữu/i);
    const input = { ...permission, message: "ENOENT: no such file or directory, open '/work/spec.json'" };
    expect(formatCommandError(input, "run", false)).toMatch(/👉 Tiếp theo:.*đường dẫn tệp đầu vào/i);
    expect(formatCommandError({ ...permission, code: "unknown_delivery", manualInterventionRequired: true }, "up", false)).toMatch(/👉 Tiếp theo:.*đối soát/i);
  });

  it("summarizes successful setup bookkeeping but retains failed receipts and warnings", () => {
    const output: SetupCommandOutput = { mode: "apply", machineId: "internal-machine-id", os: "linux", serviceManagerKind: "systemd-user", outcome: "applied",
      plan: { schemaVersion: 3, planId: "internal-plan-id", machineId: "internal-machine-id", revision: 1, planDigest: "a".repeat(64), createdAt: "2026-10-20T00:00:00.000Z", idempotencyKey: "internal-key", steps: [] },
      tools: [{ toolId: "git", status: "present", version: "2" }, { toolId: "node", status: "present", version: "22" }],
      skills: { catalogLoaded: true, skillCount: 32, syncedManifests: 8, storeRoot: "/private/skills-store" }, diagnostics: ["Setup completed successfully", "License: Review the installed tool's terms"] };
    const text = formatCommandSuccess("setup", output, false);
    for (const hidden of ["internal-machine-id", "internal-plan-id", "/private/skills-store", "Setup completed successfully"]) expect(text).not.toContain(hidden);
    expect(text).toContain("License:");
    expect(text).toContain("2/2 sẵn sàng");
    expect(text).toContain("bflow doctor");
    expect(JSON.parse(formatCommandSuccess("setup", output, true)).data).toEqual(output);
  });

  it("retains successful receipt warnings and reconciliation evidence in concise setup output", () => {
    const receipt = SetupReceiptSchema.parse({ schemaVersion: 3, receiptId: "receipt-warning", planId: "setup-plan",
      planDigest: "a".repeat(64), stepId: "configure:path", scope: { kind: "machine", machineId: "machine" }, status: "applied",
      desiredStateDigest: "b".repeat(64), observedStateDigest: "b".repeat(64), ownedPaths: [], observedAt: "2026-10-20T00:00:00.000Z",
      diagnostics: ["reconciled after interruption", "journal could not be updated: disk full", "Warning token=secret\u001b[31m"], idempotencyKey: "setup-key" });
    const output: SetupCommandOutput = { mode: "apply", machineId: "machine", os: "linux", serviceManagerKind: "systemd-user", outcome: "applied",
      plan: { schemaVersion: 3, planId: "setup-plan", machineId: "machine", revision: 1, planDigest: "a".repeat(64),
        createdAt: "2026-10-20T00:00:00.000Z", idempotencyKey: "setup-key", steps: [] },
      receipt, receipts: [receipt], skills: { catalogLoaded: true, skillCount: 1, syncedManifests: 1, storeRoot: "/skills" },
      diagnostics: ["Setup completed successfully", "reconciled after interruption"] };
    const text = formatCommandSuccess("setup", output, false);
    expect(text).toContain("journal could not be updated: disk full");
    expect(text).toContain("configure:path");
    expect(text.match(/reconciled after interruption/g)).toHaveLength(1);
    expect(text).toContain("token=[REDACTED]");
    expect(text).not.toMatch(/secret|\u001b/);
    expect(stripAnsi(formatCommandSuccess("setup", output, false, { color: true }))).toBe(text);
    expect(JSON.parse(formatCommandSuccess("setup", output, true)).data).toEqual(output);
  });
});
