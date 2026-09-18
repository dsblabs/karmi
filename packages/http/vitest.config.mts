import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every suite drives the real test Worker in workerd, so REST, SSE and WebSocket routes run where they ship.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false })],
  // Direct test runs bypass Turbo's dependency builds, so the public core entries resolve to workspace source.
  resolve: {
    alias: [
      {
        find: /^@karmi\/core\/testing$/,
        replacement: fileURLToPath(new URL("../core/src/testing/index.ts", import.meta.url).href),
      },
      {
        find: /^@karmi\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url).href),
      },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    retry: 0,
  },
});
