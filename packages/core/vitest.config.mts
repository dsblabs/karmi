import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// One shared wrangler.jsonc for every suite; remote bindings never touched in CI (wayfinder #36).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" }, remoteBindings: false })],
  test: {
    include: ["test/**/*.test.ts"],
    retry: 0,
    setupFiles: ["./test/setup.ts"],
    // A Turn runs a Durable Object, its storage and a fake Provider, so a loaded CI runner needs far more
    // than Vitest's one-second default before a poll may be called a failure.
    testTimeout: 30_000,
    expect: { poll: { interval: 25, timeout: 15_000 } },
  },
});
