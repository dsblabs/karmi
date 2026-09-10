import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The adapter runs where karmi runs: every suite executes in workerd. The live test reads its key from
// the Node side so no secret ever lands in a wrangler file.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false, miniflare: { bindings: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" } } })],
  test: {
    include: ["test/**/*.test.ts"],
    retry: 0,
  },
});
