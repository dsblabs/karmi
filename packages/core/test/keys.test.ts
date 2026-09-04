import { describe, expect, it } from "vitest";
import { KarmiError } from "../src/index.js";
import { keys } from "../src/keys.js";

// A bug here is a cross-tenant bug (ADR-0001), so the keys module gets tests of its own.
describe("keys", () => {
  it("mints every Durable Object name under {scope}/", () => {
    expect(keys.config("tenant_1")).toBe("tenant_1/config");
    expect(keys.thread("tenant_1", "t-42")).toBe("tenant_1/thread/t-42");
  });

  it("mints every R2 key under {scope}/", () => {
    expect(keys.r2Prefix("tenant_1")).toBe("tenant_1/");
    expect(keys.media("tenant_1", "t-42", "01ARZ")).toBe("tenant_1/media/t-42/01ARZ");
  });

  it("keeps one Scope's prefix from matching another's", () => {
    expect(keys.config("ab").startsWith(keys.r2Prefix("a"))).toBe(false);
    expect(keys.thread("a", "x").startsWith(keys.r2Prefix("a"))).toBe(true);
  });

  it("refuses an id that could escape its prefix", () => {
    expect(() => keys.config("../other")).toThrowError(new KarmiError("scope.id.invalid", 'ScopeId "../other" must match [A-Za-z0-9_-]{1,64}.'));
    expect(() => keys.thread("a", "b/c")).toThrowError(new KarmiError("thread.id.invalid", 'threadId "b/c" must match [A-Za-z0-9_-]{1,64}.'));
  });
});
