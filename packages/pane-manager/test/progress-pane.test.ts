import { describe, expect, it } from "vitest";
import { ProgressPaneSchema, type ProgressPane } from "@bflow/contracts";
import {
  ensureProgressPane,
  launchProgressPane,
  progressRestartAllowed,
  progressShellCommand,
  type ProgressPaneDeps
} from "../src/progress-pane.js";
import { DirectorHerdrFake } from "./support/director-herdr-fake.js";

const ROOT = "/repo/sample project";
const COMMAND = ["/usr/local/bin/node", "/opt/bflow it's/bin.js", "progress", "--follow"] as const;

function harness(start = Date.parse("2026-11-03T10:00:00.000Z")) {
  const fake = new DirectorHerdrFake();
  let now = start;
  const persisted: ProgressPane[] = [];
  const order: string[] = [];
  const deps: ProgressPaneDeps = {
    async herdr(args) {
      order.push(`herdr:${args.slice(0, 2).join(" ")}`);
      const outcome = await fake.run({ args });
      if (outcome.exitCode === 0) return outcome.stdout;
      const code = (JSON.parse(outcome.stderr) as { error: { code: string } }).error.code;
      throw Object.assign(new Error(code), { code });
    },
    clock: () => new Date(now),
    workspaceRoot: ROOT,
    workspaceId: "",
    async persist(pane) {
      order.push(`persist:${pane.phase}`);
      persisted.push(ProgressPaneSchema.parse(pane));
    }
  };
  const created = fake.run({ args: ["workspace", "create", "--cwd", ROOT, "--label", "sample", "--no-focus"] });
  return {
    fake, deps, persisted, order,
    advance(ms: number) { now += ms; },
    async root() {
      const outcome = await created;
      const result = (JSON.parse(outcome.stdout) as { result: { workspace: { workspace_id: string }; root_pane: { pane_id: string; tab_id: string; terminal_id: string } } }).result;
      deps.workspaceId = result.workspace.workspace_id;
      return { workspaceId: result.workspace.workspace_id, tabId: result.root_pane.tab_id, paneId: result.root_pane.pane_id, terminalId: result.root_pane.terminal_id };
    }
  };
}

describe("progressRestartAllowed", () => {
  const now = new Date("2026-11-03T10:10:00.000Z");
  it("allows at most five restarts within ten minutes", () => {
    const recent = (count: number) => Array.from({ length: count }, (_, index) => new Date(now.getTime() - (index + 1) * 60_000).toISOString());
    expect(progressRestartAllowed(recent(4), now)).toBe(true);
    expect(progressRestartAllowed(recent(5), now)).toBe(false);
  });
  it("ignores restarts older than ten minutes", () => {
    const old = Array.from({ length: 5 }, (_, index) => new Date(now.getTime() - 10 * 60_000 - index * 1000).toISOString());
    expect(progressRestartAllowed(old, now)).toBe(true);
  });
});

describe("launchProgressPane", () => {
  it("persists the launch intent before pane run and runs the single-quoted command", async () => {
    const h = harness();
    const root = await h.root();
    const progress = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    expect(progress.phase).toBe("running");
    expect(progress.launchedAt).toBe("2026-11-03T10:00:00.000Z");
    const run = h.fake.calls.find(args => args[0] === "pane" && args[1] === "run")!;
    expect(run).toEqual(["pane", "run", root.paneId, "'/usr/local/bin/node' '/opt/bflow it'\\''s/bin.js' 'progress' '--follow'"]);
    expect(progressShellCommand(COMMAND)).toBe(run[3]);
    expect(h.order.indexOf("persist:launch_intent")).toBeLessThan(h.order.indexOf("herdr:pane run"));
    expect(h.persisted.map(item => item.phase)).toEqual(["launch_intent", "running"]);
  });

  it("records launch_unknown when pane run fails and never replays it", async () => {
    const h = harness();
    const root = await h.root();
    h.fake.paneRunOutcome = { exitCode: null, stdout: "", stderr: "", failure: "timeout" };
    const uncertain = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    expect(uncertain.phase).toBe("launch_unknown");
    h.fake.paneRunOutcome = undefined;
    const reconciled = await ensureProgressPane(h.deps, uncertain);
    expect(reconciled.phase).toBe("failed");
    expect(h.fake.count("pane", "run")).toBe(1);
    // A failed pane stays failed: it is never relaunched by a later ensure either.
    expect((await ensureProgressPane(h.deps, reconciled)).phase).toBe("failed");
    expect(h.fake.count("pane", "run")).toBe(1);
  });

  it("treats a non-empty pane run acknowledgement as uncertain", async () => {
    const h = harness();
    const root = await h.root();
    h.fake.paneRunOutcome = { exitCode: 0, stdout: "unexpected", stderr: "" };
    expect((await launchProgressPane(h.deps, { ...root, command: COMMAND })).phase).toBe("launch_unknown");
  });

  it("records launch_unknown when the launched process is never observed", async () => {
    const h = harness();
    const root = await h.root();
    h.fake.launchStarts = false;
    expect((await launchProgressPane(h.deps, { ...root, command: COMMAND })).phase).toBe("launch_unknown");
    expect(h.fake.count("pane", "run")).toBe(1);
  });
});

