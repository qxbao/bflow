import { describe, expect, it } from "vitest";
import {
  BFLOW_START_SKILL_VERSION,
  renderBflowStartSkill,
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
    expect(BFLOW_START_SKILL_VERSION).toBe("1.3.0");
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).toContain("1.3.0");
    expect(text).toContain("BFLOW_DIRECTOR_TOKEN=<token> '/usr/bin/node' director call <tool> --json");
    expect(text).not.toContain("--token");
  });

  it("quotes each argv element with POSIX single quoting joined by spaces", () => {
    expect(shellQuoteArgv(["/usr/bin/node", "/opt/b flow/bin.js"])).toBe(
      "'/usr/bin/node' '/opt/b flow/bin.js'",
    );
    expect(shellQuoteArgv(["/x/it's"])).toBe("'/x/it'\\''s'");
  });

  it("drops resume_run and calls planning_reference before planning", () => {
    const text = renderBflowStartSkill({ bflowCommand: ["/usr/bin/node"] });
    expect(text).not.toContain("resume_run");
    expect(text).toContain("planning_reference");
    expect(text).not.toContain("cannot create a new run");
    expect(text).toContain("start_work");
    expect(text).toContain("userMessageSeq");
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
