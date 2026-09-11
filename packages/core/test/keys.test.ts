import { describe, expect, it } from "vitest";
import { KarmiError } from "../src/index.js";
import { keys } from "../src/keys.js";

// A bug here is a cross-Scope bug (ADR-0001), so the keys module gets tests of its own.
describe("keys", () => {
  it("mints every Durable Object name under {scope}/", () => {
    expect(keys.config("acme")).toBe("acme/config");
    expect(keys.thread("acme", "t-42")).toBe("acme/thread/t-42");
  });

  it("mints every R2 key under {scope}/", () => {
    expect(keys.r2Prefix("acme")).toBe("acme/");
    expect(keys.media("acme", "t-42", "01ARZ")).toBe("acme/media/t-42/01ARZ");
  });

  it("keeps one Scope's prefix from matching another's", () => {
    expect(keys.config("ab").startsWith(keys.r2Prefix("a"))).toBe(false);
    expect(keys.thread("a", "x").startsWith(keys.r2Prefix("a"))).toBe(true);
  });

  it("refuses an id that could escape its prefix", () => {
    expect(() => keys.config("../other")).toThrowError(
      new KarmiError("scope.id.invalid", 'ScopeId "../other" must match [A-Za-z0-9_-]{1,64}.'),
    );
    expect(() => keys.thread("a", "b/c")).toThrowError(
      new KarmiError("thread.id.invalid", 'threadId "b/c" must match [A-Za-z0-9_-]{1,64}.'),
    );
  });
});
