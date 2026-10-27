import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Developer inner loop (`pnpm test:fast`): the root suite without the slow real Runtime/Git/storage integration files.
 * It is not a substitute for `pnpm test`, which remains required before handoff and is what CI runs.
 */
export const slowIntegrationFiles = [
  "packages/runtime/test/agentic/integration-*.test.ts",
  "packages/runtime/test/agentic/lifecycle-fault-matrix-*.test.ts",
  "packages/runtime/test/agentic/rework-causality-*.test.ts",
  "packages/runtime/test/agentic/behavioral-runner-*.test.ts"
];

export default mergeConfig(base, defineConfig({ test: { exclude: [...configDefaults.exclude, ...slowIntegrationFiles] } }));
