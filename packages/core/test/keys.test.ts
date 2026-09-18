import { describe, expect, it } from "vitest";
import { KarmiError } from "../src/index";
import { keys, parseObjectKey, threadMayRead } from "../src/keys";

// A bug here is a cross-Scope bug (ADR-0001), so the keys module gets tests of its own.
describe("keys", () => {
  it("mints every Durable Object name under {scope}/", () => {
    expect(keys.config("acme")).toBe("acme/config");
    expect(keys.thread("acme", "t-42")).toBe("acme/thread/t-42");
    expect(keys.memory("acme", "guest-1")).toBe("acme/memory/guest-1");
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
    expect(() => keys.thread("a", "b/../c")).toThrowError(new KarmiError("thread.id.invalid", "Invalid Thread id."));
    expect(() => keys.memory("a", "../b")).toThrowError(
      new KarmiError("user.id.invalid", 'user "../b" must match [A-Za-z0-9_-]{1,64}.'),
    );
  });

  it("parses media and spilled-output keys and nothing else", () => {
    expect(parseObjectKey("acme/media/t-1/01ARZ")).toEqual({
      kind: "media",
      scope: "acme",
      threadId: "t-1",
      id: "01ARZ",
    });
    expect(parseObjectKey("acme/media/t-1/call%2F1/01ARZ")).toMatchObject({ threadId: "t-1/call%2F1", id: "01ARZ" });
    expect(parseObjectKey("acme/threads/t-1/tool-output/7")).toEqual({
      kind: "tool-output",
      scope: "acme",
      threadId: "t-1",
      seq: 7,
      structured: false,
    });
    expect(parseObjectKey("acme/threads/t-1/tool-output/7.json")).toMatchObject({ seq: 7, structured: true });
    expect(parseObjectKey("acme/config")).toBeUndefined();
    expect(parseObjectKey("acme/media/../x/01ARZ")).toBeUndefined();
  });

  it("lets a Thread read its own objects and those of its Delegation parents and children, and no other Thread's", () => {
    expect(threadMayRead("acme/media/t-1/01ARZ", "acme", "t-1")).toBe(true);
    expect(threadMayRead("acme/threads/t-1/tool-output/7", "acme", "t-1")).toBe(true);
    expect(threadMayRead("acme/media/t-1/call/01ARZ", "acme", "t-1")).toBe(true);
    expect(threadMayRead("acme/media/t-1/01ARZ", "acme", "t-1/call")).toBe(true);
    expect(threadMayRead("acme/media/t-1/call/01ARZ", "acme", "t-1/other")).toBe(false);
    expect(threadMayRead("acme/media/t-2/01ARZ", "acme", "t-1")).toBe(false);
    expect(threadMayRead("acme/media/t-10/01ARZ", "acme", "t-1")).toBe(false);
    expect(threadMayRead("other/media/t-1/01ARZ", "acme", "t-1")).toBe(false);
    expect(threadMayRead("acme/config", "acme", "t-1")).toBe(false);
  });
});
