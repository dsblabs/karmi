import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Every test drives the real Worker in workerd, against the test Worker's own wrangler config.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false })],
  test: { include: ["test/**/*.test.ts"], retry: 0, setupFiles: ["./test/setup.ts"] },
});
