import { afterEach, expect, it, vi } from "vitest";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { cleanups, fixture, unwrap } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

it("persists native cancellation before transport I/O and releases Runtime's journal while waiting", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.ports.workflowExtensionStarted = async () => true;
  f.ports.inspectWorkflowExtension = async () => ({ extensionStatus: "running" });
  f.ports.cancelWorkflowExtension = async () => { entered(); await waiting; return { cancelled: true, extensionStatus: "cancelled" }; };
  const operation = f.runtime.cancel("run-1", "Owner stopped analysis");
  try {
    await arrived;
    const read = f.runtime.inspect("run-1");
    const observed = await Promise.race([read, new Promise(resolve => setTimeout(() => resolve("locked"), 750))]);
    expect(observed).toMatchObject({ cancelled: true, status: "cancelled" });
  } finally { release(); await operation; }
});

it("keeps Coordinator user decisions available for an escalated v2 run without a pending action", async () => {
  const f = await fixture();
  await new AgenticJournal(f.runtimeOptions.journalDirectory, f.repository).exclusive(async (state, save) => {
    state.runs[0]!.status = "escalated"; delete state.runs[0]!.pendingAction; await save();
  });
  const pane = unwrap(await f.panes.getRoleBinding("coordinator"))!;
  expect(await f.runtime.requestUserDecision(pane, "coordinator", { runId: "run-1", taskId: "planning",
    question: "Who owns health?", options: ["Ops", "Product"] })).toMatchObject({ approvalId: expect.any(String) });
});

it("recovers the committed native cancellation intent after a crash before the extension callback", async () => {
  const f = await fixture();
  f.ports.workflowExtensionStarted = async () => true;
  f.ports.inspectWorkflowExtension = async () => ({ extensionStatus: "running" });
  f.ports.cancelWorkflowExtension = async () => { throw new Error("crash before native cancellation"); };
  await expect(f.runtime.cancel("run-1", "Owner stopped native work")).rejects.toThrow("crash before native cancellation");
  expect(await f.runtime.inspect("run-1")).toMatchObject({ cancelled: true });
  const recovered = new AgenticWorkflowRuntime(f.ports, f.runtimeOptions);
  const cancel = vi.fn(async () => ({ cancelled: true, extensionStatus: "cancelled" }));
  f.ports.cancelWorkflowExtension = cancel;
  await recovered.reconcileWorkflowExtensionCancellations();
  expect(cancel).toHaveBeenCalledWith("run-1", "Owner stopped native work");
  expect(cancel).toHaveBeenCalledTimes(1);
});
