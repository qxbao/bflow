import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-flow/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@ai-flow/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@ai-flow/persistence": resolve(__dirname, "../../packages/persistence/src/index.ts"),
      "@ai-flow/artifact-store": resolve(__dirname, "../../packages/artifact-store/src/index.ts"),
      "@ai-flow/agent-registry": resolve(__dirname, "../../packages/agent-registry/src/index.ts"),
      "@ai-flow/quality-gates": resolve(__dirname, "../../packages/quality-gates/src/index.ts"),
      "@ai-flow/runtime": resolve(__dirname, "../../packages/runtime/src/index.ts"),
      "@ai-flow/cli": resolve(__dirname, "../../apps/cli/src/index.ts")
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
