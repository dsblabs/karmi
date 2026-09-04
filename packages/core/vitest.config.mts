import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One shared wrangler.jsonc for every suite; remote bindings never touched in CI (wayfinder #36).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false })],
  test: {
    include: ["test/**/*.test.ts"],
    retry: 0,
  },
});
