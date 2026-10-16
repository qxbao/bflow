import { describe, expect, it, vi } from "vitest";
import type { DomainEvent, RetryPolicy, WorkflowRunSnapshot } from "@bflow/contracts";
import {
  DEFAULT_REDACTED_PLACEHOLDER,
  isSensitiveKey,
  redactSecrets,
  redactString
} from "../../src/resilience/redaction.js";
import { StructuredLogger } from "../../src/resilience/structured-logger.js";
import {
  computeBackoffDelayMs,
  executeWithRetry,
  isRetryEligible,
  withOperationTimeout
} from "../../src/resilience/retry-backoff.js";
import { BoundedConcurrencyLimiter } from "../../src/resilience/concurrency-limiter.js";
import {
  extractVerifiedModelUsage,
  ObservabilityTracker,
  type AgentAssignmentMetric,
  type ContextBundleMetric,
  type TestCheckMetric,
  type VerificationCycleMetric
} from "../../src/observability/metrics.js";

describe("Resilience & Observability Module", () => {
  describe("A. Secret Redaction", () => {
    it("identifies sensitive keys and respects non-secret domain tokens whitelist", () => {
      // Sensitive keys
      expect(isSensitiveKey("password")).toBe(true);
      expect(isSensitiveKey("client_secret")).toBe(true);
      expect(isSensitiveKey("clientSecret")).toBe(true);
      expect(isSensitiveKey("apiKey")).toBe(true);
      expect(isSensitiveKey("api_key")).toBe(true);
      expect(isSensitiveKey("openai_api_key")).toBe(true);
      expect(isSensitiveKey("HERDR_TOKEN")).toBe(true);
      expect(isSensitiveKey("authorization")).toBe(true);
      expect(isSensitiveKey("database_url")).toBe(true);
      expect(isSensitiveKey("connection_string")).toBe(true);

      // Whitelisted non-secret keys must NEVER be treated as sensitive
      expect(isSensitiveKey("fencingToken")).toBe(false);
      expect(isSensitiveKey("totalTokens")).toBe(false);
      expect(isSensitiveKey("inputTokens")).toBe(false);
      expect(isSensitiveKey("outputTokens")).toBe(false);
      expect(isSensitiveKey("maxTokens")).toBe(false);
      expect(isSensitiveKey("promptTokens")).toBe(false);
      expect(isSensitiveKey("completionTokens")).toBe(false);
      expect(isSensitiveKey("cancelToken")).toBe(false);
      expect(isSensitiveKey("nextPageToken")).toBe(false);
      expect(isSensitiveKey("schemaVersion")).toBe(false);
    });

    it("redacts PEM private keys, headers, URLs, and token prefixes from strings", () => {
      const pemKey = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----`;
      expect(redactString(pemKey)).toBe(DEFAULT_REDACTED_PLACEHOLDER);

      // Bearer and Basic headers
      expect(redactString("Authorization: Bearer secret-token-123")).toBe(
        "Authorization: Bearer [REDACTED]"
      );
      expect(redactString("Auth: Basic dXNlcjpwYXNz")).toBe("Auth: Basic [REDACTED]");

      // URL user:password
      expect(redactString("Connecting to https://admin:supersecret@cluster.internal:5432/db")).toBe(
        "Connecting to https://admin:[REDACTED]@cluster.internal:5432/db"
      );

      // Known token prefixes: sk-, ghp_, gho_, ghs_, github_pat_, xoxb-, AIza, JWT
      expect(redactString("Using key sk-1234567890123456 for api")).toBe(
        "Using key [REDACTED] for api"
      );
      expect(redactString("GitHub token ghp_12345678901234567890")).toBe(
        "GitHub token [REDACTED]"
      );
      expect(redactString("JWT token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe(
        "JWT token [REDACTED]"
      );

      // CLI and env assignments
      expect(redactString("cmd --token=mysecret123 --other=value")).toBe(
        "cmd --token=[REDACTED] --other=value"
      );
      expect(redactString("OPENAI_API_KEY=sk-abc1234567890")).toBe("OPENAI_API_KEY=[REDACTED]");

      // Whitelisted non-secret CLI assignments preserved
      expect(redactString("--maxTokens=2048 --fencingToken=ft-42")).toBe(
        "--maxTokens=2048 --fencingToken=ft-42"
      );
    });

    it("supports customSecrets and additional patterns", () => {
      const customSecret = "super-confidential-string";
      const result = redactString(`The secret is ${customSecret}!`, {
        customSecrets: [customSecret]
      });
      expect(result).toBe("The secret is [REDACTED]!");

      const customPatternResult = redactString("Custom identifier: CUST-9999-SECRET", {
        additionalValuePatterns: [/CUST-\d+-SECRET/g]
      });
      expect(customPatternResult).toBe("Custom identifier: [REDACTED]");
    });

    it("deeply redacts nested objects, arrays, Maps, Sets, and Errors while handling circular references", () => {
      const payload: Record<string, unknown> = {
        runId: "run-001",
        fencingToken: "fence-100",
        totalTokens: 500,
        credentials: "cred-secret-value",
        config: {
          password: "my-password",
          apiKey: "sk-abcdef123456789",
          normalField: "public"
        },
        env: ["PATH=/bin", "HERDR_TOKEN=secret_herdr_token_abc"],
        tags: new Set(["public", "sk-123456789012"]),
        metadata: new Map<string, unknown>([
          ["secret", "shhh"],
          ["safe", "ok"]
        ])
      };

      // Add circular reference
      payload["self"] = payload;

      const redacted = redactSecrets(payload);
      expect(redacted["runId"]).toBe("run-001");
      expect(redacted["fencingToken"]).toBe("fence-100");
      expect(redacted["totalTokens"]).toBe(500);
      expect(redacted["credentials"]).toBe(DEFAULT_REDACTED_PLACEHOLDER);
      expect((redacted["config"] as any)["password"]).toBe(DEFAULT_REDACTED_PLACEHOLDER);
      expect((redacted["config"] as any)["apiKey"]).toBe(DEFAULT_REDACTED_PLACEHOLDER);
      expect((redacted["config"] as any)["normalField"]).toBe("public");
      expect((redacted["env"] as string[])[1]).toBe("HERDR_TOKEN=[REDACTED]");
      expect(redacted["self"]).toBe("[Circular]");

      // Errors
      const cause = new Error("Underlying error with sk-1234567890123");
      const err = new Error("Failed connecting to https://user:pass@host.com");
      (err as any).cause = cause;
      (err as any).apiKey = "sk-error-key-12345";

      const redactedErr = redactSecrets(err);
      expect(redactedErr.message).toBe("Failed connecting to https://user:[REDACTED]@host.com");
      expect((redactedErr as any).apiKey).toBe(DEFAULT_REDACTED_PLACEHOLDER);
      expect(((redactedErr as any).cause as Error).message).toBe("Underlying error with [REDACTED]");
    });
  });

  describe("B. Structured Logger", () => {
    it("respects log levels, redacts secrets, extracts durationMs, and emits to sink", () => {
      const sinkEntries: any[] = [];
      const fixedDate = new Date("2026-10-16T12:00:00.000Z");

      const logger = new StructuredLogger({
        component: "dispatcher",
        minLevel: "info",
        clock: () => fixedDate,
        sink: (entry) => sinkEntries.push(entry)
      });

      // debug should be ignored because minLevel is info
      logger.debug("test.debug", "Should not be logged");
      expect(logger.getEntries().length).toBe(0);

      // info with durationMs and secret in message/details
      logger.info("task.dispatched", "Dispatched with apiKey sk-12345678901234", {
        durationMs: 45,
        token: "secret-token",
        fencingToken: "fence-abc"
      });

      const entries = logger.getEntries();
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.schemaVersion).toBe(1);
      expect(entry.timestamp).toBe("2026-10-16T12:00:00.000Z");
      expect(entry.level).toBe("info");
      expect(entry.event).toBe("task.dispatched");
      expect(entry.message).toBe("Dispatched with apiKey [REDACTED]");
      expect(entry.durationMs).toBe(45);
      expect(entry.details?.["token"]).toBe("[REDACTED]");
      expect(entry.details?.["fencingToken"]).toBe("fence-abc");
      expect(sinkEntries.length).toBe(1);
    });

    it("creates child loggers that inherit and merge context, sharing ring buffer", () => {
      const logger = new StructuredLogger({
        component: "root",
        baseContext: { runId: "run-root" }
      });

      const child = logger.child({
        taskId: "task-1",
        component: "worker"
      });

      child.warn("task.warn", "Warning occurred");

      const rootEntries = logger.getEntries();
      const childEntries = child.getEntries();
      expect(rootEntries.length).toBe(1);
      expect(childEntries.length).toBe(1);
      expect(rootEntries[0]?.runId).toBe("run-root");
      expect(rootEntries[0]?.taskId).toBe("task-1");
      expect(rootEntries[0]?.component).toBe("worker");

      // Ring buffer cap test
      const smallLogger = new StructuredLogger({ maxEntries: 3 });
      smallLogger.info("e1", "m1");
      smallLogger.info("e2", "m2");
      smallLogger.info("e3", "m3");
      smallLogger.info("e4", "m4");
      expect(smallLogger.getEntries().length).toBe(3);
      expect(smallLogger.getEntries()[0]?.event).toBe("e2");

      // JSONL output
      const jsonl = smallLogger.toJsonLines();
      expect(jsonl.split("\n").length).toBe(3);

      smallLogger.clear();
      expect(smallLogger.getEntries().length).toBe(0);
    });
  });

  describe("C. Retry Backoff & Timeout Handling", () => {
    it("computes backoff delays for fixed, linear, and exponential strategies with jitter", () => {
      const fixedPolicy: RetryPolicy = {
        maxAttempts: 3,
        strategy: "fixed",
        initialDelayMs: 100,
        maxDelayMs: 500,
        jitter: false
      };
      expect(computeBackoffDelayMs(fixedPolicy, 1)).toBe(100);
      expect(computeBackoffDelayMs(fixedPolicy, 2)).toBe(100);

      const linearPolicy: RetryPolicy = {
        maxAttempts: 4,
        strategy: "linear",
        initialDelayMs: 50,
        maxDelayMs: 200,
        jitter: false
      };
      expect(computeBackoffDelayMs(linearPolicy, 1)).toBe(50);
      expect(computeBackoffDelayMs(linearPolicy, 2)).toBe(100);
      expect(computeBackoffDelayMs(linearPolicy, 3)).toBe(150);
      expect(computeBackoffDelayMs(linearPolicy, 5)).toBe(200); // clamped to maxDelayMs

      const expPolicy: RetryPolicy = {
        maxAttempts: 4,
        strategy: "exponential",
        initialDelayMs: 100,
        maxDelayMs: 1000,
        multiplier: 2,
        jitter: false
      };
      expect(computeBackoffDelayMs(expPolicy, 1)).toBe(100);
      expect(computeBackoffDelayMs(expPolicy, 2)).toBe(200);
      expect(computeBackoffDelayMs(expPolicy, 3)).toBe(400);

      // Jitter test with deterministic random
      const jitterPolicy: RetryPolicy = {
        ...expPolicy,
        jitter: true
      };
      // random = 0.5 -> factor = 0.5 + 0.5*0.5 = 0.75 -> 400 * 0.75 = 300
      expect(computeBackoffDelayMs(jitterPolicy, 3, () => 0.5)).toBe(300);
    });

    it("strictly blocks unknown_delivery, manual_intervention_only, and after_reconciliation from retry", () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        strategy: "fixed",
        initialDelayMs: 100,
        maxDelayMs: 500,
        jitter: false,
        retryableErrorCodes: ["transport_unavailable", "conflict"]
      };

      // Non-retryable error
      expect(
        isRetryEligible({ code: "validation", retryable: false, message: "bad input" }, policy, 1).eligible
      ).toBe(false);

      // Max attempts reached
      expect(
        isRetryEligible({ code: "conflict", retryable: true, message: "conflict" }, policy, 3).eligible
      ).toBe(false);

      // Not in retryableErrorCodes
      expect(
        isRetryEligible(
          { code: "timeout", retryable: true, retrySafety: "observation_only", message: "timed out" },
          policy,
          1
        ).eligible
      ).toBe(false);

      // In retryableErrorCodes
      expect(
        isRetryEligible({ code: "conflict", retryable: true, message: "conflict" }, policy, 1).eligible
      ).toBe(true);

      // Critical safety invariant: unknown_delivery MUST NEVER be retried without reconciliation
      expect(
        isRetryEligible(
          {
            code: "unknown_delivery",
            retryable: false,
            manualInterventionRequired: true,
            message: "lost contact"
          },
          policy,
          1
        ).eligible
      ).toBe(false);

      // after_reconciliation must also be blocked until reconciled
      expect(
        isRetryEligible(
          {
            code: "timeout",
            retryable: true,
            retrySafety: "after_reconciliation" as any,
            message: "timeout"
          } as any,
          policy,
          1
        ).eligible
      ).toBe(false);
    });

    it("enforces operation timeout and returns retrySafety after_reconciliation without leaking timers", async () => {
      const slowOp = vi.fn(
        () =>
          new Promise<{ ok: true; value: string }>((resolve) => {
            setTimeout(() => resolve({ ok: true, value: "done" }), 500);
          })
      );

      const result = await withOperationTimeout(slowOp, 50);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("timeout");
        expect(result.error.retryable).toBe(true);
        expect((result.error as any).retrySafety).toBe("after_reconciliation");
      }

      // Fast operation should succeed
      const fastOp = vi.fn(async () => ({ ok: true as const, value: 42 }));
      const fastResult = await withOperationTimeout(fastOp, 500);
      expect(fastResult.ok).toBe(true);
      if (fastResult.ok) {
        expect(fastResult.value).toBe(42);
      }
    });

    it("executes operations with retry and accumulates delays", async () => {
      let callCount = 0;
      const onRetry = vi.fn();
      const mockSleep = vi.fn(async () => {});

      const policy: RetryPolicy = {
        maxAttempts: 3,
        strategy: "fixed",
        initialDelayMs: 50,
        maxDelayMs: 200,
        jitter: false
      };

      const result = await executeWithRetry(
        async (attempt) => {
          callCount++;
          if (attempt < 3) {
            return {
              ok: false,
              error: { code: "transport_unavailable", retryable: true, message: "temp down" }
            };
          }
          return { ok: true, value: "success!" };
        },
        {
          policy,
          sleep: mockSleep,
          onRetry
        }
      );

      expect(result.ok).toBe(true);
      expect(callCount).toBe(3);
      expect(result.attempts).toBe(3);
      expect(result.totalDelayMs).toBe(100); // 50ms + 50ms
      expect(onRetry).toHaveBeenCalledTimes(2);
    });
  });

  describe("D. Bounded Concurrency Limiter", () => {
    it("validates constructor argument", () => {
      expect(() => new BoundedConcurrencyLimiter(0)).toThrow();
      expect(() => new BoundedConcurrencyLimiter(-1)).toThrow();
      expect(() => new BoundedConcurrencyLimiter(1.5)).toThrow();
    });

    it("enforces maxConcurrency cap and processes queued requests in FIFO order", async () => {
      const limiter = new BoundedConcurrencyLimiter(2);
      expect(limiter.maxConcurrency).toBe(2);

      const acq1 = await limiter.acquire("key-1");
      const acq2 = await limiter.acquire("key-2");
      expect(acq1.ok).toBe(true);
      expect(acq2.ok).toBe(true);
      expect(limiter.activeCount).toBe(2);
      expect(limiter.activeKeys).toEqual(["key-1", "key-2"]);

      // Third acquisition will queue
      const order: number[] = [];
      const acq3Promise = limiter.acquire("key-3").then((res) => {
        order.push(3);
        return res;
      });
      const acq4Promise = limiter.acquire("key-4").then((res) => {
        order.push(4);
        return res;
      });

      expect(limiter.pendingCount).toBe(2);

      // Release first slot -> should unblock acq3 first (FIFO)
      if (acq1.ok) {
        acq1.value();
      }
      const acq3 = await acq3Promise;
      expect(acq3.ok).toBe(true);
      expect(order).toEqual([3]);
      expect(limiter.activeCount).toBe(2);

      // Release second slot -> should unblock acq4
      if (acq2.ok) {
        acq2.value();
      }
      const acq4 = await acq4Promise;
      expect(acq4.ok).toBe(true);
      expect(order).toEqual([3, 4]);

      // Release remaining slots
      if (acq3.ok) acq3.value();
      if (acq4.ok) acq4.value();
      expect(limiter.activeCount).toBe(0);
      expect(limiter.pendingCount).toBe(0);
    });

    it("supports cancellation and timeout for queued acquisitions", async () => {
      const limiter = new BoundedConcurrencyLimiter(1);
      const acq1 = await limiter.acquire();
      expect(acq1.ok).toBe(true);

      const controller = new AbortController();
      const acqAbortPromise = limiter.acquire("aborted", { signal: controller.signal });
      controller.abort();
      const abortRes = await acqAbortPromise;
      expect(abortRes.ok).toBe(false);
      if (!abortRes.ok) {
        expect(abortRes.error.code).toBe("cancelled");
      }

      const timeoutRes = await limiter.acquire("timed-out", { timeoutMs: 20 });
      expect(timeoutRes.ok).toBe(false);
      if (!timeoutRes.ok) {
        expect(timeoutRes.error.code).toBe("timeout");
      }

      if (acq1.ok) acq1.value();
    });

    it("quiesces by rejecting new intake and waiting for active slots to drain", async () => {
      const limiter = new BoundedConcurrencyLimiter(2);
      const acq1 = await limiter.acquire("slot-1");
      expect(acq1.ok).toBe(true);

      let quiesceFinished = false;
      const quiescePromise = limiter.quiesce().then((res) => {
        quiesceFinished = true;
        return res;
      });

      expect(limiter.isQuiescing).toBe(true);

      // New acquisitions are rejected immediately while quiescing
      const rejectedAcq = await limiter.acquire("slot-new");
      expect(rejectedAcq.ok).toBe(false);
      if (!rejectedAcq.ok) {
        expect(rejectedAcq.error.code).toBe("conflict");
      }

      expect(quiesceFinished).toBe(false);

      // Release active slot
      if (acq1.ok) acq1.value();

      const quiesceRes = await quiescePromise;
      expect(quiesceRes.ok).toBe(true);
      expect(quiesceFinished).toBe(true);

      // Resume restores intake
      limiter.resume();
      expect(limiter.isQuiescing).toBe(false);
      const resumedAcq = await limiter.acquire("slot-resumed");
      expect(resumedAcq.ok).toBe(true);
      if (resumedAcq.ok) resumedAcq.value();
    });
  });

  describe("E. Observability Tracker & Strict Model Usage", () => {
    it("strictly refuses to guess tokens or cost when unverified or missing", () => {
      // Missing source or unverified
      expect(extractVerifiedModelUsage(null)).toBeNull();
      expect(extractVerifiedModelUsage({})).toBeNull();
      expect(
        extractVerifiedModelUsage({
          provider: "openai",
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 50,
          source: "estimated"
        })
      ).toBeNull();

      // Negative or non-integer tokens
      expect(
        extractVerifiedModelUsage({
          provider: "openai",
          model: "gpt-4",
          inputTokens: -10,
          outputTokens: 50,
          source: "provider_reported"
        })
      ).toBeNull();
      expect(
        extractVerifiedModelUsage({
          provider: "openai",
          model: "gpt-4",
          inputTokens: 10.5,
          outputTokens: 50,
          source: "provider_reported"
        })
      ).toBeNull();

      // Valid provider-reported usage
      const valid = extractVerifiedModelUsage({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        inputTokens: 1200,
        outputTokens: 350,
        costUsd: 0.0085,
        source: "provider_reported"
      });
      expect(valid).not.toBeNull();
      expect(valid?.totalTokens).toBe(1550);
      expect(valid?.costUsd).toBe(0.0085);
      expect(valid?.source).toBe("provider_reported");

      // Valid without costUsd -> costUsd is null
      const validNoCost = extractVerifiedModelUsage({
        provider: "google",
        model: "gemini-1.5-pro",
        inputTokens: 200,
        outputTokens: 100,
        providerReported: true
      });
      expect(validNoCost).not.toBeNull();
      expect(validNoCost?.costUsd).toBeNull();
    });

    it("tracks run/task durations, retries, reworks, blocked episodes, and agent assignments", () => {
      let currentTime = new Date("2026-10-16T10:00:00.000Z");
      const tracker = new ObservabilityTracker({ clock: () => currentTime });

      const runId = "run-alpha";
      tracker.recordRunStart(runId, "2026-10-16T10:00:00.000Z");

      // Task 1 execution
      tracker.recordTaskStart(runId, "task-1", 1, "2026-10-16T10:01:00.000Z");

      // Blocked episode (e.g. approval requested)
      const epId = tracker.recordBlockedEpisodeStart(
        runId,
        "task-1",
        "2026-10-16T10:02:00.000Z",
        "awaiting_approval"
      );
      tracker.recordBlockedEpisodeEnd(runId, epId, "2026-10-16T10:05:00.000Z"); // 3 minutes = 180,000ms

      // Task 1 completion
      tracker.recordTaskCompletion(runId, "task-1", 1, "succeeded", "2026-10-16T10:10:00.000Z");

      // Retry & rework recording
      tracker.recordRetry(runId, "task-1");
      tracker.recordRework(runId, "task-1");

      // Agent Assignment
      const assignment: AgentAssignmentMetric = {
        assignmentId: "req-1",
        runId,
        taskId: "task-1",
        attemptId: "att-1",
        role: "developer",
        agentId: "agent-01",
        paneId: "pane-main",
        fencingToken: "fence-tok-1",
        assignedAt: "2026-10-16T10:01:00.000Z",
        status: "bound"
      };
      tracker.recordAgentAssignment(assignment);
      tracker.updateAgentAssignment("req-1", { status: "released", releasedAt: "2026-10-16T10:10:00.000Z" });

      // Verification cycle & test check
      const cycle: VerificationCycleMetric = {
        cycleId: "vcycle-1",
        runId,
        taskId: "task-1",
        scope: "task",
        iterations: 1,
        maxIterations: 3,
        status: "passed",
        durationMs: 4000,
        findingsCount: 0
      };
      tracker.recordVerificationCycle(cycle);

      const check: TestCheckMetric = {
        checkId: "gate-unit-test",
        runId,
        taskId: "task-1",
        status: "passed",
        evaluatedAt: "2026-10-16T10:09:00.000Z"
      };
      tracker.recordTestCheck(check);

      // Context bundle
      const bundle: ContextBundleMetric = {
        runId,
        taskId: "task-1",
        role: "developer",
        contextBytes: 15420,
        includedFileCount: 5,
        excludedFileCount: 2,
        contextHash: "hash123",
        recordedAt: "2026-10-16T10:01:00.000Z"
      };
      tracker.recordContextBundle(bundle);

      // Model usage
      tracker.recordModelUsage(runId, {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        inputTokens: 500,
        outputTokens: 250,
        totalTokens: 750,
        costUsd: 0.005,
        source: "provider_reported",
        recordedAt: "2026-10-16T10:05:00.000Z"
      });

      // Run completion
      tracker.recordRunCompletion(runId, "succeeded", "2026-10-16T10:15:00.000Z");

      const report = tracker.getRunReport(runId);
      expect(report).not.toBeNull();
      expect(report?.runDurationMs).toBe(15 * 60 * 1000); // 15 mins
      expect(report?.taskDurations.length).toBe(1);
      expect(report?.taskDurations[0]?.durationMs).toBe(9 * 60 * 1000); // 9 mins
      expect(report?.blockedTimeMs).toBe(3 * 60 * 1000); // 3 mins
      expect(report?.retryCount).toBe(1);
      expect(report?.reworkCount).toBe(1);
      expect(report?.agentAssignments[0]?.status).toBe("released");
      expect(report?.testMetrics.totalChecks).toBe(1);
      expect(report?.testMetrics.passRate).toBe(1);
      expect(report?.contextMetrics.totalContextBytes).toBe(15420);
      expect(report?.modelUsage.length).toBe(1);

      const summary = tracker.getSummary();
      expect(summary.totalRuns).toBe(1);
      expect(summary.completedRuns).toBe(1);
      expect(summary.totalRetries).toBe(1);
      expect(summary.totalReworks).toBe(1);
      expect(summary.totalModelUsage.totalTokens).toBe(750);
      expect(summary.totalModelUsage.totalCostUsd).toBe(0.005);
    });

    it("ingests DomainEvents and snapshot deterministically", () => {
      const tracker = new ObservabilityTracker();
      const runId = "run-ev-1";

      const events: DomainEvent[] = [
        {
          schemaVersion: 1,
          eventId: "ev-1",
          runId,
          sequence: 1,
          aggregateVersion: 1,
          occurredAt: "2026-10-16T11:00:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-1",
          type: "run.created",
          payload: {
            workflowId: "wf-1",
            workflowVersion: "1.0.0"
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-2",
          runId,
          taskId: "task-A",
          sequence: 2,
          aggregateVersion: 2,
          occurredAt: "2026-10-16T11:01:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-2",
          type: "task.status_changed",
          payload: {
            from: "pending",
            to: "running",
            intent: "normal",
            attempt: 1,
            generationFrom: 1,
            generationTo: 1
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-3",
          runId,
          taskId: "task-A",
          sequence: 3,
          aggregateVersion: 3,
          occurredAt: "2026-10-16T11:02:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-3",
          type: "approval.requested",
          payload: {
            approvalId: "app-1",
            runId,
            taskId: "task-A",
            attemptId: "att-1",
            target: "release",
            status: "pending",
            requestedAt: "2026-10-16T11:02:00.000Z",
            requestedBy: "agent-01"
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-4",
          runId,
          taskId: "task-A",
          sequence: 4,
          aggregateVersion: 4,
          occurredAt: "2026-10-16T11:04:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-4",
          type: "approval.decided",
          payload: {
            approvalId: "app-1",
            runId,
            decision: "approved",
            decidedAt: "2026-10-16T11:04:00.000Z",
            decidedBy: "user-admin"
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-5",
          runId,
          taskId: "task-A",
          sequence: 5,
          aggregateVersion: 5,
          occurredAt: "2026-10-16T11:05:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-5",
          type: "task.status_changed",
          payload: {
            from: "running",
            to: "succeeded",
            intent: "normal",
            attempt: 1,
            generationFrom: 1,
            generationTo: 1
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-6",
          runId,
          sequence: 6,
          aggregateVersion: 6,
          occurredAt: "2026-10-16T11:06:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-6",
          type: "run.status_changed",
          payload: {
            from: "running",
            to: "succeeded"
          }
        }
      ];

      const snapshot: WorkflowRunSnapshot = {
        runId,
        workflowId: "wf-1",
        workflowVersion: "1.0.0",
        status: "succeeded",
        createdAt: "2026-10-16T11:00:00.000Z",
        updatedAt: "2026-10-16T11:06:00.000Z",
        version: 6,
        lastEventSequence: 6,
        tasks: [
          {
            taskId: "task-A",
            status: "succeeded",
            attempt: 1,
            generation: 1,
            startedAt: "2026-10-16T11:01:00.000Z",
            completedAt: "2026-10-16T11:05:00.000Z",
            version: 5
          }
        ]
      };

      tracker.ingestDomainEvents(runId, events, snapshot);

      const report = tracker.getRunReport(runId);
      expect(report).not.toBeNull();
      expect(report?.status).toBe("succeeded");
      expect(report?.runDurationMs).toBe(6 * 60 * 1000); // 6 mins
      expect(report?.taskDurations[0]?.durationMs).toBe(4 * 60 * 1000); // 4 mins
      expect(report?.blockedTimeMs).toBe(2 * 60 * 1000); // 2 mins (approval requested to decided)
    });

    it("does not double-count retries when both task.status_changed and task.retry_scheduled occur", () => {
      const tracker = new ObservabilityTracker();
      const runId = "run-retry-test";

      const events: DomainEvent[] = [
        {
          schemaVersion: 1,
          eventId: "ev-1",
          runId,
          sequence: 1,
          aggregateVersion: 1,
          occurredAt: "2026-10-16T12:00:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-1",
          type: "run.created",
          payload: { workflowId: "wf-1", workflowVersion: "1.0.0" }
        },
        {
          schemaVersion: 1,
          eventId: "ev-2",
          runId,
          taskId: "task-1",
          sequence: 2,
          aggregateVersion: 2,
          occurredAt: "2026-10-16T12:01:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-2",
          type: "task.status_changed",
          payload: {
            from: "running",
            to: "retrying",
            intent: "retry",
            attempt: 1,
            generationFrom: 1,
            generationTo: 1
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-3",
          runId,
          taskId: "task-1",
          sequence: 3,
          aggregateVersion: 3,
          occurredAt: "2026-10-16T12:01:05.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-3",
          type: "task.retry_scheduled",
          payload: {
            attempt: 2,
            generation: 1,
            attemptId: "att-2",
            eligibleAt: "2026-10-16T12:02:00.000Z"
          }
        }
      ];

      tracker.ingestDomainEvents(runId, events);
      const report = tracker.getRunReport(runId);
      expect(report?.retryCount).toBe(1);
    });

    it("is 100% idempotent when ingestDomainEvents is called repeatedly with the same events", () => {
      const tracker = new ObservabilityTracker();
      const runId = "run-idempotent";

      const events: DomainEvent[] = [
        {
          schemaVersion: 1,
          eventId: "ev-idem-1",
          runId,
          sequence: 1,
          aggregateVersion: 1,
          occurredAt: "2026-10-16T12:00:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-1",
          type: "run.created",
          payload: { workflowId: "wf-1", workflowVersion: "1.0.0" }
        },
        {
          schemaVersion: 1,
          eventId: "ev-idem-2",
          runId,
          taskId: "task-1",
          sequence: 2,
          aggregateVersion: 2,
          occurredAt: "2026-10-16T12:01:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-2",
          type: "task.retry_scheduled",
          payload: {
            attempt: 2,
            generation: 1,
            attemptId: "att-2",
            eligibleAt: "2026-10-16T12:02:00.000Z"
          }
        },
        {
          schemaVersion: 1,
          eventId: "ev-idem-3",
          runId,
          sequence: 3,
          aggregateVersion: 3,
          occurredAt: "2026-10-16T12:03:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-3",
          type: "quality_gate.evaluated",
          payload: {
            gateId: "gate-1",
            runId,
            taskId: "task-1",
            evaluationId: "eval-1",
            status: "passed",
            findings: [],
            producedArtifacts: [],
            evaluatedAt: "2026-10-16T12:03:00.000Z"
          }
        }
      ];

      tracker.ingestDomainEvents(runId, events);
      const report1 = tracker.getRunReport(runId);

      // Ingest same events again
      tracker.ingestDomainEvents(runId, events);
      const report2 = tracker.getRunReport(runId);

      expect(report1?.retryCount).toBe(report2?.retryCount);
      expect(report1?.testMetrics.totalChecks).toBe(report2?.testMetrics.totalChecks);
      expect(report1?.testMetrics.passedCount).toBe(report2?.testMetrics.passedCount);
      expect(report1?.runDurationMs).toBe(report2?.runDurationMs);
    });

    it("prevents overlapping open blocked episodes when both task.status_changed(to: blocked) and approval/delivery_uncertain occur", () => {
      const nowTime = new Date("2026-10-16T12:10:00.000Z");
      const tracker = new ObservabilityTracker({ clock: () => nowTime });
      const runId = "run-blocked-test";

      const events: DomainEvent[] = [
        {
          schemaVersion: 1,
          eventId: "ev-b-1",
          runId,
          sequence: 1,
          aggregateVersion: 1,
          occurredAt: "2026-10-16T12:00:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-1",
          type: "run.created",
          payload: { workflowId: "wf-1", workflowVersion: "1.0.0" }
        },
        // 1. Task moves to blocked
        {
          schemaVersion: 1,
          eventId: "ev-b-2",
          runId,
          taskId: "task-1",
          sequence: 2,
          aggregateVersion: 2,
          occurredAt: "2026-10-16T12:01:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-2",
          type: "task.status_changed",
          payload: {
            from: "running",
            to: "blocked",
            intent: "normal",
            attempt: 1,
            generationFrom: 1,
            generationTo: 1,
            reason: "blocked"
          }
        },
        // 2. approval.requested also emitted for the same task while already blocked
        {
          schemaVersion: 1,
          eventId: "ev-b-3",
          runId,
          taskId: "task-1",
          sequence: 3,
          aggregateVersion: 3,
          occurredAt: "2026-10-16T12:01:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-3",
          type: "approval.requested",
          payload: {
            approvalId: "app-1",
            runId,
            taskId: "task-1",
            attemptId: "att-1",
            target: "gate",
            status: "pending",
            requestedAt: "2026-10-16T12:01:00.000Z",
            requestedBy: "agent-1"
          }
        },
        // 3. Approval decided at 12:04:00 (3 mins later)
        {
          schemaVersion: 1,
          eventId: "ev-b-4",
          runId,
          taskId: "task-1",
          sequence: 4,
          aggregateVersion: 4,
          occurredAt: "2026-10-16T12:04:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-4",
          type: "approval.decided",
          payload: {
            approvalId: "app-1",
            runId,
            decision: "approved",
            decidedAt: "2026-10-16T12:04:00.000Z",
            decidedBy: "user-1"
          }
        },
        // 4. Task moves back to running at 12:04:00
        {
          schemaVersion: 1,
          eventId: "ev-b-5",
          runId,
          taskId: "task-1",
          sequence: 5,
          aggregateVersion: 5,
          occurredAt: "2026-10-16T12:04:00.000Z",
          correlationId: "corr-1",
          idempotencyKey: "idem-5",
          type: "task.status_changed",
          payload: {
            from: "blocked",
            to: "running",
            intent: "normal",
            attempt: 1,
            generationFrom: 1,
            generationTo: 1
          }
        }
      ];

      tracker.ingestDomainEvents(runId, events);
      const report = tracker.getRunReport(runId);
      // Blocked time must be 3 minutes (180,000ms), NOT 6 minutes!
      expect(report?.blockedTimeMs).toBe(3 * 60 * 1000);
    });

    it("closes superseded attempt timestamps when a retry occurs", () => {
      const nowTime = new Date("2026-10-16T12:20:00.000Z");
      const tracker = new ObservabilityTracker({ clock: () => nowTime });
      const runId = "run-attempt-close";

      // Attempt 1 starts at 12:00:00
      tracker.recordTaskStart(runId, "task-1", 1, "2026-10-16T12:00:00.000Z");

      // Attempt 1 transitions to retrying at 12:05:00
      tracker.recordTaskTransition(
        runId,
        "task-1",
        1,
        "running",
        "retrying",
        "2026-10-16T12:05:00.000Z"
      );

      // Attempt 2 starts at 12:06:00
      tracker.recordTaskStart(runId, "task-1", 2, "2026-10-16T12:06:00.000Z");

      const report = tracker.getRunReport(runId);
      const attempt1 = report?.taskDurations.find((t) => t.attempt === 1);
      const attempt2 = report?.taskDurations.find((t) => t.attempt === 2);

      expect(attempt1?.completedAt).toBe("2026-10-16T12:05:00.000Z");
      expect(attempt1?.durationMs).toBe(5 * 60 * 1000); // exactly 5 mins, not growing with nowTime
      expect(attempt2?.startedAt).toBe("2026-10-16T12:06:00.000Z");
      expect(attempt2?.completedAt).toBeUndefined();
      expect(attempt2?.durationMs).toBe(14 * 60 * 1000); // 12:06 to 12:20 = 14 mins
    });

    it("releases the active assignment in reverse order on multi-attempt tasks", () => {
      const tracker = new ObservabilityTracker();
      const runId = "run-assignment-reverse";

      const assignment1: AgentAssignmentMetric = {
        assignmentId: "req-att-1",
        runId,
        taskId: "task-1",
        attemptId: "att-1",
        role: "agent",
        agentId: "agent-1",
        assignedAt: "2026-10-16T12:00:00.000Z",
        status: "assigned"
      };

      const assignment2: AgentAssignmentMetric = {
        assignmentId: "req-att-2",
        runId,
        taskId: "task-1",
        attemptId: "att-2",
        role: "agent",
        agentId: "agent-1",
        assignedAt: "2026-10-16T12:05:00.000Z",
        status: "assigned"
      };

      tracker.recordAgentAssignment(assignment1);
      tracker.recordAgentAssignment(assignment2);

      // Event agent.result_recorded for attempt 2
      const resultEvent: DomainEvent = {
        schemaVersion: 1,
        eventId: "ev-res-1",
        runId,
        taskId: "task-1",
        sequence: 5,
        aggregateVersion: 5,
        occurredAt: "2026-10-16T12:08:00.000Z",
        correlationId: "corr-1",
        idempotencyKey: "idem-res-1",
        type: "agent.result_recorded",
        payload: {
          requestId: "req-att-2",
          attemptId: "att-2",
          runId,
          taskId: "task-1",
          executionId: "exec-2",
          status: "succeeded",
          verification: { status: "verified", verifiedAt: "2026-10-16T12:08:00.000Z" },
          artifactProposals: [],
          retryable: false,
          startedAt: "2026-10-16T12:05:00.000Z",
          completedAt: "2026-10-16T12:08:00.000Z"
        }
      };

      tracker.ingestDomainEvents(runId, [resultEvent]);

      const report = tracker.getRunReport(runId);
      const a1 = report?.agentAssignments.find((a) => a.assignmentId === "req-att-1");
      const a2 = report?.agentAssignments.find((a) => a.assignmentId === "req-att-2");

      expect(a1?.status).toBe("assigned");
      expect(a2?.status).toBe("released");
      expect(a2?.releasedAt).toBe("2026-10-16T12:08:00.000Z");
    });

    it("accepts numeric specVersion in ContextBundleMetric and recordContextBundle", () => {
      const tracker = new ObservabilityTracker();
      const runId = "run-spec-test";

      const bundle: ContextBundleMetric = {
        runId,
        taskId: "task-1",
        role: "developer",
        contextBytes: 2048,
        includedFileCount: 2,
        excludedFileCount: 0,
        specVersion: 2, // number directly accepted
        contextHash: "hash-spec-2",
        recordedAt: "2026-10-16T12:00:00.000Z"
      };

      tracker.recordContextBundle(bundle);
      const report = tracker.getRunReport(runId);
      expect(report?.contextMetrics.bundles[0]?.specVersion).toBe(2);
    });
  });
});
