// Demo-only AgentTransport that hands prompts to a human operator through files.
//
// It is NOT Herdr and does not run any AI agent. `send` durably writes the validated
// AgentRequest to `<outboxDir>/<requestId>.json`; that file write *is* the delivery.
//
// Correlation: the outbox file named by requestId is the only delivery channel, and in this
// demo the single operator (run-demo.mjs) answers exactly that request. That setup — not any
// observation of an AI agent — is why the handle is marked `provenance: "transport",
// verified: true`. Core only accepts a task result when the bound handle is verified.
// The Herdr adapter returns `provenance: "orchestrator", verified: false` (Herdr 0.9.1 cannot
// correlate a prompt), so Herdr-dispatched tasks cannot have results recorded today.
// See docs/guide/09-blocked-timeout-retry-resume.md ("Giới hạn đã biết").
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentExecutionHandleSchema,
  AgentReconciliationRequestSchema,
  AgentRequestSchema,
  AgentTransportInitializationSchema,
  CancellationRequestSchema
} from "../../packages/contracts/dist/index.js";

const validation = (message) => ({ ok: false, error: { code: "validation", retryable: false, message } });

export class OutboxTransport {
  #outboxDir;

  constructor({ outboxDir }) {
    this.#outboxDir = outboxDir;
  }

  async initialize(initialization) {
    const parsed = AgentTransportInitializationSchema.safeParse(initialization);
    if (!parsed.success) return validation(parsed.error.message);
    await mkdir(this.#outboxDir, { recursive: true });
    return {
      ok: true,
      value: {
        transportName: "demo-outbox",
        protocolVersion: "1",
        supportsStreaming: false,
        supportsCancellation: true,
        supportsResume: false,
        supportsSubmissionCorrelation: false
      }
    };
  }

  async send(request) {
    const parsed = AgentRequestSchema.safeParse(request);
    if (!parsed.success) return validation(parsed.error.message);
    const req = parsed.data;
    const now = new Date().toISOString();
    const handle = {
      executionId: `exec-${randomUUID()}`,
      requestId: req.requestId,
      attemptId: req.attemptId,
      runId: req.runId,
      taskId: req.taskId,
      idempotencyKey: req.idempotency.key,
      target: req.target,
      correlation: { token: req.requestId, provenance: "transport", verified: true },
      acceptedAt: now
    };
    // Write-then-rename so a reader never sees a partial request file.
    const file = join(this.#outboxDir, `${req.requestId}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = await open(temporary, "wx", 0o600);
    try {
      await fd.writeFile(JSON.stringify({ request: req, handle }, null, 2));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, file);
    return {
      ok: true,
      value: {
        status: "accepted",
        requestId: req.requestId,
        attemptId: req.attemptId,
        runId: req.runId,
        taskId: req.taskId,
        observedAt: now,
        handle
      }
    };
  }

  async reconcile(request) {
    const parsed = AgentReconciliationRequestSchema.safeParse(request);
    if (!parsed.success) return validation(parsed.error.message);
    const observedAt = new Date().toISOString();
    try {
      const stored = JSON.parse(await readFile(join(this.#outboxDir, `${parsed.data.requestId}.json`), "utf8"));
      const handle = AgentExecutionHandleSchema.parse(stored.handle);
      return { ok: true, value: { status: "bound", handle } };
    } catch (error) {
      if (error?.code === "ENOENT") {
        // The outbox file is the delivery itself; its absence proves the prompt was not delivered.
        return { ok: true, value: { status: "not_delivered", requestId: parsed.data.requestId, retrySafe: true, observedAt } };
      }
      return {
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: parsed.data.requestId,
          retrySafe: false,
          observedAt,
          reason: "Outbox entry is unreadable; inspect it manually",
          manualInterventionRequired: true
        }
      };
    }
  }

  async wait(handle) {
    const parsed = AgentExecutionHandleSchema.safeParse(handle);
    if (!parsed.success) return validation(parsed.error.message);
    // The operator's work is invisible to this transport.
    return { ok: true, value: { handle: parsed.data, state: "unknown", observedAt: new Date().toISOString(), correlationVerified: false } };
  }

  async *read() {}

  async cancel(handle, request) {
    const parsedHandle = AgentExecutionHandleSchema.safeParse(handle);
    if (!parsedHandle.success) return validation(parsedHandle.error.message);
    const parsed = CancellationRequestSchema.safeParse(request);
    if (!parsed.success) return validation(parsed.error.message);
    const observedAt = new Date().toISOString();
    await writeFile(
      join(this.#outboxDir, `${parsedHandle.data.requestId}.cancel.json`),
      JSON.stringify({ request: parsed.data, observedAt }, null, 2)
    );
    // Accepted means only that the request was written; it never confirms the work stopped.
    return {
      ok: true,
      value: { schemaVersion: 1, cancellationId: parsed.data.cancellationId, status: "accepted", executionId: parsedHandle.data.executionId, observedAt }
    };
  }
}
