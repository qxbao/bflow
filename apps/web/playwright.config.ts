import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", workers: 1, outputDir: "dist/test-results", reporter: "list",
  use: { baseURL: "http://127.0.0.1:4318",
    launchOptions: process.env.BFLOW_WEB_TEST_BROWSER ? { executablePath: process.env.BFLOW_WEB_TEST_BROWSER } : {} },
  webServer: { command: "pnpm exec vite preview --host 127.0.0.1 --port 4318 --strictPort", url: "http://127.0.0.1:4318", reuseExistingServer: false }
});
