import { describe, expect, it } from "vitest";

// The package reaches karmi through its public entry only. This test reads every source module and checks
// each import specifier, so a reach into core's internals fails here as well as in the linter.
const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
const ALLOWED = new Set(["@karmi/core", "zod/mini"]);
const SPECIFIER = /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)|\bimport\s+"([^"]+)"/g;

describe("import boundary", () => {
  it("imports only @karmi/core, zod/mini and its own modules", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(3);
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? "";
        const own = specifier.startsWith("./") && !specifier.includes("..");
        expect(own || ALLOWED.has(specifier), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
