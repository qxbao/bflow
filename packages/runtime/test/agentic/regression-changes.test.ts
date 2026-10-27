import { describe, expect, it } from "vitest";
import {
  classifyChanges,
  parseNameStatus,
  type ChangedFile
} from "../../src/agentic/regression-changes.js";

const packageRootOf = (path: string): string | undefined => {
  const match = /^(packages\/[^/]+)\//.exec(path);
  return match ? match[1] : undefined;
};

describe("regression-changes", () => {
  it("docs only → none", () => {
    expect(classifyChanges([], packageRootOf)).toEqual({
      tier: "none",
      graphFiles: [],
      packageRoots: [],
      changedTests: [],
      widening: []
    });

    const changes: ChangedFile[] = [
      { path: "README.md", status: "M" },
      { path: "docs/a.md", status: "M" },
      { path: "notes.txt", status: "A" },
      { path: "CHANGELOG.rst", status: "M" }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "none",
      graphFiles: [],
      packageRoots: [],
      changedTests: [],
      widening: []
    });
  });

  it("source file → graph", () => {
    const changes: ChangedFile[] = [
      { path: "packages/x/src/a.ts", status: "M" },
      { path: "packages/x/src/a.ts", status: "M" }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "graph",
      graphFiles: ["packages/x/src/a.ts"],
      packageRoots: [],
      changedTests: [],
      widening: []
    });
  });

  it("deleted source uses base path", () => {
    const changes: ChangedFile[] = [
      { path: "packages/x/src/old.ts", status: "D" },
      { path: "packages/x/test/old.test.ts", status: "D" }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "graph",
      graphFiles: ["packages/x/src/old.ts", "packages/x/test/old.test.ts"],
      packageRoots: [],
      changedTests: [],
      widening: []
    });
  });

  it("rename uses previous path for graph and new path for changedTests", () => {
    const changes: ChangedFile[] = [
      {
        path: "packages/x/test/a.test.ts",
        status: "R",
        previousPath: "packages/x/test/b.test.ts"
      }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "graph",
      graphFiles: ["packages/x/test/b.test.ts"],
      packageRoots: [],
      changedTests: ["packages/x/test/a.test.ts"],
      widening: []
    });
  });

  it("fixture → package", () => {
    const changes: ChangedFile[] = [
      { path: "packages/x/test/fixtures/data.json", status: "M" },
      { path: "packages/x/test/fixtures/other.yaml", status: "A" }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "package",
      graphFiles: [],
      packageRoots: ["packages/x"],
      changedTests: [],
      widening: [
        {
          path: "packages/x/test/fixtures/data.json",
          tier: "package",
          reason: "non_code_change",
          packageRoot: "packages/x"
        },
        {
          path: "packages/x/test/fixtures/other.yaml",
          tier: "package",
          reason: "non_code_change",
          packageRoot: "packages/x"
        }
      ]
    });
  });

  it("package manifest → package", () => {
    const changes: ChangedFile[] = [
      { path: "packages/x/package.json", status: "M" }
    ];
    const result = classifyChanges(changes, packageRootOf);
    expect(result).toEqual({
      tier: "package",
      graphFiles: [],
      packageRoots: ["packages/x"],
      changedTests: [],
      widening: [
        {
          path: "packages/x/package.json",
          tier: "package",
          reason: "package_manifest",
          packageRoot: "packages/x"
        }
      ]
    });
  });

  it("root config → full", () => {
    const triggers = [
      "vitest.config.ts",
      "vitest.workspace.mts",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
      "tsconfig.json",
      "tsconfig.base.json",
      "package.json",
      "eslint.config.mjs",
      "babel.config.json",
      ".node-version",
      ".nvmrc",
      "pnpm-workspace.yaml",
      "turbo.json"
    ];
    for (const path of triggers) {
      const result = classifyChanges([{ path, status: "M" }], packageRootOf);
      expect(result.tier).toBe("full");
      expect(result.graphFiles).toEqual([]);
      expect(result.packageRoots).toEqual([]);
      expect(result.widening).toEqual([
        {
          path,
          tier: "full",
          reason: `root_config:${path}`
        }
      ]);
    }
  });

  it("non-code file without sub-package → full", () => {
    const result = classifyChanges(
      [
        { path: "scripts/schema.sql", status: "M" },
        { path: "tools/package.json", status: "M" }
      ],
      () => undefined
    );
    expect(result).toEqual({
      tier: "full",
      graphFiles: [],
      packageRoots: [],
      changedTests: [],
      widening: [
        {
          path: "scripts/schema.sql",
          tier: "full",
          reason: "non_code_change"
        },
        {
          path: "tools/package.json",
          tier: "full",
          reason: "package_manifest"
        }
      ]
    });
  });

  it("parseNameStatus parses -z output including renames", () => {
    expect(parseNameStatus("")).toEqual([]);
    const parsed = parseNameStatus(
      "M\0a.ts\0R100\0old.ts\0new.ts\0A\0added.ts\0D\0deleted.ts\0C085\0src.ts\0copy.ts\0T\0typechange.ts\0"
    );
    expect(parsed).toEqual([
      { path: "a.ts", status: "M" },
      { path: "new.ts", status: "R", previousPath: "old.ts" },
      { path: "added.ts", status: "A" },
      { path: "deleted.ts", status: "D" },
      { path: "copy.ts", status: "C", previousPath: "src.ts" },
      { path: "typechange.ts", status: "T" }
    ]);
  });
});
