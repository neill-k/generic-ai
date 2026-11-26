import { defineConfig } from "@playwright/test";

/**
 * End-to-end, crash and load tests (roadmap R19). Each spec starts its own Generic Corp server
 * on a scripted model (`e2e/scripted-server.mjs`), so run `npm run build` first. No provider key
 * is needed and nothing is spent.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  outputDir: "e2e-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
