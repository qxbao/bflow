import { describe, expect, it } from "vitest";
import {
  BFLOW_START_SKILL_VERSION,
  DIRECTOR_HELPER_SKILL_MAX_BYTES,
  renderBflowQueueSkill,
  renderBflowStartSkill,
  renderBflowStatusSkill,
  shellQuoteArgv,
} from "../src/director-skill.js";

describe("bflow-start director skill", () => {
  it("starts with the skill frontmatter", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node", "/opt/bflow/bin.js"] });
    expect(text.startsWith("---\nname: bflow-start\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("quotes the absolute command and substitutes every placeholder", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node", "/opt/b flow/bin.js"] });
    expect(text).toContain("'/usr/bin/node' '/opt/b flow/bin.js' director start --json");
    expect(text).not.toContain("{{");
  });

  it("escapes single quotes inside arguments", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/x/it's"] });
    expect(text).toContain("'/x/it'\\''s'");
  });

  it("rejects an empty command or a relative executable", () => {
    const message = "bflowCommand must start with an absolute executable path";
    expect(() => renderBflowStartSkill({ bflowCommand: [] })).toThrow(message);
    expect(() => renderBflowStartSkill({ bflowCommand: ["node"] })).toThrow(message);
  });

  it("embeds the skill version", () => {
    expect(BFLOW_START_SKILL_VERSION).toBe("1.6.0");
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("1.6.0");
    expect(text).toContain("BFLOW_DIRECTOR_TOKEN=<token> '/usr/bin/node' director call <tool> --json");
    expect(text).not.toContain("--token");
  });

  it("tells an idle Codex Director to suspend and end its turn until a queued event wakes it", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("director suspend");
    expect(text).toContain("CODEX_THREAD_ID");
    expect(text).toContain("end your turn");
    expect(text).toContain("BFLOW_DIRECTOR_WAKE");
  });

  it("quotes each argv element with POSIX single quoting joined by spaces", () => {
    expect(shellQuoteArgv(["/usr/bin/node", "/opt/b flow/bin.js"])).toBe(
      "'/usr/bin/node' '/opt/b flow/bin.js'",
    );
    expect(shellQuoteArgv(["/x/it's"])).toBe("'/x/it'\\''s'");
  });

  it("exposes retained-run recovery and calls planning_reference before planning", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("resume_run");
    expect(text).toContain("planning_reference");
    expect(text).not.toContain("cannot create a new run");
    expect(text).toContain("start_work");
    expect(text).toContain("userMessageSeq");
  });

  // Instruction coverage only; Runtime tests separately enforce the admission and resume guards.
  it("bases recovery authority on origin and repository/session, never on token age", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("delegation.requestedBy");
    expect(text).toContain("delegation.sessionId");
    expect(text).toContain('"director"');
    expect(text).toContain("same repository/session");
    expect(text).toContain("token rotation");
    expect(text).toContain("Legacy Conversation-origin runs are read-only");
    expect(text).toContain("Foreign sessions are refused");
    expect(text).not.toContain("Runs created before this Director session are read-only");
    expect(text).not.toContain("cancel it and start new work");
  });

  it("recovers the current pending action within bounds before returning to idle wait", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("pendingAction");
    expect(text).toContain("exact runId and actionId");
    expect(text).toMatch(/blocker is fixed[^\n]*`resume_run`/);
    expect(text).toContain("reconcile_delivery");
    expect(text).toContain("unknown delivery");
    expect(text).toContain("Do not repeat an identical failing call more than twice");
    expect(text).toContain("Active blocked work is not idle");
    expect(text).toContain("next owner/action");
    expect(text).toContain("park_task");
    expect(text).toContain("Never transfer approvals");
    expect(text).toContain("explicit owner resume");
  });

  it("describes the v3 work loop with mailbox audiences and both approval paths", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("read_coordinator_guide");
    expect(text).toContain("read_mailbox");
    expect(text).toContain("audience");
    expect(text).toContain("director_say");
    expect(text).toContain("request_specialist");
    expect(text).toContain("retry_verification");
    expect(text).toContain("! bflow approve '#n'");
    expect(text).toContain("approve button in Bflow Web");
  });

  it("never tells the Director to run bflow approve itself", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).not.toMatch(/Run `[^`]*bflow approve/);
    expect(text).toContain("Do not run that command yourself");
    expect(text).not.toContain("<code>");
  });

  it("keeps file paths out of backticks", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    const spans = [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
    expect(spans.filter(span => /[\\/]|\.(md|ts|js|json|yml|yaml)$/.test(span.replace(/^! /, "")))).toEqual([]);
  });
});

const argv = ["/usr/bin/node", "/opt/b flow/bin.js"] as const;
const renderers = [
  ["bflow-start", renderBflowStartSkill],
  ["bflow-status", renderBflowStatusSkill],
  ["bflow-queue", renderBflowQueueSkill],
] as const;

