import { describe, expect, it } from "vitest";
import { requirementRevisionGuidance } from "../../src/agentic/requirement-revision-guidance.js";

const prose = (text: string) => requirementRevisionGuidance({ reason: text });

describe("requirementRevisionGuidance prose fallback", () => {
  it("ignores merge conflicts and unrelated 'full' mentions", () => {
    expect(prose("Git merge conflict in src/a.ts; spec is SDD lightweight; full test suite requires full rerun")).toBeUndefined();
    expect(prose("Merge conflict in packages/x. SDD level is lightweight. Full rebuild needed")).toBeUndefined();
  });

  it("detects a real SDD level conflict and suggests full", () => {
    const g = prose("SDD lightweight conflicts with policy: full SDD is required for this feature");
    expect(g?.requiredSddLevel).toBe("full");
    expect(g?.suggestedReply).toContain("full SDD");
  });

  it("detects Vietnamese SDD conflicts", () => {
    const g = prose("Mức SDD lightweight mâu thuẫn với chính sách; phải dùng full SDD");
    expect(g?.requiredSddLevel).toBe("full");
    expect(prose("Mức SDD lightweight mâu thuẫn với chính sách; bắt buộc dùng full SDD")?.requiredSddLevel).toBe("full");
  });

  it("accepts 'SDD must use full' and 'requires full SDD' wording", () => {
    expect(prose("SDD level mismatch: SDD must use full")?.requiredSddLevel).toBe("full");
    expect(prose("Spec conflict with lightweight; policy requires full SDD")?.requiredSddLevel).toBe("full");
  });

  it("does not suggest full when full is not the requirement", () => {
    const g = prose("SDD conflict: policy requires lightweight, not full");
    expect(g).toBeDefined();
    expect(g?.requiredSddLevel).toBeUndefined();
    expect(g?.suggestedReply).toBeUndefined();
  });

  it("respects negations", () => {
    expect(prose("no SDD conflict; lightweight and full both fine")).toBeUndefined();
    expect(prose("xung đột SDD lightweight/full đã được giải quyết")).toBeUndefined();
    expect(prose("Không còn xung đột SDD lightweight/full")).toBeUndefined();
  });
});

describe("requirementRevisionGuidance structured path", () => {
  it("returns guidance for requested_action without a full suggestion", () => {
    const g = requirementRevisionGuidance({ requested_action: "authorized_requirement_revision", reason: "scope changed" }, "run-1");
    expect(g?.requested_action).toBe("authorized_requirement_revision");
    expect(g?.requiredSddLevel).toBeUndefined();
    expect(g?.suggestedReply).toBeUndefined();
  });

  it("suggests full only when requiredSddLevel is full", () => {
    const g = requirementRevisionGuidance({ requested_action: "authorized_requirement_revision", requiredSddLevel: "full" }, "run-1");
    expect(g?.requiredSddLevel).toBe("full");
    expect(g?.suggestedReply).toContain("run run-1");
  });

  it("rejects unrelated payloads", () => {
    expect(requirementRevisionGuidance({ reason: "tests failed" })).toBeUndefined();
    expect(requirementRevisionGuidance("nope")).toBeUndefined();
  });
});