describe("ensureProgressPane", () => {
  it("keeps a running viewer untouched", async () => {
    const h = harness();
    const root = await h.root();
    const running = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    expect(await ensureProgressPane(h.deps, running)).toEqual(running);
    expect(h.fake.count("pane", "run")).toBe(1);
  });

  it("restarts an exited viewer five times within ten minutes, then fails", async () => {
    const h = harness();
    const root = await h.root();
    let progress = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    for (let restart = 1; restart <= 5; restart++) {
      h.fake.exitForeground(root.paneId);
      h.advance(60_000);
      progress = await ensureProgressPane(h.deps, progress);
      expect(progress.phase).toBe("running");
      expect(progress.restarts).toHaveLength(restart);
    }
    h.fake.exitForeground(root.paneId);
    h.advance(60_000);
    progress = await ensureProgressPane(h.deps, progress);
    expect(progress.phase).toBe("failed");
    expect(h.fake.count("pane", "run")).toBe(6);
  });

  it("promotes launch_unknown to running when the exact command is observed", async () => {
    const h = harness();
    const root = await h.root();
    h.fake.launchStarts = false;
    const uncertain = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    h.fake.occupy(root.paneId, [...COMMAND]);
    const confirmed = await ensureProgressPane(h.deps, uncertain);
    expect(confirmed.phase).toBe("running");
    expect(h.fake.count("pane", "run")).toBe(1);
  });

  it("recreates a missing progress pane in a new progress tab", async () => {
    const h = harness();
    const root = await h.root();
    const running = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    h.fake.removePane(root.paneId);
    const recreated = await ensureProgressPane(h.deps, running);
    expect(recreated.phase).toBe("running");
    expect(recreated.paneId).not.toBe(root.paneId);
    expect(recreated.restarts).toHaveLength(1);
    expect(h.fake.calls.filter(args => args[0] === "tab" && args[1] === "create")).toEqual([
      ["tab", "create", "--workspace", root.workspaceId, "--cwd", ROOT, "--label", "progress", "--no-focus"]
    ]);
    expect(h.fake.calls).toContainEqual(["pane", "rename", recreated.paneId, "progress"]);
  });

  it("recreates the pane when its terminal was replaced, without touching the replacement", async () => {
    const h = harness();
    const root = await h.root();
    const running = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    h.fake.replaceTerminal(root.paneId);
    const recreated = await ensureProgressPane(h.deps, running);
    expect(recreated.paneId).not.toBe(root.paneId);
    expect(h.fake.calls.filter(args => args[2] === root.paneId && (args[1] === "run" || args[1] === "close"))).toHaveLength(1);
  });

  it("marks a foreign occupant failed and never runs or closes in its pane", async () => {
    const h = harness();
    const root = await h.root();
    const running = await launchProgressPane(h.deps, { ...root, command: COMMAND });
    h.fake.occupy(root.paneId, ["vim", "notes.txt"]);
    const failed = await ensureProgressPane(h.deps, running);
    expect(failed.phase).toBe("failed");
    expect(h.fake.count("pane", "run")).toBe(1);
    expect(h.fake.count("pane", "close")).toBe(0);
  });
});
