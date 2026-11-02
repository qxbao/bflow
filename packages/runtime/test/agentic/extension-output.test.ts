import { describe, expect, it } from "vitest";
import * as runtime from "../../src/index.js";

const getParser = () => {
  const parser = Reflect.get(runtime, "parseNativeExtensionOutput");
  expect(parser, "native output must use the existing role schemas and bounded ingress").toBeTypeOf("function");
  return (family: string, taskId: string, output: unknown) => parser({ family, taskId }, output);
};

describe("native extension output", () => {
  it("validates analysis questions and QA review output through the family-specific schemas", () => {
    const parse = getParser();
    expect(parse("analysis", "elicitation", { questions: [{ id: "q-1", question: "Which locale?", blocking: true }] }))
      .toEqual({ questions: [{ id: "q-1", question: "Which locale?", blocking: true }] });
    expect(parse("qa", "design-review", { verdict: "approved", designDigest: "a".repeat(64), findings: [] }))
      .toEqual({ verdict: "approved", designDigest: "a".repeat(64), findings: [] });
  });
  it("rejects write/command proposals, internal Runtime tasks and unknown families", () => {
    const parse = getParser();
    expect(() => parse("analysis", "elicitation", { questions: [], writes: [{ path: "src/x.ts", content: "change" }] })).toThrow();
    expect(() => parse("qa", "design-review", { verdict: "approved", designDigest: "a".repeat(64), findings: [], commands: ["curl elsewhere"] })).toThrow();
    expect(() => parse("analysis", "publication", {})).toThrow();
    expect(() => parse("qa", "execution", {})).toThrow();
    expect(() => parse("unknown", "elicitation", { questions: [] })).toThrow();
  });
  it("bounds encoded output instead of accepting an unbounded list of individually valid questions", () => {
    const parse = getParser();
    const questions = Array.from({ length: 600 }, (_, i) => ({ id: `q-${i}`, question: "?".repeat(2000), blocking: false }));
    expect(() => parse("analysis", "elicitation", { questions })).toThrow(/size|large|bound/i);
  });
});
