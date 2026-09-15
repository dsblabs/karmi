import { describe, expect, it } from "vitest";
import type { MemoryProfileSchema } from "../src/agent";
import { ftsQuery, profileWriteIssues, renderMemory } from "../src/memory";

const schema: MemoryProfileSchema = {
  properties: {
    tier: { type: "string", enum: ["silver", "gold"] },
    seat: { type: "string", description: "Preferred seat" },
    visits: { type: "integer", minimum: 0 },
    tags: { type: "array", items: { type: "string", maxLength: 5 } },
    address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    nickname: { type: ["string", "null"], pattern: "^[a-z]+$" },
  },
};

describe("profileWriteIssues", () => {
  it("accepts values that fit their field and null to clear a field", () => {
    expect(
      profileWriteIssues(schema, {
        tier: "gold",
        visits: 3,
        tags: ["a", "b"],
        address: { city: "Paris", extra: true },
        seat: null,
      }),
    ).toEqual([]);
  });

  it("rejects a field the Agent does not declare, and any field without a schema", () => {
    expect(profileWriteIssues(schema, { colour: "red" })).toEqual(['"colour" is not a profile field of this Agent.']);
    expect(profileWriteIssues(undefined, { tier: "gold" })).toEqual(["This Agent declares no profile fields."]);
    expect(profileWriteIssues({ properties: {} }, {})).toEqual([]);
  });

  it("checks type, enum, bounds, length, pattern, items and nested required", () => {
    expect(profileWriteIssues(schema, { tier: "bronze" })).toEqual(['"tier" must be one of "silver", "gold".']);
    expect(profileWriteIssues(schema, { visits: 1.5 })).toEqual(['"visits" must be an integer.']);
    expect(profileWriteIssues(schema, { visits: -1 })).toEqual(['"visits" must be at least 0.']);
    expect(profileWriteIssues(schema, { tags: ["toolong"] })).toEqual(['"tags[0]" must be at most 5 characters.']);
    expect(profileWriteIssues(schema, { tags: "a" })).toEqual(['"tags" must be an array.']);
    expect(profileWriteIssues(schema, { address: {} })).toEqual(['"address.city" is required.']);
    expect(profileWriteIssues(schema, { nickname: "Bob" })).toEqual(['"nickname" must match /^[a-z]+$/.']);
    expect(profileWriteIssues(schema, { nickname: 7 })).toEqual(['"nickname" must be a string or null.']);
  });
});

describe("ftsQuery", () => {
  it("quotes every term so punctuation and FTS keywords are searched, not parsed", () => {
    expect(ftsQuery("window seat")).toBe('"window" OR "seat"');
    expect(ftsQuery('  likes "quiet" AND NOT loud ')).toBe('"likes" OR """quiet""" OR "AND" OR "NOT" OR "loud"');
    expect(ftsQuery("   ")).toBeUndefined();
  });
});

describe("renderMemory", () => {
  const view = {
    profile: { tier: "gold", seat: "window" },
    notes: [
      { id: 2, text: "Travels with a cat", agent: "concierge", at: Date.UTC(2026, 8, 14) },
      { id: 1, text: "Vegetarian", agent: "porter", at: Date.UTC(2026, 0, 2) },
    ],
  };

  it("renders the profile and the most recent notes with a pointer to the Tools", () => {
    expect(renderMemory(view, true)).toBe(
      [
        "# Memory",
        "What is known about this user from earlier conversations. Update the profile or add a note with `remember`; search older notes with `recall`.",
        "",
        "## Profile",
        '- tier: "gold"',
        '- seat: "window"',
        "",
        "## Recent notes",
        "- 2026-09-14: Travels with a cat",
        "- 2026-01-02: Vegetarian",
      ].join("\n"),
    );
  });

  it("leaves the notes out when they are disabled, and says when nothing is known", () => {
    const text = renderMemory(view, false);
    expect(text).not.toContain("## Recent notes");
    expect(text).toContain("Update the profile with `remember`.");
    expect(renderMemory({ profile: {}, notes: [] }, true)).toContain("Nothing is known about this user yet.");
  });
});
