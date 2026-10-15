import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@bflow/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@bflow/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@bflow/persistence": resolve(__dirname, "../../packages/persistence/src/index.ts"),
      "@bflow/artifact-store": resolve(__dirname, "../../packages/artifact-store/src/index.ts"),
      "@bflow/agent-registry": resolve(__dirname, "../../packages/agent-registry/src/index.ts"),
      "@bflow/quality-gates": resolve(__dirname, "../../packages/quality-gates/src/index.ts"),
      "@bflow/runtime": resolve(__dirname, "../../packages/runtime/src/index.ts"),
      "@bflow/cli": resolve(__dirname, "../../apps/cli/src/index.ts")
    }
  },
  test: {
    testTimeout: 60000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    include: ["tests/e2e/**/*.test.ts"],
    pool: "forks"
  }
});
