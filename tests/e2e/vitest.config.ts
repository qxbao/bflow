import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@bflow/contracts": resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@bflow/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@bflow/herdr-adapter": resolve(__dirname, "../../packages/herdr-adapter/src/index.ts"),
      "@bflow/persistence": resolve(__dirname, "../../packages/persistence/src/index.ts"),
      "@bflow/artifact-store": resolve(__dirname, "../../packages/artifact-store/src/index.ts"),
      "@bflow/agent-registry": resolve(__dirname, "../../packages/agent-registry/src/index.ts"),
      "@bflow/pane-manager": resolve(__dirname, "../../packages/pane-manager/src/index.ts"),
      "@bflow/conversation": resolve(__dirname, "../../packages/conversation/src/index.ts"),
      "@bflow/specification": resolve(__dirname, "../../packages/specification/src/index.ts"),
      "@bflow/test-strategy": resolve(__dirname, "../../packages/test-strategy/src/index.ts"),
      "@bflow/verification": resolve(__dirname, "../../packages/verification/src/index.ts"),
      "@bflow/git-orchestrator": resolve(__dirname, "../../packages/git-orchestrator/src/index.ts"),
      "@bflow/agent-providers": resolve(__dirname, "../../packages/agent-providers/src/index.ts"),
      "@bflow/machine-setup": resolve(__dirname, "../../packages/machine-setup/src/index.ts"),
      "@bflow/tool-installer": resolve(__dirname, "../../packages/tool-installer/src/index.ts"),
      "@bflow/mcp-gateway": resolve(__dirname, "../../packages/mcp-gateway/src/index.ts"),
      "@bflow/mcp-services": resolve(__dirname, "../../packages/mcp-services/src/index.ts"),
      "@bflow/skills": resolve(__dirname, "../../packages/skills/src/index.ts"),
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
