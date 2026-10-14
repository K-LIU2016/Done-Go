import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: "**/tango/**",
  outputDir: "./test-results",
  timeout: 15000,
  use: {
    baseURL: "http://127.0.0.1:5199",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1200 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: true,
    timeout: 60000,
  },
});
