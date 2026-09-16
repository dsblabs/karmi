import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

if (process.env.CI || process.env.KARMI_VECTORIZE_LIVE !== "1")
  throw new Error("Live Vectorize tests require KARMI_VECTORIZE_LIVE=1 and must not run in CI.");

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.vectorize.jsonc" }, remoteBindings: true })],
  test: { include: ["test/vectorize.live.ts"], retry: 0, testTimeout: 120000 },
});
