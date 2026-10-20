import { describe, expect, it } from "vitest";
import { permitsReadOnlyGit, permitsReadOnlyInvestigation } from "../../src/agentic/read-only-git.js";

describe("read-only git investigation allowlist", () => {
  it.each([
    "git log --oneline -20",
    "git log --format=\"%h %s\" -5 -- packages/runtime",
    "git show HEAD --stat",
    "git diff main...HEAD -- packages/test-strategy",
    "git status --short",
    "git branch",
    "git branch --list",
    "git branch -a -v"
  ])("allows %s", command => {
    expect(permitsReadOnlyGit(command)).toBe(true);
  });

  it.each([
    "git commit -m wip",
    "git push origin main",
    "git reset --hard",
    "git checkout main",
    "git branch new-feature",
    "git branch -D old",
    "git branch --contains HEAD",
    "git stash",
    "git",
    "git log;rm -rf ./packages",
    "git log && curl https://example.test",
    "git log | sh",
    "git log $(id)",
    "git log `id`",
    "git log > /tmp/out.txt",
    "git log\nrm -rf .",
    "git -c core.pager=sh log",
    "git -C .. log",
    "GIT_EXTERNAL_DIFF=sh git diff",
    "git diff --ext-diff",
    "git log --output=/tmp/out.txt",
    "git log '--output=/tmp/out.txt'",
    "git log --out\"\"put=/tmp/out.txt",
    "git \"commit\" -m wip",
    "git branch '-D' old",
    "git show --textconv HEAD",
    "git diff --git-dir=/tmp/other",
    "npm test",
    "echo git log"
  ])("refuses %j", command => {
    expect(permitsReadOnlyGit(command)).toBe(false);
  });

  it("permits Bash git reads only for read-only investigation roles", () => {
    expect(permitsReadOnlyInvestigation("architect", "Bash", "git log --oneline")).toBe(true);
    expect(permitsReadOnlyInvestigation("reviewer", "Bash", "git show HEAD")).toBe(true);
    expect(permitsReadOnlyInvestigation("developer", "Bash", "git log --oneline")).toBe(false);
    expect(permitsReadOnlyInvestigation("coordinator", "Bash", "git log --oneline")).toBe(false);
    expect(permitsReadOnlyInvestigation("architect", "Bash", "git push")).toBe(false);
  });

  it("does not rely on shell access for Coordinator or Architect repository investigation", async () => {
    const { availableTools } = await import("../../src/agentic/host.js");
    for (const role of ["coordinator", "architect"] as const) {
      expect(availableTools(role).map(tool => tool.name)).toContain("repository_read");
    }
  });

  it("never permits a non-Bash tool through the git allowlist", () => {
    expect(permitsReadOnlyInvestigation("architect", "Edit", "git log")).toBe(false);
    expect(permitsReadOnlyInvestigation("architect", "Write", "git log")).toBe(false);
  });
});
