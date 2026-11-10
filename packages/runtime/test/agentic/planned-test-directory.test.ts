import { expect, it } from "vitest";
import { plannedTestDirectory, plannedTestDirectoryOnly } from "../../src/agentic/host-verification.js";

it("recognizes a planned test directory without treating a source directory as one", () => {
  expect(plannedTestDirectory("packages/x/test")).toBe(true);
  expect(plannedTestDirectory("packages/x/src/tests")).toBe(true);
  expect(plannedTestDirectory("packages/x/src")).toBe(false);
  expect(plannedTestDirectory("packages/x/test/a.test.ts")).toBe(false);
});

it("is directory-only just when no literal test file is planned", () => {
  expect(plannedTestDirectoryOnly(["packages/x/src/a.ts", "packages/x/test"])).toBe(true);
  expect(plannedTestDirectoryOnly(["packages/x/test", "packages/x/test/a.test.ts"])).toBe(false);
  expect(plannedTestDirectoryOnly(["packages/x/src/a.ts"])).toBe(false);
  expect(plannedTestDirectoryOnly([])).toBe(false);
});
