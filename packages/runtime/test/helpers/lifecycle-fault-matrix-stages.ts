import { expect } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { type LifecycleFixture } from "./lifecycle-fixture.js";

export const cleanups: (() => Promise<void>)[] = [];
export interface Stage { name: string; run(f: LifecycleFixture): Promise<void> }
export const architectRequest = async (f: LifecycleFixture, objective = "Analyze impact") => {
  const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", objective, ["architecture"]));
  await f.runtime.flushOutbound(); return request;
};
export const stages: Stage[] = [
  { name: "intake", run: async f => { await f.runtime.queueHerdr(f.intakeMessage); await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.intakeMessage); } },
  { name: "specifying", run: async f => {
    const request = await architectRequest(f);
    await f.runtime.receiveHerdr(f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.flushOutbound();
  } },
  { name: "planned", run: async f => { await f.runtime.proposeWorkflow("run-1", f.spec, f.def); } },
  { name: "implemented", run: async f => { await f.runtime.tick(); await f.evidence(); await f.submit(); } },
  { name: "task verified", run: async f => { await f.runtime.tick(); } },
  { name: "workflow verified", run: async f => { await f.runtime.tick(); } },
  { name: "completed", run: async f => { await f.approve(); } }
];
export const index = (name: string) => stages.findIndex(stage => stage.name === name);

export async function through(f: LifecycleFixture, last: string) { for (const stage of stages.slice(0, index(last) + 1)) await stage.run(f); }
/** Continues as the Coordinator would after a fault: an escalated run is resumed through its recorded action, never by guessing. */
export async function drive(f: LifecycleFixture, after: string, maxResumes: number): Promise<number> {
  let resumes = 0;
  for (const stage of stages.slice(index(after) + 1)) {
    const current = await f.run();
    if (current.status === "escalated") {
      expect(current.pendingAction, `before ${stage.name}: escalated without a resumable action (${current.error})`).toBeDefined();
      expect(++resumes, `before ${stage.name}: more explicit resumes than allowed (${current.error})`).toBeLessThanOrEqual(maxResumes);
      await f.runtime.resumeBlockedRun("run-1", current.pendingAction!.actionId);
      await f.runtime.flushOutbound();
    }
    await stage.run(f);
  }
  const final = await f.run();
  expect(final.status, `final error: ${final.error}`).toBe("completed");
  return resumes;
}
export const kinds = async (f: LifecycleFixture, kind: string) => (await f.state()).outbound.filter(out => (out.message.payload as { kind?: string }).kind === kind);
export async function watchdogPass(f: LifecycleFixture, idleMs = 10 * 60_000) {
  const runs = await f.runtime.watchdogSnapshot("session-1");
  const panes = f.panes.bindings.filter(pane => pane.role !== "conversation").map(pane => ({ role: pane.role, paneId: pane.paneId, status: "idle" }));
  for (const action of evaluateWatchdog({ now: Date.now() + idleMs, runs, notices: [], panes }))
    if (action.kind === "stalled") await f.runtime.reportRunStalled(action.runId, action.episodeKey);
}
