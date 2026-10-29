import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Separate from root discovery: these tests spawn the built `bflow web` binary.
// Build first (`pnpm run build`); only contracts are resolved from source for schema parsing.
export default defineConfig({
  resolve: {
    alias: {
      "@bflow/contracts/web-host": resolve(__dirname, "../../../packages/contracts/src/web-host.ts"),
      "@bflow/contracts/web": resolve(__dirname, "../../../packages/contracts/src/web.ts"),
      "@bflow/contracts": resolve(__dirname, "../../../packages/contracts/src/index.ts")
    }
  },
  test: {
    root: resolve(__dirname, "../../.."),
    include: ["tests/acceptance/local-web/**/*.acceptance.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: "forks",
    fileParallelism: false
  }
});
