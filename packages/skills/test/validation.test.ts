import { describe, expect, it } from "vitest";
import { validateSkill, type BundleFiles } from "../src/index.js";

import { files, body } from "./fixtures.js";
const validate = (f: BundleFiles) =>
  validateSkill(f, {
    source: "builtin",
    supportedCommands: ["status", "doctor", "help"],
  });

describe("skill ingress validation", () => {
  it("validates standard metadata and full content digest", () => {
    const a = validate(files());
    expect(a.skillId).toBe("example");
    expect(a.instructionOnly).toBe(true);
    expect(validate({ ...files(), "example.md": "evidence" }).digest).not.toBe(
      a.digest,
    );
  });
  it("rejects missing metadata/sections and provider hook fields", () => {
    expect(() =>
      validate({
        ...files(),
        "SKILL.md": body().replace("name: example\n", ""),
      }),
    ).toThrow();
    expect(() =>
      validate({
        ...files(),
        "SKILL.md": body().replace("## Required inputs", "## Other"),
      }),
    ).toThrow();
    expect(() =>
      validate({
        ...files(),
        "SKILL.md": body().replace("---\n\n", "hooks: malicious\n---\n\n"),
      }),
    ).toThrow();
  });
  it("rejects missing, escaping, remote, reference-style and HTML resources", () => {
    for (const ref of [
      "[missing](missing.md)",
      "[escape](../outside)",
      "[remote](https://example.com/a)",
      "![img][x]\n[x]: missing.png",
      '<img src="missing.png">',
      "<https://example.com/unfetched.md>",
      "[example](<missing file.md>)",
    ]) {
      expect(() =>
        validate({ ...files(), "SKILL.md": body() + "\n" + ref }),
      ).toThrow();
    }
    expect(
      validate({
        ...files(),
        "SKILL.md": body() + "\n[example](./example.md)",
        "example.md": "Local example.",
      }).skillId,
    ).toBe("example");
    expect(
      validate({
        ...files(),
        "SKILL.md":
          body() + "\n[viewpoints](references/risk-viewpoints.md)",
        "references/risk-viewpoints.md":
          "See [sibling](sibling.md).\n",
        "references/sibling.md": "Nested reference content.\n",
      }).skillId,
    ).toBe("example");
    expect(() =>
      validate({
        ...files(),
        "SKILL.md":
          body() + "\n[viewpoints](references/risk-viewpoints.md)",
        "references/risk-viewpoints.md":
          "Broken [escape](../SKILL.md) from nested reference.\n",
      }),
    ).toThrow(/Unsafe or unfetched resource reference/);
    expect(() =>
      validate({
        ...files(),
        "SKILL.md":
          body() + "\n[viewpoints](references/risk-viewpoints.md)",
        "references/risk-viewpoints.md":
          "Missing [missing](absent.md) inside nested reference.\n",
      }),
    ).toThrow(/Missing skill reference/);
  });
  it("checks all resource commands against supported command IDs", () => {
    for (const cmd of [
      "`bflow invented`",
      "bflow status && bflow bypass",
      "`bflow skills install`",
      "`bflow --json invented`",
      "`bflow -j invented`",
    ]) {
      expect(() => validate({ ...files(), "example.md": cmd })).toThrow(
        /command/,
      );
    }
  });
});

it("checks nested command families even when their parent is supported", () => {
  expect(() =>
    validateSkill(
      { ...files(), "extra.md": "`bflow skills delete`" },
      {
        source: "builtin",
        supportedCommands: ["status", "skills", "skills list"],
      },
    ),
  ).toThrow(/command/);
});
