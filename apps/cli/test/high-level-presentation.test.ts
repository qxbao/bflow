import { describe, expect, it } from "vitest";
import { buildEnvelope, type CommandReport } from "../src/high-level/envelope.js";
import { formatHighLevelHuman } from "../src/high-level/presentation.js";
import { getHighLevelHelp } from "../src/high-level/help.js";
import { stripAnsi } from "../src/presentation.js";

const identity = { commandId: "command-original", correlationId: "correlation-original" };
const envelope = (report: Partial<CommandReport> = {}) => buildEnvelope(identity, {
  command: "tool.status", outcome: "ready", status: "succeeded", exitCode: 0,
  steps: [{ id: "probe-tools", status: "succeeded" }], data: {},
  idempotencyKey: "key-original", ...report
}, "2026-10-20T00:00:00Z");
const render = (report: Partial<CommandReport> = {}) => formatHighLevelHuman(envelope(report));
const healthyTools = Array.from({ length: 25 }, (_, i) => ({ toolId: `healthy-${i}`, status: "present", version: "1", path: `/bin/tool-${i}` }));

describe("high-level result presentation", () => {
  it("leads with the verdict, keeps operational IDs and condenses healthy inventories without mutating JSON", () => {
    const original = envelope({ runId: "run-original", taskId: "task-original", data: { tools: healthyTools } });
    const before = JSON.stringify(original);
    const text = formatHighLevelHuman(original);
    expect(text.split("\n")[0]).toBe("bflow tool status: ready [OK]");
    expect(text).toContain("Run ID: run-original");
    expect(text).toContain("Task ID: task-original");
    expect(text).toContain("25 healthy");
    expect(text).not.toMatch(/Command status:|Exit code:|Command ID:|Correlation ID:|Idempotency key:|Steps:|probe tools|\/bin\/tool/);
    expect(text.split("\n").length).toBeLessThan(12);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.result.commandId).toBe(identity.commandId);
    expect(original.result.correlationId).toBe(identity.correlationId);
    expect(original.result.output).toMatchObject({ ids: { idempotencyKey: "key-original" }, data: { tools: healthyTools } });
  });

  it("shows every unhealthy tool, including optional failures, beyond any healthy inventory cap", () => {
    const text = render({ data: { tools: [...healthyTools, ...Array.from({ length: 24 }, (_, i) => ({
      toolId: `optional-${i}`, status: "missing", required: false, remediation: `Repair optional-${i}`,
      diagnostics: Array.from({ length: 12 }, (_, j) => `diagnostic-${i}-${j}`)
    }))] } });
    for (let i = 0; i < 24; i++) expect(text).toContain(`Repair optional-${i}`);
    expect(text).toContain("diagnostic-23-11");
    expect(text).toContain("--json");
    expect(text).toContain("optional");
  });

  it("shows late unhealthy backends, provider checks and failed/blocked/skipped steps", () => {
    const steps: CommandReport["steps"] = [...healthyTools.map(t => ({ id: t.toolId, status: "succeeded" as const })),
      { id: "late-failure", status: "failed", message: "Cleanup failed" },
      { id: "late-blocked", status: "blocked", message: "Approval pending" },
      { id: "late-skipped", status: "skipped", message: "Runner unavailable" }];
    for (const command of ["mcp.status", "agent.check"] as const) {
      const records = [...healthyTools.map(t => ({ serviceId: t.toolId, check: t.toolId, state: "healthy", status: "passed" })),
        { serviceId: "late-backend", check: "late-check", state: "unknown", status: "unsupported", reason: "Cannot prove health", message: "Cannot prove health" }];
      const text = render({ command, outcome: "not_ready", exitCode: 3, steps, data: { backends: records, checks: records } });
      expect(text).toContain("Cannot prove health");
      expect(text).toContain("Cleanup failed");
      expect(text).toContain("Approval pending");
      expect(text).toContain("Runner unavailable");
      expect(text).not.toContain("Command status: [SUCCEEDED]");
      expect(text.split("\n")[0]).toContain("[FAIL]");
    }
  });

  it("retains replay and reconciliation receipts and only suggests supported resume flags", () => {
    for (const command of ["task.implement", "git.prepare", "skills.sync", "verify"] as const) {
      const text = render({ command, outcome: "reconciliation_required", status: "unknown", exitCode: 7, replayed: true });
      expect(text).toContain("Replayed receipt; no work repeated");
      expect(text).toContain("Idempotency key: key-original");
      expect(text).toContain("receipt");
      expect(text).toMatch(/reconcil/i);
      if (command === "verify") expect(text).not.toContain("--resume");
      else expect(text).toContain("--resume");
    }
  });

  it("prioritizes uncertain delivery over input repair suggestions", () => {
    const text = render({ command: "git.prepare", outcome: "reconciliation_required", status: "unknown", exitCode: 7,
      error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true, message: "Delivery is uncertain", details: { reason: "invalid_json" } } });
    expect(text).toContain("reconcile the existing receipt");
    expect(text).toContain("--resume");
    expect(text).not.toContain("Fix the input JSON");
  });

  it("keeps every traceability blocker and integration conflict path", () => {
    const blockers = Array.from({ length: 24 }, (_, i) => `missing-${i}`);
    const plan = render({ command: "task.plan", outcome: "failed", status: "failed", exitCode: 1,
      error: { code: "validation", retryable: false, message: "Traceability is incomplete" },
      data: { traceability: { valid: false, orphanCriterionIds: blockers } } });
    const conflict = render({ command: "git.prepare", outcome: "conflict_detected", exitCode: 6,
      data: { integration: { conflict: { taskKey: "task-conflict", paths: blockers.map(id => `/work/my  repo/${id}.ts`) } } } });
    for (const blocker of blockers) {
      expect(plan).toContain(blocker);
      expect(conflict).toContain(`/work/my  repo/${blocker}.ts`);
    }
  });

  it("keeps successful reconciliation receipts and suppresses ordinary no-op synchronization steps", () => {
    const text = render({ command: "skills.sync", outcome: "already_synced", data: { reconciled: true },
      steps: [{ id: "sync", status: "skipped", message: "Skills already match the pinned manifest" }] });
    expect(text).toContain("reconciled");
    expect(text).toContain("Idempotency key: key-original");
    expect(text).not.toContain("Steps needing attention:");
  });

  const verification = {
    status: "failed", evaluatedCriteria: [{ criterionId: "AC-broken", passed: false, summary: "Expected retry fence", evidenceArtifactId: "ev-1" }],
    evidenceArtifacts: [{ artifactId: "ev-1", uri: "artifact://run-original/ev-1" }],
    findings: [...Array.from({ length: 22 }, (_, i) => ({ severity: "info", message: `routine-${i}` })),
      { severity: "error", code: "FENCE_BROKEN", location: "/work/my  repo/core.ts:23", message: "Stale fence accepted", artifactId: "ev-1" }]
  };

  it.each([{ status: "escalated", iteration: 2, maxIterations: 3 }, { status: "rework_required", iteration: 3, maxIterations: 3 }])(
    "retains failed criteria, finding locations and evidence; escalates without blind retries for %j", cycle => {
      const text = render({ command: "verify", outcome: "not_passed", exitCode: 3, data: { verification, cycle } });
      for (const value of ["AC-broken", "Expected retry fence", "FENCE_BROKEN", "/work/my  repo/core.ts:23", "artifact://run-original/ev-1", `${cycle.iteration}/${cycle.maxIterations}`]) expect(text).toContain(value);
      expect(text.indexOf("FENCE_BROKEN")).toBeLessThan(text.indexOf("routine-0") === -1 ? Infinity : text.indexOf("routine-0"));
      expect(text).toMatch(/Next:.*human/i);
      expect(text).not.toMatch(/rerun verification|retry verification/i);
    });

  it.each(["blocked", "inconclusive"])("offers evidence and prerequisite diagnosis for %s verification", status => {
    const text = render({ command: "verify", outcome: "not_passed", exitCode: 3,
      data: { verification: { ...verification, status }, cycle: { status: "rework_required", iteration: 1, maxIterations: 3 } } });
    expect(text).toMatch(/Next:.*(runner|evidence|prerequisite)/i);
    expect(text).not.toContain("then rerun verification");
  });

  it("preserves pending escalation authority and prevents retry advice even when the command failed", () => {
    const text = render({ command: "verify", outcome: "failed", status: "failed", exitCode: 1,
      error: { code: "conflict", retryable: true, message: "Cycle closed", details: { reason: "busy" } },
      data: { verification, cycle: { status: "rework_required", iteration: 3, maxIterations: 3 },
        pendingMessages: [{ type: "verification.escalation", payload: { reason: "Iteration limit", target: "human_operator", approvalRequestId: "approval-1" } }] } });
    expect(text).toContain("Escalation: Iteration limit");
    expect(text).toContain("Approval request: approval-1");
    expect(text).toMatch(/Next:.*human/);
    expect(text).not.toContain("then retry");
  });

  it.each([
    { config: { state: "invalid", path: "/config/my  host/mcp.json" }, gateway: { reachable: true }, backends: [], expected: "config" },
    { config: { state: "absent", path: "/config/my  host/mcp.json" }, gateway: { reachable: false }, backends: [], expected: "bflow setup --plan" },
    { config: { state: "valid" }, gateway: { reachable: false }, backends: [], expected: "Gateway" },
    { config: { state: "valid" }, gateway: { reachable: true }, backends: [{ serviceId: "pinned", state: "invalid", reason: "Digest mismatch" }], expected: "pin" }
  ])("offers conservative MCP actions for $expected", ({ expected, ...data }) => {
    const text = render({ command: "mcp.status", outcome: "not_ready", exitCode: 3, data });
    expect(text.split("\n").filter(line => line.includes("Next:")).join("\n")).toContain(expected);
    if (data.config.path) expect(text).toContain(data.config.path);
    expect(text).not.toMatch(/bypass|allow-all|widen/i);
  });

  it("redacts before truncation, strips terminal controls, bounds untrusted lines and preserves literal paths", () => {
    const report: Partial<CommandReport> = { command: "verify", outcome: "not_passed", exitCode: 3,
      steps: [{ id: "late\u001b[31m-failure", status: "failed", message: `token="${"secret".repeat(500)}" tail` }],
      data: { verification: { ...verification, findings: [{ severity: "error", code: "SAFE\u001b[31m", message: `token="${"secret".repeat(500)}" tail`, location: "/work/my  repo/test.ts:4" }] } } };
    const text = render(report);
    expect(text).not.toMatch(/secret|\u001b/);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("tail");
    expect(text).toContain("/work/my  repo/test.ts:4");
    expect(Math.max(...text.split("\n").map(line => line.length))).toBeLessThan(1200);
    expect(stripAnsi(formatHighLevelHuman(envelope(report), true))).toBe(text);
  });
});

describe("high-level command help", () => {
  it.each(["task.plan", "task.implement", "verify", "git.prepare"] as const)("explains %s without phase jargon", command => {
    expect(getHighLevelHelp(command)).not.toMatch(/\bP(?:15|17|18)\b/);
  });
  it("limits resume advice to supported commands and preserves assignment preparation scope", () => {
    for (const command of ["repo.inspect", "task.plan", "verify", "mcp.status", "tool.status", "agent.check"] as const)
      expect(getHighLevelHelp(command)).not.toContain("--resume");
    for (const command of ["task.implement", "git.prepare", "skills.sync"] as const)
      expect(getHighLevelHelp(command)).toContain("--resume");
    expect(getHighLevelHelp("task.implement")).toContain("this command never starts an agent");
  });
});
