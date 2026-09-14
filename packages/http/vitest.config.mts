import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Every suite drives the real test Worker in workerd, so REST, SSE and WebSocket routes run where they ship.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false })],
  test: {
    include: ["test/**/*.test.ts"],
    retry: 0,
  },
});