// Instruction coverage only: these checks show what the generated text says, not that a model obeys it.
describe("generated Director skills", () => {
  it.each(renderers)("%s has frontmatter, a quoted command and no leftover placeholder", (name, render) => {
    const text = render({ bflowCommand: argv });
    expect(text.startsWith(`---\nname: ${name}\n`)).toBe(true);
    expect(text).toContain("description: ");
    expect(text).not.toContain("{{");
    expect(text.endsWith("\n")).toBe(true);
    expect(() => render({ bflowCommand: ["node"] })).toThrow("absolute executable path");
    expect(render({ bflowCommand: argv })).toBe(text);
  });

  it("keeps the helper skills within 4096 bytes and the start skill reasonably small", () => {
    expect(DIRECTOR_HELPER_SKILL_MAX_BYTES).toBe(4096);
    for (const render of [renderBflowStatusSkill, renderBflowQueueSkill]) {
      expect(Buffer.byteLength(render({ bflowCommand: argv }), "utf8")).toBeLessThanOrEqual(4096);
    }
    expect(Buffer.byteLength(renderBflowStartSkill({ bflowCommand: argv }), "utf8")).toBeLessThanOrEqual(8192);
  });

  it("never gives the Director code editing, approval or evidence authority", () => {
    for (const [, render] of renderers) {
      const text = render({ bflowCommand: argv });
      expect(text).not.toMatch(/Run `[^`]*bflow approve/);
      expect(text).not.toMatch(/\bbflow open\b/);
    }
    expect(renderBflowStartSkill({ bflowCommand: argv })).toContain("Do not write evidence or mark a quality gate as passed");
    const queue = renderBflowQueueSkill({ bflowCommand: argv });
    expect(queue).toContain("Never edit code to clear an issue");
    expect(queue).toContain("You cannot approve");
    expect(queue).toContain("Dismissed: records a decision only");
    const status = renderBflowStatusSkill({ bflowCommand: argv });
    expect(status).toContain("Read-only");
    expect(status).toContain("not fully done");
    expect(status).toContain("Do not run that command yourself");
  });

  it("tells the Director to retry through set_issue_status alone, never unpark_task first", () => {
    const queue = renderBflowQueueSkill({ bflowCommand: argv });
    const retry = queue.split("\n").find(line => line.startsWith("   - Retry:"))!;
    expect(retry).toContain("`set_issue_status`");
    expect(retry).toMatch(/do not call unpark_task first/);
    expect(retry).toMatch(/If the Runtime refuses, the issue stays open/);
    expect(queue).not.toMatch(/`unpark_task`[^\n]*then[^\n]*set_issue_status/);
    expect(queue).not.toContain("`unpark_task`");
    expect(retry.indexOf("set_issue_status")).toBeLessThan(retry.indexOf("unpark_task"));
  });

  it("tells the Director to delegate a quick one-line edit, wait when idle and handle errors", () => {
    const text = renderBflowStartSkill({ bflowCommand: argv });
    expect(text).toMatch(/even for a one-line change: tell the user a Developer will make it and call `start_work`/);
    expect(text).toMatch(/Codex only: when no item needs action/);
    expect(text).toMatch(/Bflow Web messages still reach you through `director_wait`/);
    expect(text).toMatch(/A tool error is information/);
    expect(text).toMatch(/no token streaming/);
    expect(text).toMatch(/not fully done/);
    expect(text).toMatch(/Never invent one/);
  });

  it("keeps file paths out of backticks in the helper skills", () => {
    for (const render of [renderBflowStatusSkill, renderBflowQueueSkill]) {
      const spans = [...render({ bflowCommand: argv }).matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
      expect(spans.filter(span => /[\\/]|\.(md|ts|js|json|yml|yaml)$/.test(span.replace(/^! /, "")))).toEqual([]);
    }
  });

  it("keeps the start skill and the Director guide on the same invariants", async () => {
    const { readFile } = await import("node:fs/promises");
    const guide = await readFile(new URL("../../../agents/director/system-prompt.md", import.meta.url), "utf8");
    const skill = renderBflowStartSkill({ bflowCommand: argv });
    for (const shared of ["director_wait", "director_say", "start_work", "reconcile_delivery", "! bflow approve '#n'", "Bflow Web"]) {
      expect(guide, `guide ${shared}`).toContain(shared);
      expect(skill, `skill ${shared}`).toContain(shared);
    }
    expect(Buffer.byteLength(guide, "utf8")).toBeLessThanOrEqual(16384);
  });

  it("uses only Director tool names that the Runtime exposes", { timeout: 60_000 }, async () => {
    const { DIRECTOR_TOOLS } = await import("@bflow/runtime");
    const known = new Set(DIRECTOR_TOOLS.map((tool: { name: string }) => tool.name));
    for (const [, render] of renderers) {
      const names = [...render({ bflowCommand: argv }).matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(match => match[1]!);
      expect(names.filter(name => !known.has(name) && name !== "user_decision_pending")).toEqual([]);
    }
  });
});
