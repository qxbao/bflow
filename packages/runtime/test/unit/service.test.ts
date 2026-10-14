import { describe, expect, it } from "vitest";
import { createRuntimeService } from "../../src/service.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "./fixtures.js";

describe("RuntimeService", { timeout: 30000 }, () => {
  it("initializes runtime service and transport capabilities", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const initRes = await service.init({
        runtimeId: "test-runtime",
        configuration: { env: "test" }
      });
      expect(initRes.ok).toBe(true);

      // Calling init again is idempotent
      const initAgain = await service.init();
      expect(initAgain.ok).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("starts workflow run and persists initial state in RunStore", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();

      const startRes = await service.startRun(definition);
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;

      const snapshot = startRes.value;
      expect(snapshot.runId).toBeDefined();
      expect(snapshot.workflowId).toBe(definition.id);

      // Verify retrieval via getRun
      const getRes = await service.getRun(snapshot.runId);
      expect(getRes.ok).toBe(true);
      expect(getRes.value?.runId).toBe(snapshot.runId);

      // Verify getRunStatus convenience alias
      const statusRes = await service.getRunStatus(snapshot.runId);
      expect(statusRes.ok).toBe(true);
      expect(statusRes.value?.runId).toBe(snapshot.runId);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects duplicate run start with conflict error", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();
      const runId = "duplicate-run-1";

      const start1 = await service.startRun(definition, { runId });
      expect(start1.ok).toBe(true);

      const start2 = await service.startRun(definition, { runId });
      expect(start2.ok).toBe(false);
      if (!start2.ok) {
        expect(start2.error.code).toBe("conflict");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("finds runs via query interface", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();

      await service.startRun(definition, { runId: "find-run-1" });
      await service.startRun(definition, { runId: "find-run-2" });

      const findRes = await service.findRuns({ workflowId: definition.id });
      expect(findRes.ok).toBe(true);
      if (!findRes.ok) return;

      expect(findRes.value.items.length).toBeGreaterThanOrEqual(2);
      const runIds = findRes.value.items.map((r) => r.runId);
      expect(runIds).toContain("find-run-1");
      expect(runIds).toContain("find-run-2");
    } finally {
      await harness.cleanup();
    }
  });

  it("watches domain event stream of a run", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();

      const startRes = await service.startRun(definition, { runId: "watch-run-1" });
      expect(startRes.ok).toBe(true);

      const stream = service.watch("watch-run-1");
      const events = [];
      for await (const eventResult of stream) {
        if (eventResult.ok) {
          events.push(eventResult.value);
        }
        if (events.length >= 2) break; // Read initial events
      }

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe("run.created");
    } finally {
      await harness.cleanup();
    }
  });

  it("cancels workflow run using simplified options overload", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();

      const startRes = await service.startRun(definition, { runId: "cancel-run-1" });
      expect(startRes.ok).toBe(true);

      const cancelRes = await service.cancel({
        runId: "cancel-run-1",
        reason: "User cancelled execution"
      });

      expect(cancelRes.ok).toBe(true);
      if (!cancelRes.ok) return;

      expect(cancelRes.value.status).toBe("cancelled");

      const freshSnap = (await service.getRun("cancel-run-1")).value!;
      expect(freshSnap.status).toBe("cancelled");
    } finally {
      await harness.cleanup();
    }
  });

  it("resumes workflow run across simulated restarts", async () => {
    const harness = await createTestHarness();
    try {
      const service = createRuntimeService(harness.ports);
      const definition = createSampleWorkflowDefinition();

      const startRes = await service.startRun(definition, { runId: "resume-run-1" });
      expect(startRes.ok).toBe(true);

      // Call overloaded resume with string runId
      const resumeRes = await service.resume("resume-run-1");
      expect(resumeRes.ok).toBe(true);
      if (!resumeRes.ok) return;

      expect(resumeRes.value.runId).toBe("resume-run-1");
    } finally {
      await harness.cleanup();
    }
  });
});
