import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractErrorSchema,
  SessionManifestSchema,
  WorkflowRunSnapshotSchema,
  type ContractError,
  type RecoveryCheckpoint,
  type SessionLifecycleManager,
  type SessionManifest,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import {
  ANSI,
  boundMessage,
  colorize,
  extractSafeDetails,
  formatProgressStep,
  humanText,
  isStderrInteractive,
  redactSensitive,
  resolveActionableRemediation,
  resolveStreamColor,
  sanitizeIdentifier,
  stripAnsi
} from "../src/presentation.js";
import {
  formatCommandError,
  formatCommandSuccess,
  formatDownOutput,
  formatEnvironmentStatus,
  formatUpOutput
} from "../src/formatters.js";
import { executeCommand, resolvePresentation } from "../src/commands.js";
import { main } from "../src/bin.js";
import {
  EnvironmentError,
  EnvironmentLifecycle,
  environmentProcessRunner,
  identifyRepository,
  parseCliArgs,
  runCli,
  type EnvironmentProcessRequest,
  type EnvironmentProcessRunner
} from "../src/index.js";
import type { CliContext, CliIo, InitCommandOutput } from "../src/types.js";

describe("Presentation & Formatting Engine", () => {
  it("directs sandbox startup failures to namespace repair even when the error is truncated", () => {
    const out = formatCommandError({ code: "validation", retryable: false,
      message: "verification_sandbox_unavailable: AppArmor user namespace restriction is enabled; " + "x".repeat(1000) }, "up", false);
    expect(out).toContain("AppArmor");
    expect(out).toContain("bflow doctor");
    expect(out).not.toContain("bflow up --help");
  });
  describe("1. Stream Color Resolution Matrix", () => {
    it("respects explicit overrides", () => {
      expect(resolveStreamColor({ explicit: true, env: { NO_COLOR: "1" } })).toBe(true);
      expect(resolveStreamColor({ explicit: false, env: { FORCE_COLOR: "1" } })).toBe(false);
    });

    it("disables color on non-empty NO_COLOR, overriding FORCE_COLOR", () => {
      expect(resolveStreamColor({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, isTTY: true })).toBe(false);
      expect(resolveStreamColor({ env: { NO_COLOR: "true" }, isTTY: true })).toBe(false);
    });

    it("ignores empty NO_COLOR", () => {
      expect(resolveStreamColor({ env: { NO_COLOR: "", FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
    });

    it("disables color on FORCE_COLOR='0'", () => {
      expect(resolveStreamColor({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(false);
    });

    it("enables color on non-zero FORCE_COLOR even for pipes (isTTY: false)", () => {
      expect(resolveStreamColor({ env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
      expect(resolveStreamColor({ env: { FORCE_COLOR: "true" }, isTTY: false })).toBe(true);
    });

    it("disables color when TERM='dumb' unless forced", () => {
      expect(resolveStreamColor({ env: { TERM: "dumb" }, isTTY: true })).toBe(false);
      expect(resolveStreamColor({ env: { TERM: "dumb", FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
    });

    it("enables color when isTTY is true and TERM is standard", () => {
      expect(resolveStreamColor({ env: { TERM: "xterm-256color" }, isTTY: true })).toBe(true);
      expect(resolveStreamColor({ env: {}, isTTY: true })).toBe(true);
    });

    it("disables color when isTTY is false and no force flags are set", () => {
      expect(resolveStreamColor({ env: { TERM: "xterm" }, isTTY: false })).toBe(false);
    });
  });

  describe("2. Interactive Progress Resolution", () => {
    it("enables progress only when stderr is an interactive TTY", () => {
      expect(isStderrInteractive({ isTTY: true, env: { TERM: "xterm" } })).toBe(true);
      expect(isStderrInteractive({ isTTY: false, env: { TERM: "xterm" } })).toBe(false);
    });

    it("never enables progress on FORCE_COLOR alone (FORCE_COLOR never enables progress)", () => {
      expect(isStderrInteractive({ isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(false);
    });

    it("disables progress when TERM='dumb' even if isTTY is true", () => {
      expect(isStderrInteractive({ isTTY: true, env: { TERM: "dumb" } })).toBe(false);
    });

    it("formats numbered progress steps and respects color", () => {
      const plain = formatProgressStep("Starting service", false);
      expect(plain).toBe("[1] Starting service");

      const colored = formatProgressStep("Starting service", true, 3);
      expect(colored).toContain("\x1b[36m");
      expect(stripAnsi(colored)).toBe("[3] Starting service");
    });
  });

  describe("3. Human Dynamic Text Sanitization & Credential Redaction", () => {
    it("strips ANSI escape sequences and non-printable control characters", () => {
      const dirty = "\x1b[31mRed text\x1b[0m and control \x07\x1b[1mbold\x1b[0m";
      expect(stripAnsi(dirty)).toBe("Red text and control bold");
    });

    it("redacts sensitive tokens, keys, and authorization headers", () => {
      const sample = [
        "Error with token: ghp_1234567890abcdef12345 in repo",
        "Claude API key: sk-ant-api03-abcdef12345678901234567890",
        "Header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis",
        "Config line: password='super_secret_password'",
        "API param: apiKey=\"secret_api_key_value\"",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----"
      ].join("\n");

      const redacted = redactSensitive(sample);
      expect(redacted).not.toContain("ghp_1234567890abcdef12345");
      expect(redacted).not.toContain("sk-ant-api03-abcdef12345678901234567890");
      expect(redacted).not.toContain("super_secret_password");
      expect(redacted).not.toContain("secret_api_key_value");
      expect(redacted).not.toContain("MIIEowIBAAKCAQEA0");
      expect(redacted).toContain("[REDACTED_SECRET]");
      expect(redacted).toContain("[REDACTED_TOKEN]");
      expect(redacted).toContain("password=[REDACTED]");
      expect(redacted).toContain("apiKey=[REDACTED]");
      expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
    });

    it("bounds message length and removes stack traces", () => {
      const errorWithStack = [
        "Database connection failed",
        "    at Client.connect (/workspace/db.ts:45:12)",
        "    at async main (/workspace/index.ts:10:5)"
      ].join("\n");

      const bounded = boundMessage(errorWithStack, 100);
      expect(bounded).toBe("Database connection failed");
      expect(bounded).not.toContain("at Client.connect");

      const longMsg = "A".repeat(500);
      const truncated = boundMessage(longMsg, 50);
      expect(truncated.length).toBeLessThanOrEqual(70);
      expect(truncated).toContain("... [truncated]");
    });

    it("extracts and sanitizes only allowlisted scalar details", () => {
      const untrustedDetails = {
        role: "agent-\x1b[31mdeveloper\x1b[0m token=sk-ant-api03-12345678901234567890",
        stage: "native_startup",
        paneId: 4,
        unauthorizedSecret: "super_secret_value",
        nestedObject: { leak: true },
        rawTerminalDump: ["line1", "line2"]
      };

      const safe = extractSafeDetails(untrustedDetails);
      expect(safe).not.toBeNull();
      expect(safe).toHaveProperty("stage", "native_startup");
      expect(safe).toHaveProperty("paneId", 4);
      expect(safe).toHaveProperty("role");
      expect(safe!["role"]).not.toContain("\x1b[31m");
      expect(safe!["role"]).not.toContain("sk-ant-api03-12345678901234567890");
      expect(safe!["role"]).toContain("token=[REDACTED]");
      expect(safe).not.toHaveProperty("unauthorizedSecret");
      expect(safe).not.toHaveProperty("nestedObject");
      expect(safe).not.toHaveProperty("rawTerminalDump");
    });

    it("redacts GitHub tokens with underscores and generic PKCS8 private keys", () => {
      const ghpToken = "ghp_" + "X".repeat(36);
      const ghoToken = "gho_" + "Y".repeat(36);
      const ghuToken = "ghu_" + "Z".repeat(36);
      const ghsToken = "ghs_" + "W".repeat(36);
      const ghrToken = "ghr_" + "V".repeat(36);
      const pkcs8Key = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----";
      const rsaKey = "-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC\n-----END RSA PRIVATE KEY-----";

      expect(redactSensitive(`Token is ${ghpToken}`)).toBe("Token is [REDACTED_SECRET]");
      expect(redactSensitive(`Token is ${ghoToken}`)).toBe("Token is [REDACTED_SECRET]");
      expect(redactSensitive(`Token is ${ghuToken}`)).toBe("Token is [REDACTED_SECRET]");
      expect(redactSensitive(`Token is ${ghsToken}`)).toBe("Token is [REDACTED_SECRET]");
      expect(redactSensitive(`Token is ${ghrToken}`)).toBe("Token is [REDACTED_SECRET]");
      expect(redactSensitive(`Key:\n${pkcs8Key}`)).toBe("Key:\n[REDACTED_PRIVATE_KEY]");
      expect(redactSensitive(`Key:\n${rsaKey}`)).toBe("Key:\n[REDACTED_PRIVATE_KEY]");
    });

    it("strips carriage returns and C1 control sequences from human text", () => {
      const withCr = "first\roverwritten";
      expect(stripAnsi(withCr)).toBe("firstoverwritten");

      // C1 control characters \u0080 through \u009F
      const withC1 = "hello\u0085world\u009B31mcolored\u009C";
      expect(stripAnsi(withC1)).toBe("helloworld31mcolored");

      // Preserves normal newlines and tabs
      const normal = "line 1\n\tline 2";
      expect(stripAnsi(normal)).toBe("line 1\n\tline 2");
    });

    it("humanText bounds length, strips escapes and control characters, and redacts secrets", () => {
      const raw = "\x1b[31mCritical:\x1b[0m token \rghp_" + "X".repeat(36) + " \u0085" + "A".repeat(300);
      const safe = humanText(raw, 50);
      expect(safe).not.toContain("\x1b[");
      expect(safe).not.toContain("\r");
      expect(safe).not.toContain("\u0085");
      expect(safe).not.toContain("ghp_");
      expect(safe).toContain("[REDACTED_SECRET]");
      expect(safe.length).toBeLessThanOrEqual(70);
      expect(safe).toContain("... [truncated]");
    });

    it("sanitizeIdentifier strips escape and control sequences and redacts secrets without length truncation", () => {
      const longId = "run-custom-long-identifier-1234567890-abcdef-ghijk-lmnop-qrstuvwxyz-67890";
      expect(sanitizeIdentifier(longId)).toBe(longId);

      const withControl = "\x1b[31mrun-123\x1b[0m\r\n\t";
      expect(sanitizeIdentifier(withControl)).toBe("run-123");

      const withSecret = "run-ghp_" + "X".repeat(36);
      expect(sanitizeIdentifier(withSecret)).toBe("run-[REDACTED_SECRET]");
    });
  });

  describe("4. Actionable Remediation Mapping", () => {
    it("does not classify missing workflow runs or tasks as missing executables", () => {
      const runNotFoundErr: ContractError = {
        code: "not_found",
        retryable: false,
        message: "Run 'run-123' not found."
      };
      const remediation = resolveActionableRemediation(runNotFoundErr, "status");
      expect(remediation).toContain("Kiểm tra mã luồng chạy");
      expect(remediation).not.toContain("phần mềm thực thi");
      expect(remediation).not.toContain("PATH");

      const taskNotFoundErr: ContractError = {
        code: "not_found",
        retryable: false,
        message: "Task 'plan' not found in run 'run-123'."
      };
      const taskRemediation = resolveActionableRemediation(taskNotFoundErr, "approve");
      expect(taskRemediation).toContain("Kiểm tra mã tác vụ");
      expect(taskRemediation).not.toContain("phần mềm thực thi");
    });

    it("keeps Agy authentication recovery specific to its interactive login flow", () => {
      const next = resolveActionableRemediation({ code: "validation", retryable: false,
        message: "Agent provider 'agy' is not authenticated. Run 'agy' interactively, then verify with 'agy models'." }, "up");
      expect(next).toContain("agy");
      expect(next).not.toContain("agy auth login");
      expect(next).not.toContain("claude");
      expect(next).not.toContain("codex");
    });

    it("preserves precise authored recovery instructions", () => {
      expect(
        resolveActionableRemediation({ code: "conflict", retryable: false, message: "Run bflow recover --yes" })
      ).toContain("bflow recover --yes");

      expect(
        resolveActionableRemediation({ code: "validation", retryable: false, message: "Run claude auth login before bflow up." })
      ).toContain("claude auth login");

      expect(
        resolveActionableRemediation({ code: "validation", retryable: false, message: "Run bflow up before attach." })
      ).toContain("bflow up");

      expect(
        resolveActionableRemediation({ code: "validation", retryable: false, message: "Unsafe shutdown: active runs" }, "down")
      ).toContain("bflow down --yes");

      expect(
        resolveActionableRemediation({ code: "timeout", retryable: true, retrySafety: "observation_only", message: "reconcile the existing session" })
      ).toContain("bflow status");
    });

    it("recommends bflow init for missing config", () => {
      const configNotFound: ContractError = {
        code: "not_found",
        retryable: false,
        message: "Configuration not found"
      };
      expect(resolveActionableRemediation(configNotFound, "run")).toContain("bflow init");
    });

    it("recommends git init or valid root for missing repo", () => {
      const gitErr: ContractError = {
        code: "validation",
        retryable: false,
        message: "fatal: not a git repository"
      };
      expect(resolveActionableRemediation(gitErr, "up")).toContain("git init");
    });

    it("suggested remediation commands parse cleanly with parseCliArgs", () => {
      // Missing run error suggests listing runs
      const runErr: ContractError = { code: "not_found", retryable: false, message: "Run 'run-99' not found." };
      const runRemediation = resolveActionableRemediation(runErr, "status");
      expect(runRemediation).toContain("bflow status --limit 10");
      expect(parseCliArgs(["status", "--limit", "10"]).ok).toBe(true);

      // Missing task error suggests inspecting run
      const taskErr: ContractError = { code: "not_found", retryable: false, message: "Task 'qa' not found in run 'run-99'." };
      const taskRemediation = resolveActionableRemediation(taskErr, "status");
      expect(taskRemediation).toContain("bflow status <run-id>");
      expect(parseCliArgs(["status", "run-99"]).ok).toBe(true);

      // Approval command parsing
      expect(parseCliArgs(["approve", "task-1", "--run", "run-99"]).ok).toBe(true);

      // Other standard suggestions
      expect(parseCliArgs(["init"]).ok).toBe(true);
      expect(parseCliArgs(["up"]).ok).toBe(true);
      expect(parseCliArgs(["down", "--yes"]).ok).toBe(true);
      expect(parseCliArgs(["recover", "--yes"]).ok).toBe(true);
      expect(parseCliArgs(["doctor"]).ok).toBe(true);
      expect(parseCliArgs(["resume", "run-99"]).ok).toBe(true);
    });
  });

  describe("5. Command Formatters & Semantic Palette", () => {
    it("formats attach return truthfully without claiming environment ready", () => {
      const out = formatCommandSuccess("attach", {
        sessionId: "test-session",
        workspaceRoot: "/workspace",
        status: "up",
        panes: [],
        attachTarget: { paneId: "p1", role: "conversation", tabId: "t1", workspaceId: "w1", agentId: "a1" },
        activeRunIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, false, { color: true });

      expect(stripAnsi(out)).toContain("[HOÀN TẤT] Đã rời khung chat Conversation.");
      expect(out).toContain("Đã rời khung chat Conversation.");
      expect(out).not.toContain("Môi trường đã khởi động");
    });

    it("formats init output without falsely claiming created when overwritten is false", () => {
      const initOutput: InitCommandOutput = {
        configPath: "/workspace/.bflow/config.yml",
        overwritten: false,
        config: {
          projectName: "my-project",
          runtimeId: "rt-1",
          storage: {
            runStorePath: "/workspace/.bflow/runs.db",
            artifactStoreRoot: "/workspace/.bflow/artifacts",
            registryStateFile: "/workspace/.bflow/registry.json"
          },
          defaultWorkflow: {
            id: "wf-1",
            version: "1.0.0",
            name: "default",
            tasks: [{ id: "task-1" }]
          } as any
        } as any
      };

      const out = formatCommandSuccess("init", initOutput, false);
      expect(out).toContain("[HOÀN TẤT] Đã khởi tạo cấu hình kho mã nguồn bflow ✓");
      expect(out).toContain("Tệp cấu hình: /workspace/.bflow/config.yml");
      expect(out).not.toContain("Đã ghi đè");
      expect(out).toContain("Dự án:        my-project (codex)");
    });

    it("formats doctor report correctly for healthy environments with warnings", () => {
      const reportWithWarn = {
        workspaceRoot: "/workspace",
        sessionId: "sess-1",
        healthy: true,
        checks: [
          { name: "git", status: "passed" as const, message: "Git repo valid" },
          { name: "config", status: "passed" as const, message: "Config valid" },
          { name: "provider", status: "warn" as const, message: "Optional provider not logged in", remediation: "Run login" }
        ]
      };

      const plain = formatCommandSuccess("doctor", reportWithWarn, false);
      expect(plain).toContain("✓ [KHỎE MẠNH] Hệ thống hoạt động tốt ✓");
      expect(plain).toContain("• Kiểm tra cơ bản: Đạt (2/3) ✓");
      expect(plain).not.toContain("3/3");

      const colored = formatCommandSuccess("doctor", reportWithWarn, false, { color: true });
      expect(colored).toContain("\x1b[33mCẢNH BÁO\x1b[0m");
      expect(colored).toContain("👉 Tiếp theo:");
    });

    it("formats doctor report for unhealthy environments", () => {
      const reportUnhealthy = {
        workspaceRoot: "/workspace",
        sessionId: "sess-1",
        healthy: false,
        checks: [
          { name: "git", status: "passed" as const, message: "Git repo valid" },
          { name: "server", status: "failed" as const, message: "Herdr server not running", remediation: "Run bflow up" }
        ]
      };

      const plain = formatCommandSuccess("doctor", reportUnhealthy, false);
      expect(plain).toContain("✗ [CẦN XỬ LÝ] Phát hiện vấn đề trong môi trường");
      expect(plain).toContain("- [LỖI] server: Herdr server not running");
    });

    it("formats down output only claiming stopped when actually stopped", () => {
      // server stopped, manifest null => [HOÀN TẤT] Đã dừng môi trường
      const stoppedStatus = {
        workspaceRoot: "/workspace",
        sessionName: "sess-1",
        server: "stopped" as const,
        configuration: "valid" as const,
        manifest: null,
        liveObservation: true,
        issues: []
      };
      const stoppedOut = formatCommandSuccess("down", stoppedStatus, false);
      expect(stoppedOut).toContain("[HOÀN TẤT] Đã dừng môi trường");
      expect(formatDownOutput(stoppedStatus, false)).toContain("[HOÀN TẤT] Đã dừng môi trường");

      // server running, manifest degraded => NOT stopped
      const runningStatus = {
        workspaceRoot: "/workspace",
        sessionName: "sess-1",
        server: "running" as const,
        configuration: "valid" as const,
        manifest: { status: "degraded" } as any,
        liveObservation: true,
        issues: []
      };
      const runningOut = formatCommandSuccess("down", runningStatus, false);
      expect(runningOut).not.toContain("[HOÀN TẤT] Đã dừng môi trường");
      expect(runningOut).toContain("Trạng thái môi trường:");

      // server running, manifest null => NOT stopped
      const runningNullStatus = {
        ...stoppedStatus,
        server: "running" as const,
        manifest: null
      };
      const runningNullOut = formatDownOutput(runningNullStatus, false);
      expect(runningNullOut).not.toContain("[HOÀN TẤT] Đã dừng môi trường");
      expect(runningNullOut).toContain("Trạng thái môi trường:");

      // server running, manifest down => NOT stopped (server observation must decide)
      const runningDownStatus = {
        ...stoppedStatus,
        server: "running" as const,
        manifest: { status: "down" } as any
      };
      const runningDownOut = formatDownOutput(runningDownStatus, false);
      expect(runningDownOut).not.toContain("[HOÀN TẤT] Đã dừng môi trường");
      expect(runningDownOut).toContain("Trạng thái môi trường:");

      // server unknown, manifest down => NOT confirmed stopped
      const unknownDownStatus = {
        ...stoppedStatus,
        server: "unknown" as const,
        manifest: { status: "down" } as any
      };
      const unknownDownOut = formatDownOutput(unknownDownStatus, false);
      expect(unknownDownOut).not.toContain("[HOÀN TẤT] Đã dừng môi trường");
      expect(unknownDownOut).toContain("Trạng thái môi trường:");

      // SessionManifest with status down => [HOÀN TẤT] Đã dừng môi trường
      const manifestDown = {
        schemaVersion: 2,
        sessionId: "sess-1",
        projectName: "repo",
        workspaceRoot: "/workspace",
        herdrWorkspaceId: "w1",
        herdrTabId: "t1",
        status: "down" as const,
        panes: [],
        attachTarget: { paneId: "p1", role: "conversation" },
        activeRunIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      expect(formatDownOutput(manifestDown as any, false)).toContain("[HOÀN TẤT] Đã dừng môi trường");
    });

    it("sanitizes dynamic fields in human environment status while preserving raw in JSON", () => {
      const ghp = "ghp_" + "A".repeat(36);
      const status = {
        workspaceRoot: "/workspace/\x1b[31minjected\x1b[0m",
        sessionName: "sess-\roverwrite",
        server: "running" as const,
        configuration: "valid" as const,
        manifest: null,
        liveObservation: true,
        issues: [
          `Malicious issue: \x1b[31mred\x1b[0m with \rCR and token ${ghp}`,
          "C1 control: \u0085newline \u009B31mcolor\u009C"
        ]
      };

      const humanPlain = formatEnvironmentStatus(status, false);
      expect(humanPlain).not.toContain("\x1b[31m");
      expect(humanPlain).not.toContain("\r");
      expect(humanPlain).not.toContain("\u0085");
      expect(humanPlain).not.toContain(ghp);
      expect(humanPlain).toContain("[REDACTED_SECRET]");

      const jsonOut = formatCommandSuccess("status", status, true);
      const parsed = JSON.parse(jsonOut);
      // Handled JSON retains raw values unredacted
      expect(parsed.data.issues[0]).toContain(ghp);
      expect(parsed.data.issues[0]).toContain("\x1b[31m");
      expect(parsed.data.issues[0]).toContain("\r");
    });

    it("aligns workflow run table columns before ANSI styling", () => {
      const page = {
        items: [
          {
            runId: "run-alpha-12345",
            status: "running" as const,
            workflowId: "sdlc",
            workflowVersion: "1.0.0",
            version: 1,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:01:00Z",
            tasks: [],
            input: {}
          },
          {
            runId: "run-beta-67890",
            status: "waiting" as const,
            workflowId: "sdlc",
            workflowVersion: "1.0.0",
            version: 1,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:02:00Z",
            tasks: [],
            input: {}
          }
        ]
      };

      const plain = formatCommandSuccess("status", page, false);
      const colored = formatCommandSuccess("status", page, false, { color: true });

      // Strip ANSI and verify exact columnar alignment
      const plainLines = plain.split("\n");
      const coloredLines = colored.split("\n").map((l) => stripAnsi(l));

      expect(coloredLines).toEqual(plainLines);
      expect(colored).toContain("\x1b[36mRUNNING\x1b[0m");
      expect(colored).toContain("\x1b[33mWAITING\x1b[0m");
    });

    it("displays human approval guidance ONLY when blockage.code is awaiting_approval", () => {
      const waitingApprovalSnapshot = {
        runId: "run-approval-test",
        workflowId: "sdlc",
        workflowVersion: "1.0.0",
        status: "waiting" as const,
        version: 1,
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:01:00Z",
        tasks: [
          {
            taskId: "spec-approval",
            status: "waiting" as const,
            attempt: 1,
            generation: 0,
            version: 1,
            blockage: { code: "awaiting_approval", message: "Requires sign-off" }
          }
        ],
        input: {}
      };

      const approvalOut = formatCommandSuccess("status", waitingApprovalSnapshot, false);
      expect(approvalOut).toContain("⏳ Đang chờ phê duyệt tại 'spec-approval'. Chạy: bflow approve spec-approval --run run-approval-test --by <tên-bạn>");

      const waitingOtherSnapshot = {
        ...waitingApprovalSnapshot,
        tasks: [
          {
            taskId: "network-call",
            status: "waiting" as const,
            attempt: 1,
            generation: 0,
            version: 1,
            blockage: { code: "dependency_wait", message: "Waiting for endpoint" }
          }
        ]
      };

      const otherOut = formatCommandSuccess("status", waitingOtherSnapshot, false);
      expect(otherOut).not.toContain("⏳ Đang chờ phê duyệt tại");
      expect(otherOut).toContain("⚠ Luồng chạy đang bị chặn tại: network-call. Chạy: bflow resume run-approval-test");
    });

    it("preserves raw unredacted data and error in handled JSON without ANSI", () => {
      const secretError: ContractError = {
        code: "validation",
        retryable: false,
        message: "Secret key leaked: sk-ant-api03-12345678901234567890",
        details: { token: "super_secret_token" }
      };

      const jsonErr = formatCommandError(secretError, "up", true, { color: true });
      expect(jsonErr).not.toContain("\x1b[");
      const parsed = JSON.parse(jsonErr);
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe("up");
      expect(parsed.error.message).toBe("Secret key leaked: sk-ant-api03-12345678901234567890");
      expect(parsed.error.details.token).toBe("super_secret_token");
    });

    it("preserves full 40-character UUID run IDs in run table and keeps columns aligned", () => {
      const uuidRunId = "run-f47ac10b-58cc-4372-a567-0e02b2c3d479"; // exactly 40 chars
      expect(uuidRunId.length).toBe(40);

      const page = {
        items: [
          {
            runId: uuidRunId,
            status: "running" as const,
            workflowId: "sdlc",
            workflowVersion: "1.0.0",
            version: 1,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:01:00Z",
            tasks: [],
            input: {}
          },
          {
            runId: "run-short-123",
            status: "waiting" as const,
            workflowId: "sdlc",
            workflowVersion: "1.0.0",
            version: 1,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:02:00Z",
            tasks: [],
            input: {}
          }
        ]
      };

      const plain = formatCommandSuccess("status", page, false);
      const colored = formatCommandSuccess("status", page, false, { color: true });

      // Verifies full UUID is present and copyable without truncation
      expect(plain).toContain(uuidRunId);
      expect(plain).not.toContain("... [truncated]");

      // Verifies colored and plain visual columnar alignment match exactly
      const plainLines = plain.split("\n");
      const coloredLines = colored.split("\n").map((l) => stripAnsi(l));
      expect(coloredLines).toEqual(plainLines);
    });

    it("preserves full long task and run IDs (>50 chars) in approval and resume commands for copyability", () => {
      const longRunId = "run-12345678-1234-1234-1234-123456789abc-extended-long-id-for-testing"; // 70 chars
      const longTaskId = "task-verify-spec-approval-and-conditional-tdd-decision-gate"; // 59 chars
      expect(longRunId.length).toBeGreaterThan(50);
      expect(longTaskId.length).toBeGreaterThan(50);

      const snapshot = {
        runId: longRunId,
        workflowId: "workflow-agentic-sdlc-full-lifecycle",
        workflowVersion: "2.0.0",
        status: "waiting" as const,
        version: 1,
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:01:00Z",
        tasks: [
          {
            taskId: longTaskId,
            status: "waiting" as const,
            attempt: 1,
            generation: 0,
            version: 1,
            blockage: { code: "awaiting_approval", message: "Sign-off required for phase transition" }
          }
        ],
        input: {}
      };

      const plain = formatCommandSuccess("status", snapshot, false);
      expect(plain).not.toContain("... [truncated]");

      // Exact copyable command strings
      const expectedApprove = `bflow approve ${longTaskId} --run ${longRunId}`;
      const expectedResume = `bflow resume ${longRunId}`;

      expect(plain).toContain(`⏳ Đang chờ phê duyệt tại '${longTaskId}'. Chạy: ${expectedApprove} --by <tên-bạn>`);
      expect(plain).toContain(`Để tiếp tục luồng chạy: ${expectedResume}`);
    });

    it("preserves full pagination cursors (>50 chars) in run table output", () => {
      const longCursor = "cursor_eyJvZmZzZXQiOjEwMCwidGltZXN0YW1wIjoxNzAwMDAwMDAwLCJzZXF1ZW5jZSI6OTk5OTl9_extended_cursor_data"; // 96 chars
      expect(longCursor.length).toBeGreaterThan(50);

      const page = {
        items: [
          {
            runId: "run-simple-1",
            status: "succeeded" as const,
            workflowId: "sdlc",
            workflowVersion: "1.0.0",
            version: 1,
            lastEventSequence: 1,
            createdAt: "2026-10-17T00:00:00Z",
            updatedAt: "2026-10-17T00:01:00Z",
            tasks: [],
            input: {}
          }
        ],
        nextCursor: longCursor
      };

      const plain = formatCommandSuccess("status", page, false);
      expect(plain).not.toContain("... [truncated]");
      expect(plain).toContain(`👉 Trang tiếp: bflow status --cursor ${longCursor}`);
    });
  });

  describe("6. main() Entrypoint & Single-Envelope Ownership", () => {
    it("preserves real TTY color capabilities in default executable invocation", async () => {
      const origIsTTY = process.stderr.isTTY;
      const origNoColor = process.env["NO_COLOR"];
      const origTerm = process.env["TERM"];
      try {
        delete process.env["NO_COLOR"];
        process.env["TERM"] = "xterm-256color";
        // Simulate real TTY on stderr
        (process.stderr as any).isTTY = true;
        const res = await main(["--unknown-option-xyz"]);
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(2);
        // Error on real TTY should have ANSI color tags
        expect(res.stderr).toContain("\x1b[31m");
        expect(res.stderr).toContain("✗ Lỗi [validation]:");
      } finally {
        (process.stderr as any).isTTY = origIsTTY;
        if (origNoColor !== undefined) process.env["NO_COLOR"] = origNoColor;
        else delete process.env["NO_COLOR"];
        if (origTerm !== undefined) process.env["TERM"] = origTerm;
        else delete process.env["TERM"];
      }
    });

    it("defaults custom IO collectors to plain non-interactive output", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const customIo: CliIo = {
        stdout: (m) => stdoutLines.push(m),
        stderr: (m) => stderrLines.push(m)
      };

      const res = await main(["--unknown-option-xyz"], { io: customIo });
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(2);
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines[0]).not.toContain("\x1b[");
      expect(stderrLines[0]).toContain("✗ Lỗi [validation]:");
    });

    it("safely handles unexpected exceptions with code=ENOENT as valid ContractErrorSchema", async () => {
      const stderrLines: string[] = [];
      const customIo: CliIo = {
        stdout: () => {},
        stderr: (m) => stderrLines.push(m)
      };

      // Injected runtime that throws an unexpected Error with code="ENOENT"
      const fakeRuntime: any = {
        getRun: vi.fn().mockImplementation(() => {
          const err: any = new Error("ENOENT: no such file or directory, open '/nonexistent'");
          err.code = "ENOENT";
          throw err;
        })
      };

      const res = await main(["status", "run-999", "--json"], {
        io: customIo,
        runtime: fakeRuntime
      });

      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      const parsedJson = JSON.parse(stderrLines[0]!);
      expect(parsedJson.ok).toBe(false);
      expect(parsedJson.command).toBe("status");

      // Must validate against ContractErrorSchema
      const validation = ContractErrorSchema.safeParse(parsedJson.error);
      expect(validation.success).toBe(true);
      expect(validation.data?.code).toBe("validation");
      expect(validation.data?.retryable).toBe(false);
    });

    it("maintains single-envelope ownership when runtime close throws after success", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const customIo: CliIo = {
        stdout: (m) => stdoutLines.push(m),
        stderr: (m) => stderrLines.push(m)
      };

      const mockClose = vi.fn().mockRejectedValue(new Error("Disk sync failed during close"));
      const mockRuntime: any = {
        findRuns: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            items: [],
            nextCursor: null
          }
        })
      };

      const runtimeModule = await import("../src/runtime.js");
      const spy = vi.spyOn(runtimeModule, "composeCliRuntime").mockResolvedValue({
        ok: true,
        value: {
          runtime: mockRuntime,
          close: mockClose
        } as any
      });

      try {
        const res = await main(["status", "--workflow-id", "wf-1", "--json"], { io: customIo });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(1);
        expect(stdoutLines.length).toBe(0); // Suppressed success output!
        expect(stderrLines.length).toBe(1); // Single error envelope!
        const parsed = JSON.parse(stderrLines[0]!);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.message).toContain("Disk sync failed during close");
      } finally {
        spy.mockRestore();
      }
    });

    it("retains original business error when runtime close throws after failure", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const customIo: CliIo = {
        stdout: (m) => stdoutLines.push(m),
        stderr: (m) => stderrLines.push(m)
      };

      const mockClose = vi.fn().mockRejectedValue(new Error("Disk sync failed during close"));
      const mockRuntime: any = {
        findRuns: vi.fn().mockResolvedValue({
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: "Original business error: workflow not found"
          }
        })
      };

      const runtimeModule = await import("../src/runtime.js");
      const spy = vi.spyOn(runtimeModule, "composeCliRuntime").mockResolvedValue({
        ok: true,
        value: {
          runtime: mockRuntime,
          close: mockClose
        } as any
      });

      try {
        const res = await main(["status", "--workflow-id", "wf-1", "--json"], { io: customIo });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(1);
        expect(stdoutLines.length).toBe(0);
        expect(stderrLines.length).toBe(1);
        const parsed = JSON.parse(stderrLines[0]!);
        expect(parsed.ok).toBe(false);
        // Original business error preserved, NOT replaced with close error!
        expect(parsed.error.message).toContain("Original business error: workflow not found");
        expect(parsed.error.message).not.toContain("Disk sync failed during close");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("7. Lifecycle Progress Callbacks & Truthful Boundaries", () => {
    class MockProcessRunner implements EnvironmentProcessRunner {
      readonly requests: EnvironmentProcessRequest[] = [];
      readonly running = new Set<string>();
      authenticated = true;
      async run(request: EnvironmentProcessRequest) {
        this.requests.push(request);
        if (request.executable === "git") return environmentProcessRunner.run(request);
        const session = request.env?.["HERDR_SESSION"] ?? "test-session";
        const args = request.args.join(" ");
        if (args === "login status") return { exitCode: this.authenticated ? 0 : 1, stdout: "", stderr: "" };
        if (args === "--help") return { exitCode: 0, stdout: "herdr --session NAME; Run as headless server", stderr: "" };
        if (args === "api schema --json") return { exitCode: 0, stdout: JSON.stringify({ protocol: 22, schema_version: 1 }), stderr: "" };
        if (args === "status server --json") return { exitCode: 0, stdout: JSON.stringify({ running: this.running.has(session), session, protocol: 22, compatible: true }), stderr: "" };
        if (args === "server") {
          this.running.add(session);
          return { exitCode: 0, stdout: "", stderr: "", pid: 99999 };
        }
        if (request.args[0] === "session" && request.args[1] === "stop") {
          this.running.delete(request.args[2]!);
          return { exitCode: 0, stdout: "{}", stderr: "" };
        }
        if (request.args[0] === "session" && request.args[1] === "attach") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
    }

    async function createFixtureDir(prefix: string): Promise<string> {
      const root = await realpath(tmpdir());
      return mkdtemp(join(root, prefix));
    }

    function createTestManifest(repository: { root: string; sessionName: string }): SessionManifest {
      const now = new Date().toISOString();
      const roles = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"];
      return SessionManifestSchema.parse({
        schemaVersion: 2,
        sessionId: repository.sessionName,
        projectName: "test-repo",
        workspaceRoot: repository.root,
        herdrWorkspaceId: "w1",
        herdrTabId: "w1:t1",
        status: "up",
        conversationSessionId: "conv-1",
        activeRunIds: [],
        metadata: { panePresentationVersion: 1 },
        panes: roles.map((role, i) => ({
          schemaVersion: 2,
          bindingId: `binding-${i}`,
          sessionId: repository.sessionName,
          role,
          agentId: `agent-${i}`,
          workspaceId: "w1",
          tabId: "w1:t1",
          paneId: `w1:p${i}`,
          provider: "openai",
          agentKind: "codex",
          cwd: repository.root,
          isolationMode: "dedicated_pane",
          readOnlyWorkspace: role === "conversation",
          transportState: "idle",
          boundAt: now
        })),
        attachTarget: { role: "conversation", paneId: "w1:p0" },
        createdAt: now,
        updatedAt: now
      });
    }

    it("up() records informative lifecycle phases and never emits conclusive 'Environment ready' in progress", async () => {
      const dir = await createFixtureDir("bflow-prog-up-");
      execFileSync("git", ["init", "--quiet", dir]);
      expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
      const repository = await identifyRepository(dir);
      const runner = new MockProcessRunner();
      const manifest = createTestManifest(repository);

      const manager: SessionLifecycleManager = {
        init: vi.fn(),
        up: vi.fn(async () => ({ ok: true, value: manifest })),
        down: vi.fn(),
        attach: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true, value: manifest })),
        doctorSession: vi.fn()
      };

      const activateMock = vi.fn(async () => {});
      const closeMock = vi.fn(async () => {});

      const progressSteps: string[] = [];
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        integration: { manager, activate: activateMock, close: closeMock },
        onProgress: (step) => progressSteps.push(step)
      });

      const lockModule = await import("../src/lifecycle-lock.js");
      const lockSpy = vi.spyOn(lockModule, "withLifecycleLock").mockImplementation(async (dir, fn) => {
        await mkdir(dir, { recursive: true });
        return fn();
      });

      try {
        const result = await lifecycle.up();
        expect(result.status).toBe("up");
        expect(activateMock).toHaveBeenCalledTimes(1);
        expect(closeMock).toHaveBeenCalledTimes(1);

        // Progress contains in-flight phases
        expect(progressSteps).toContain("Đang kiểm tra kho mã nguồn và cấu hình...");
        expect(progressSteps).toContain("Đang xác minh các phụ thuộc và xác thực provider...");
        expect(progressSteps).toContain("Đang khởi tạo tích hợp quản lý vòng đời phiên...");
        expect(progressSteps).toContain("Đang kiểm tra trạng thái phiên hiện tại...");
        expect(progressSteps).toContain("Đang khởi động máy chủ Herdr ngầm...");
        expect(progressSteps).toContain("Đang khởi chạy các vai trò agent...");
        expect(progressSteps).toContain("Đang kích hoạt tiến trình Runtime nền...");

        // CRITICAL: Conclusive "Environment ready" is NEVER emitted in progress!
        expect(progressSteps.some((s) => s.includes("Môi trường đã khởi động") || s.includes("Environment ready"))).toBe(false);

        // Success is reported only by final formatter
        const formatted = formatCommandSuccess("up", result, false);
        expect(formatted).toContain("[SẴN SÀNG] Môi trường đã khởi động");
      } finally {
        lockSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("up() emits activation progress at most once during native startup retries", async () => {
      const dir = await createFixtureDir("bflow-prog-retry-");
      execFileSync("git", ["init", "--quiet", dir]);
      expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
      const repository = await identifyRepository(dir);
      const runner = new MockProcessRunner();
      const manifest = createTestManifest(repository);

      const manager: SessionLifecycleManager = {
        init: vi.fn(),
        up: vi.fn(async () => ({ ok: true, value: manifest })),
        down: vi.fn(),
        attach: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true, value: manifest })),
        doctorSession: vi.fn()
      };

      let attempts = 0;
      const activateMock = vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new EnvironmentError({
            code: "internal",
            retryable: true,
            message: "Native startup pending",
            details: { stage: "native_startup" }
          });
        }
      });

      const progressSteps: string[] = [];
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        integration: { manager, activate: activateMock },
        onProgress: (step) => progressSteps.push(step)
      });

      const lockModule = await import("../src/lifecycle-lock.js");
      const lockSpy = vi.spyOn(lockModule, "withLifecycleLock").mockImplementation(async (dir, fn) => {
        await mkdir(dir, { recursive: true });
        return fn();
      });

      try {
        const result = await lifecycle.up();
        expect(result.status).toBe("up");
        expect(attempts).toBe(2);

        // "Đang kích hoạt tiến trình Runtime nền..." is emitted exactly once!
        const activatingSteps = progressSteps.filter((s) => s.includes("Đang kích hoạt tiến trình Runtime nền..."));
        expect(activatingSteps.length).toBe(1);

        // Never emitted "Environment ready" in progress
        expect(progressSteps.some((s) => s.includes("Môi trường đã khởi động") || s.includes("Environment ready"))).toBe(false);
      } finally {
        lockSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("up() does not emit 'Environment ready' when activation fails", async () => {
      const dir = await createFixtureDir("bflow-prog-fail-");
      execFileSync("git", ["init", "--quiet", dir]);
      expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
      const repository = await identifyRepository(dir);
      const runner = new MockProcessRunner();
      const manifest = createTestManifest(repository);

      const manager: SessionLifecycleManager = {
        init: vi.fn(),
        up: vi.fn(async () => ({ ok: true, value: manifest })),
        down: vi.fn(),
        attach: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true, value: manifest })),
        doctorSession: vi.fn()
      };

      const activateMock = vi.fn(async () => {
        throw new EnvironmentError({
          code: "fatal",
          retryable: false,
          message: "Permanent activation failure"
        });
      });

      const progressSteps: string[] = [];
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        integration: { manager, activate: activateMock },
        onProgress: (step) => progressSteps.push(step)
      });

      const lockModule = await import("../src/lifecycle-lock.js");
      const lockSpy = vi.spyOn(lockModule, "withLifecycleLock").mockImplementation(async (dir, fn) => {
        await mkdir(dir, { recursive: true });
        return fn();
      });

      try {
        await expect(lifecycle.up()).rejects.toThrow("Permanent activation failure");
        expect(progressSteps.some((s) => s.includes("Môi trường đã khởi động") || s.includes("Environment ready"))).toBe(false);
      } finally {
        lockSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("down() emits checkpoint progress only when active runs exist, and never emits 'Environment stopped' in progress", async () => {
      const dir = await createFixtureDir("bflow-prog-down-");
      execFileSync("git", ["init", "--quiet", dir]);
      expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
      const repository = await identifyRepository(dir);
      const runner = new MockProcessRunner();
      runner.running.add(repository.sessionName);
      const manifest = createTestManifest(repository);

      const manager: SessionLifecycleManager = {
        init: vi.fn(),
        up: vi.fn(),
        down: vi.fn(async () => ({ ok: true, value: { ...manifest, status: "down" } })),
        attach: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true, value: manifest })),
        doctorSession: vi.fn()
      };

      const runs: WorkflowRunSnapshot[] = [
        {
          runId: "run-active-1",
          workflowId: "wf-1",
          workflowVersion: "1.0",
          status: "running",
          tasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: 1,
          lastEventSequence: 1
        }
      ];

      const checkpointMock = vi.fn(async (cmd) => ({
        ok: true,
        value: {
          checkpointSchemaVersion: 1,
          codec: { name: "bflow.workflow-aggregate+json", version: 1 },
          checkpointId: cmd.checkpointId,
          runId: cmd.runId,
          version: cmd.expectedVersion,
          eventSequence: 1,
          createdAt: new Date().toISOString(),
          state: {
            schemaVersion: 1,
            snapshot: runs[0],
            approvals: [],
            gateRequests: [],
            gateOutcomes: [],
            successfulAttempts: [],
            cancellations: [],
            retrySchedules: [],
            attemptBaselines: [],
            commands: []
          }
        } as RecoveryCheckpoint
      }));

      const progressSteps: string[] = [];
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        integration: {
          manager,
          runtime: {
            findRuns: vi.fn(async () => ({ ok: true, value: { items: runs } })),
            getRun: vi.fn(async (id) => ({ ok: true, value: runs.find((r) => r.runId === id) ?? null }))
          } as any,
          quiesce: vi.fn(async () => ({ ok: true, value: undefined })),
          checkpoint: checkpointMock,
          shutdownHost: vi.fn(async () => {})
        },
        onProgress: (step) => progressSteps.push(step)
      });

      const lockModule = await import("../src/lifecycle-lock.js");
      const lockSpy = vi.spyOn(lockModule, "withLifecycleLock").mockImplementation(async (dir, fn) => {
        await mkdir(dir, { recursive: true });
        return fn();
      });

      try {
        await mkdir(join(dir, ".bflow/state"), { recursive: true });
        await (lifecycle as any).saveManifest(repository, manifest);

        const downResult = await lifecycle.down(true);
        expect(progressSteps).toContain("Đang thiết lập rào chắn dừng Runtime an toàn...");
        expect(progressSteps).toContain("Đang thu thập lại các luồng chạy đang hoạt động...");
        expect(progressSteps).toContain("Đang lưu điểm khôi phục (checkpoint) cho 1 luồng chạy đang hoạt động...");
        expect(progressSteps).toContain("Đang dừng các vai trò agent một cách an toàn...");
        expect(progressSteps).toContain("Đang dừng phiên Herdr...");
        expect(progressSteps).toContain("Đang tắt tiến trình Runtime nền...");

        // CRITICAL: Conclusive "Environment stopped" is NEVER emitted in progress!
        expect(progressSteps.some((s) => s.includes("Đã dừng môi trường") || s.includes("Environment stopped"))).toBe(false);

        // Now test down with 0 active runs
        runs.length = 0;
        progressSteps.length = 0;
        runner.running.add(repository.sessionName);
        await (lifecycle as any).saveManifest(repository, { ...manifest, status: "up" });

        await lifecycle.down(true);
        expect(progressSteps.some((s) => s.includes("Đang lưu điểm khôi phục (checkpoint)"))).toBe(false);
        expect(progressSteps.some((s) => s.includes("Đã dừng môi trường") || s.includes("Environment stopped"))).toBe(false);
      } finally {
        lockSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("attach() records validation and open steps without emitting 'Returned from interactive session' in progress", async () => {
      const dir = await createFixtureDir("bflow-prog-att-");
      execFileSync("git", ["init", "--quiet", dir]);
      expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
      const repository = await identifyRepository(dir);
      const runner = new MockProcessRunner();
      runner.running.add(repository.sessionName);
      const manifest = createTestManifest(repository);

      const manager: SessionLifecycleManager = {
        init: vi.fn(),
        up: vi.fn(),
        down: vi.fn(),
        attach: vi.fn(async () => ({ ok: true, value: manifest.panes[0] })),
        getManifest: vi.fn(async () => ({ ok: true, value: manifest })),
        doctorSession: vi.fn()
      };

      const progressSteps: string[] = [];
      const lifecycle = new EnvironmentLifecycle(dir, {
        runner,
        integration: { manager },
        onProgress: (step) => progressSteps.push(step)
      });

      const lockModule = await import("../src/lifecycle-lock.js");
      const lockSpy = vi.spyOn(lockModule, "withLifecycleLock").mockImplementation(async (dir, fn) => {
        await mkdir(dir, { recursive: true });
        return fn();
      });

      try {
        await mkdir(join(dir, ".bflow/state"), { recursive: true });
        await (lifecycle as any).saveManifest(repository, manifest);
        const attachResult = await lifecycle.attach();
        expect(attachResult.sessionId).toBe(repository.sessionName);

        expect(progressSteps).toContain("Đang xác thực phiên và chuyển tiêu điểm tới khung chat Conversation...");
        expect(progressSteps).toContain("Đang mở giao diện kết nối trực tiếp Herdr...");
        expect(progressSteps.some((s) => s.includes("Đã rời khung chat") || s.includes("Returned from interactive"))).toBe(false);

        const formatted = formatCommandSuccess("attach", attachResult, false);
        expect(formatted).toContain("[HOÀN TẤT] Đã rời khung chat Conversation.");
      } finally {
        lockSpy.mockRestore();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("8. Review Regression Suite (Findings 1-5)", () => {
    describe("Finding 1: Consistent JSON Policy", () => {
      it("main version command outputs JSON envelope when context.presentation.json is true", async () => {
        const stdoutLines: string[] = [];
        const customIo: CliIo = {
          stdout: (m) => stdoutLines.push(m),
          stderr: () => {}
        };
        const res = await main(["version"], {
          presentation: { json: true },
          io: customIo
        });
        expect(res.ok).toBe(true);
        expect(res.exitCode).toBe(0);
        expect(stdoutLines.length).toBe(1);
        const parsed = JSON.parse(stdoutLines[0]!);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("version");
        expect(parsed.data).toEqual({ version: "0.1.0" });
      });

      it("main help command outputs JSON envelope when context.presentation.json is true", async () => {
        const stdoutLines: string[] = [];
        const customIo: CliIo = {
          stdout: (m) => stdoutLines.push(m),
          stderr: () => {}
        };
        const res = await main(["help"], {
          presentation: { json: true },
          io: customIo
        });
        expect(res.ok).toBe(true);
        expect(res.exitCode).toBe(0);
        const parsed = JSON.parse(stdoutLines[0]!);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("help");
        expect(typeof parsed.data.helpText).toBe("string");
      });

      it("main ordinary Runtime success outputs JSON envelope when context.presentation.json is true", async () => {
        const stdoutLines: string[] = [];
        const customIo: CliIo = {
          stdout: (m) => stdoutLines.push(m),
          stderr: () => {}
        };
        const fakeSnapshot: WorkflowRunSnapshot = WorkflowRunSnapshotSchema.parse({
          runId: "run-rt-success-1",
          workflowId: "sdlc",
          workflowVersion: "1.0.0",
          status: "succeeded",
          version: 1,
          lastEventSequence: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
          input: {}
        });
        const fakeRuntime: any = {
          getRun: vi.fn().mockResolvedValue({ ok: true, value: fakeSnapshot })
        };
        const res = await main(["status", "run-rt-success-1"], {
          presentation: { json: true },
          io: customIo,
          runtime: fakeRuntime
        });
        expect(res.ok).toBe(true);
        expect(res.exitCode).toBe(0);
        const parsed = JSON.parse(stdoutLines[0]!);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("status");
        expect(parsed.data.runId).toBe("run-rt-success-1");
      });

      it("main ordinary Runtime failure outputs JSON envelope when context.presentation.json is true", async () => {
        const stderrLines: string[] = [];
        const customIo: CliIo = {
          stdout: () => {},
          stderr: (m) => stderrLines.push(m)
        };
        const fakeRuntime: any = {
          getRun: vi.fn().mockResolvedValue({
            ok: false,
            error: { code: "not_found", retryable: false, message: "Run 'run-missing' not found." }
          })
        };
        const res = await main(["status", "run-missing"], {
          presentation: { json: true },
          io: customIo,
          runtime: fakeRuntime
        });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(1);
        const parsed = JSON.parse(stderrLines[0]!);
        expect(parsed.ok).toBe(false);
        expect(parsed.command).toBe("status");
        expect(parsed.error.code).toBe("not_found");
      });

      it("direct runCli and executeCommand output JSON envelope with context.presentation.json=true", async () => {
        const runCliRes = await runCli(["version"], { presentation: { json: true } });
        expect(runCliRes.ok).toBe(true);
        const parsedCli = JSON.parse(runCliRes.stdout);
        expect(parsedCli.ok).toBe(true);
        expect(parsedCli.command).toBe("version");

        const parsedArgs = parseCliArgs(["version"]);
        expect(parsedArgs.ok).toBe(true);
        if (parsedArgs.ok) {
          const execRes = await executeCommand(parsedArgs.value, { presentation: { json: true } });
          expect(execRes.ok).toBe(true);
          const parsedExec = JSON.parse(execRes.stdout);
          expect(parsedExec.ok).toBe(true);
          expect(parsedExec.command).toBe("version");
        }
      });

      it("usage error with context.presentation.json=true outputs JSON envelope", async () => {
        const stderrLines: string[] = [];
        const customIo: CliIo = {
          stdout: () => {},
          stderr: (m) => stderrLines.push(m)
        };
        const res = await main(["--unrecognized-option-xyz"], {
          presentation: { json: true },
          io: customIo
        });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(2);
        const parsed = JSON.parse(stderrLines[0]!);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("validation");
      });

      it("explicit argv --json is never disabled by context false", async () => {
        const stdoutLines: string[] = [];
        const customIo: CliIo = {
          stdout: (m) => stdoutLines.push(m),
          stderr: () => {}
        };
        const res = await main(["version", "--json"], {
          presentation: { json: false },
          io: customIo
        });
        expect(res.ok).toBe(true);
        const parsed = JSON.parse(stdoutLines[0]!);
        expect(parsed.ok).toBe(true);
        expect(parsed.command).toBe("version");
      });

      it("no JSON flags preserves unchanged human output", async () => {
        const stdoutLines: string[] = [];
        const customIo: CliIo = {
          stdout: (m) => stdoutLines.push(m),
          stderr: () => {}
        };
        const res = await main(["version"], {
          io: customIo
        });
        expect(res.ok).toBe(true);
        expect(stdoutLines[0]).toBe("0.1.0");
      });
    });

    describe("Finding 2: Wrong recovery guidance for typed uncertain delivery", () => {
      it("unknown_delivery without literal code in message provides inspect and reconcile guidance", () => {
        const error: ContractError = {
          code: "unknown_delivery",
          retryable: false,
          manualInterventionRequired: true,
          message: "The provider connection closed while submitting work."
        };
        const formatted = formatCommandError(error, "run", false);
        expect(formatted).toContain("Kiểm tra 'bflow status' hoặc 'bflow doctor' để đối soát phiên hiện tại trước khi thử lại; không tự động gửi lại.");
        expect(formatted).not.toContain("bflow run --help");
        // Verify underlying error is not mutated
        expect(error.code).toBe("unknown_delivery");
        expect(error.message).toBe("The provider connection closed while submitting work.");
      });

      it("observation_only timeout containing auth-like text prioritizes reconcile guidance over auth login", () => {
        const error: ContractError = {
          code: "timeout",
          retryable: true,
          retrySafety: "observation_only",
          message: "Timeout during operation. Run claude auth login to refresh session."
        };
        const formatted = formatCommandError(error, "up", false);
        expect(formatted).toContain("Kiểm tra 'bflow status' hoặc 'bflow doctor' để đối soát phiên hiện tại trước khi thử lại; không tự động gửi lại.");
        expect(formatted).not.toContain("Xác thực bằng 'claude auth login'");
      });

      it("typed corruption code provides preserve-state advice", () => {
        const error: ContractError = {
          code: "corruption",
          retryable: false,
          message: "State file payload is invalid."
        };
        const formatted = formatCommandError(error, "status", false);
        expect(formatted).toContain("Giữ nguyên thư mục .bflow và chạy 'bflow doctor' để chẩn đoán tính toàn vẹn trạng thái.");
      });
    });

    describe("Finding 3: Human secret redaction", () => {
      it("redacts quoted JSON secret keys and values completely", () => {
        const jsonSecret = JSON.stringify({
          token: "SYNTHETIC_SECRET",
          password: "SYNTHETIC_PASSWORD",
          api_key: "SYNTHETIC_API"
        });
        const redacted = redactSensitive(jsonSecret);
        expect(redacted).not.toContain("SYNTHETIC_SECRET");
        expect(redacted).not.toContain("SYNTHETIC_PASSWORD");
        expect(redacted).not.toContain("SYNTHETIC_API");
        expect(redacted).toContain('"token":"[REDACTED]"');
        expect(redacted).toContain('"password":"[REDACTED]"');
        expect(redacted).toContain('"api_key":"[REDACTED]"');
      });

      it("redacts complete RFC-style Bearer tokens including +, /, ~, and = padding", () => {
        const header = "Authorization: Bearer abc+/SYNTHETIC_REMAINDER==";
        const redacted = redactSensitive(header);
        expect(redacted).toBe("Authorization: Bearer [REDACTED_TOKEN]");
        expect(redacted).not.toContain("abc+");
        expect(redacted).not.toContain("SYNTHETIC_REMAINDER");
        expect(redacted).not.toContain("==");
      });

      it("handles quoted values with spaces and escaped quotes without false positives on task-*", () => {
        const text = 'Config: {"password":"my secret \\"escaped\\" password"} for task-123-execution';
        const redacted = redactSensitive(text);
        expect(redacted).not.toContain("my secret");
        expect(redacted).not.toContain("escaped");
        expect(redacted).toContain("task-123-execution");
      });

      it("redacts secrets in actual human formatter error, check, and status text", () => {
        const humanErr = formatCommandError(
          {
            code: "validation",
            retryable: false,
            message: 'Failure with Bearer abc+/SYNTHETIC_TOKEN== and {"token":"SYNTHETIC_KEY"}'
          },
          "run",
          false
        );
        expect(humanErr).not.toContain("SYNTHETIC_TOKEN");
        expect(humanErr).not.toContain("SYNTHETIC_KEY");

        const doctorReport = {
          workspaceRoot: "/workspace",
          sessionId: "sess-1",
          healthy: false,
          checks: [
            {
              name: "auth",
              status: "failed" as const,
              message: "Check leaked Bearer test+/SYNTHETIC_SECRET== in config"
            }
          ]
        };
        const doctorHuman = formatCommandSuccess("doctor", doctorReport, false);
        expect(doctorHuman).not.toContain("SYNTHETIC_SECRET");

        const statusData = {
          workspaceRoot: "/workspace",
          sessionName: "sess-1",
          server: "running" as const,
          configuration: "valid" as const,
          manifest: null,
          liveObservation: true,
          issues: ['Observed {"api_key":"SYNTHETIC_API_KEY"} leak']
        };
        const statusHuman = formatEnvironmentStatus(statusData, false);
        expect(statusHuman).not.toContain("SYNTHETIC_API_KEY");
      });

      it("handled JSON envelope values remain exact and unredacted", () => {
        const secretError: ContractError = {
          code: "validation",
          retryable: false,
          message: 'Error with {"token":"SYNTHETIC_EXACT_TOKEN"}'
        };
        const jsonOut = formatCommandError(secretError, "run", true);
        const parsed = JSON.parse(jsonOut);
        expect(parsed.error.message).toBe('Error with {"token":"SYNTHETIC_EXACT_TOKEN"}');
      });
    });

    describe("Finding 4: Unexpected lifecycle error schema compliance", () => {
      it("normalizes empty Error from lifecycle.up to valid ContractErrorSchema", async () => {
        const upSpy = vi.spyOn(EnvironmentLifecycle.prototype, "up").mockRejectedValue(new Error(""));
        const stderrLines: string[] = [];
        const customIo: CliIo = {
          stdout: () => {},
          stderr: (m) => stderrLines.push(m)
        };
        try {
          const res = await main(["up", "--json"], { io: customIo });
          expect(res.ok).toBe(false);
          expect(res.exitCode).toBe(1);
          expect(res.error).toBeDefined();
          const schemaValidation = ContractErrorSchema.safeParse(res.error);
          expect(schemaValidation.success).toBe(true);
          expect(res.error!.message.length).toBeGreaterThan(0);

          const jsonEnvelope = JSON.parse(stderrLines[0]!);
          expect(jsonEnvelope.ok).toBe(false);
          const envelopeValidation = ContractErrorSchema.safeParse(jsonEnvelope.error);
          expect(envelopeValidation.success).toBe(true);
        } finally {
          upSpy.mockRestore();
        }
      });

      it("normalizes empty string and invalid structured errno to valid ContractErrorSchema", async () => {
        const upSpy = vi.spyOn(EnvironmentLifecycle.prototype, "up").mockRejectedValue("");
        try {
          const res = await main(["up", "--json"]);
          expect(res.ok).toBe(false);
          expect(ContractErrorSchema.safeParse(res.error).success).toBe(true);
          expect(res.error!.message).toBe("An unexpected internal error occurred.");
        } finally {
          upSpy.mockRestore();
        }

        const downSpy = vi.spyOn(EnvironmentLifecycle.prototype, "down").mockRejectedValue({
          code: "ENOENT",
          errno: -2,
          syscall: "open",
          message: ""
        });
        try {
          const res = await main(["down", "--yes", "--json"]);
          expect(res.ok).toBe(false);
          expect(ContractErrorSchema.safeParse(res.error).success).toBe(true);
          expect(res.error!.message).toBe("An unexpected internal error occurred.");
        } finally {
          downSpy.mockRestore();
        }
      });

      it("preserves valid handled EnvironmentError payloads", async () => {
        const conflictErr: ContractError = {
          code: "conflict",
          retryable: true,
          message: "A concurrent lifecycle operation is in progress."
        };
        const upSpy = vi.spyOn(EnvironmentLifecycle.prototype, "up").mockRejectedValue(
          new EnvironmentError(conflictErr)
        );
        try {
          const res = await main(["up", "--json"]);
          expect(res.ok).toBe(false);
          expect(res.error).toEqual(conflictErr);
        } finally {
          upSpy.mockRestore();
        }
      });
    });

    describe("Finding 5: Error diagnostic bounds", () => {
      it("bounds huge diagnostic details on human output while preserving raw handled JSON", () => {
        const hugeError: ContractError = {
          code: "validation",
          retryable: false,
          message: "Failure",
          details: { stage: "X".repeat(100000) }
        };
        const conciseOut = formatCommandError(hugeError, "up", false);
        expect(conciseOut).not.toContain("Chi tiết:");

        const humanOut = formatCommandError(hugeError, "up", false, { debug: true });
        expect(humanOut.length).toBeLessThan(1000);
        expect(humanOut).toContain("Chi tiết:");
        expect(humanOut).toContain("... [truncated]");

        const jsonOut = formatCommandError(hugeError, "up", true);
        const parsed = JSON.parse(jsonOut);
        expect((parsed.error.details.stage as string).length).toBe(100000);
      });

      it("retains useful operational IDs in safe details without premature truncation", () => {
        const error: ContractError = {
          code: "conflict",
          retryable: true,
          message: "Conflict detected",
          details: {
            runId: "run-custom-long-identifier-1234567890-abcdef-ghijk-lmnop-qrstuvwxyz-67890",
            paneId: "w1:p0",
            stage: "native_startup"
          }
        };
        const conciseOut = formatCommandError(error, "status", false);
        expect(conciseOut).not.toContain("Chi tiết:");

        const humanOut = formatCommandError(error, "status", false, { debug: true });
        expect(humanOut).toContain("runId: run-custom-long-identifier-1234567890-abcdef-ghijk-lmnop-qrstuvwxyz-67890");
        expect(humanOut).toContain("paneId: w1:p0");
        expect(humanOut).toContain("stage: native_startup");
      });
    });

    describe("setup and doctor human output", () => {
      it("colors setup state and sanitizes diagnostics while retaining approval warnings", () => {
        const setup = {
          mode: "apply", machineId: "machine-1", os: "linux", serviceManagerKind: "systemd-user",
          plan: { planId: "plan-1", revision: 1, steps: [{ stepId: "install-node", componentId: "node", action: "install", requiresApproval: true }] },
          tools: [{ toolId: "node", status: "missing", version: "none" }],
          skills: { catalogLoaded: true, skillCount: 2, syncedManifests: 1, storeRoot: "/safe/store" },
          diagnostics: ["Bearer abcdefghijklmnopqrstuvwxyz\u001b[31m"]
        } as any;
        const rendered = formatCommandSuccess("setup", setup, false, { stdoutColor: true, debug: true });
        expect(rendered).toContain(ANSI.cyan);
        expect(rendered).toContain(ANSI.yellow);
        expect(rendered).toContain("[REDACTED_TOKEN]");
        expect(rendered).not.toContain("\u001b[31mBearer");
      });

      it("colors and sanitizes grouped doctor findings", () => {
        const report = {
          healthy: false, workspaceRoot: "/repo", sessionId: "session-1",
          checks: [{ name: "provider", status: "failed", message: "not ready", remediation: "Run setup" }],
          metadata: { groups: [{ name: "Providers", items: [{ component: "claude", status: "blocked", reason: "token=secret-value", remediation: "Authenticate" }] }] }
        } as any;
        const rendered = formatCommandSuccess("doctor", report, false, { stdoutColor: true });
        expect(rendered).toContain(ANSI.red);
        expect(rendered).toContain(ANSI.cyan);
        expect(rendered).toContain("token=[REDACTED]");
      });

      it("renders concise output by default and full details with --debug, showing green checkmark ✓ on completed tasks", () => {
        const snapshot: WorkflowRunSnapshot = {
          runId: "run-tick-1",
          workflowId: "sdlc",
          workflowVersion: "1.0.0",
          status: "succeeded",
          version: 2,
          lastEventSequence: 4,
          createdAt: "2026-10-17T00:00:00Z",
          updatedAt: "2026-10-17T00:05:00Z",
          tasks: [
            {
              taskId: "spec",
              status: "succeeded",
              attempt: 1,
              generation: 0,
              version: 1
            },
            {
              taskId: "implement",
              status: "running",
              attempt: 2,
              generation: 0,
              version: 1
            }
          ],
          input: {}
        };

        const concise = formatCommandSuccess("status", snapshot, false, { color: true });
        expect(stripAnsi(concise)).toContain("✦ Luồng chạy: run-tick-1 (sdlc) — SUCCEEDED ✓");
        expect(stripAnsi(concise)).toContain("• spec            [SUCCEEDED] ✓");
        expect(stripAnsi(concise)).toContain("• implement       [RUNNING]");
        expect(stripAnsi(concise)).not.toContain("• implement       [RUNNING] ✓");
        expect(concise).toContain("\x1b[32m✓\x1b[0m");
        expect(stripAnsi(concise)).not.toContain("Phiên bản:");
        expect(stripAnsi(concise)).not.toContain("lần thử=");

        const debugOut = formatCommandSuccess("status", snapshot, false, { color: true, debug: true });
        expect(stripAnsi(debugOut)).toContain("Phiên bản:       v1.0.0 (bản ghi v2)");
        expect(stripAnsi(debugOut)).toContain("Tạo lúc:         2026-10-17T00:00:00Z");
        expect(stripAnsi(debugOut)).toContain("(lần thử=1)");
        expect(stripAnsi(debugOut)).toContain("(lần thử=2)");
      });
    });
  });
});
