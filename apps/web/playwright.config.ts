import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',workers:1,outputDir:'dist/test-results',reporter:'list',
  use:{launchOptions:process.env.BFLOW_WEB_TEST_BROWSER?{executablePath:process.env.BFLOW_WEB_TEST_BROWSER}:{}}
});
