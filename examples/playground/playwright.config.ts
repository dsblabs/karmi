import { defineConfig } from "@playwright/test";

// The browser checks drive the real browser files against a Worker with a scripted Provider.
export default defineConfig({
  testDir: "./browser",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8799" },
  webServer: {
    command: "wrangler dev --config test/browser.wrangler.jsonc --port 8799",
    url: "http://127.0.0.1:8799",
    reuseExistingServer: !process.env.CI,
  },
});
