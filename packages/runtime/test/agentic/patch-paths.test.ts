import { describe, expect, it } from "vitest";
import { patchFilePaths } from "../../src/agentic/patch-paths.js";

describe("native patch authorization targets", () => {
  it("includes every added, edited, deleted and moved path while ignoring diff content", () => {
    const patch = "*** Begin Patch\n*** Add File: test/new.test.ts\n+content\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-old\n+new\n+*** Update File: literal text in the file\n*** Delete File: src/removed.ts\n*** End Patch";
    expect(patchFilePaths(patch)).toEqual(["test/new.test.ts", "src/old.ts", "src/new.ts", "src/removed.ts"]);
    expect(patchFilePaths({ input: patch })).toEqual(patchFilePaths(patch));
    expect(patchFilePaths({ patch })).toEqual(patchFilePaths(patch));
    expect(patchFilePaths({ command: patch })).toEqual(patchFilePaths(patch));
  });
  it.each([
    "echo unsafe", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Update File: a\n*** End Patch",
    "*** Begin Patch\n*** Update File: a\n@@\n+x\n*** Move to: outside\n*** End Patch",
    "*** Begin Patch\n*** Add File: a\n+ok\n*** Unsupported File: b\n+no\n*** End Patch",
    "*** Begin Patch\n*** Add File: a\n+ok\n*** End Patch\n*** Add File: b\n+bad",
    "*** Begin Patch\n*** Add File: a\u0000b\n+ok\n*** End Patch"
  ])("refuses malformed or ambiguous patch framing: %s", patch => {
    expect(() => patchFilePaths(patch)).toThrow();
  });
  it("refuses conflicting input fields and bounds patch size", () => {
    expect(() => patchFilePaths({ input: "x", patch: "y" })).toThrow();
    expect(() => patchFilePaths("x".repeat(1024 * 1024 + 1))).toThrow();
  });
});
