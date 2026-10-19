import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Source and tests load sibling packages with `import(new URL(..., import.meta.url).href)`.
 * That yields a percent-encoded file URL, and Vite's resolver does not decode it, so a
 * checkout path containing a space (for example "AI Learning") fails to load.
 */
const decodeEncodedFilePaths = {
  name: "bflow-decode-encoded-file-paths",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (!id.startsWith("/") || !id.includes("%")) return null;
    // A real path may contain a literal "%"; only rewrite when the decoded path exists and the raw one does not.
    if (existsSync(id)) return null;
    try {
      const decoded = decodeURIComponent(id);
      return existsSync(decoded) ? decoded : null;
    } catch { return null; }
  }
};

export default defineConfig({
  plugins: [decodeEncodedFilePaths],
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
