import { defineConfig } from "vitest/config";

// The scaffolder is plain Node code that writes files, so it is tested in Node rather than in workerd.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], retry: 0 } });
