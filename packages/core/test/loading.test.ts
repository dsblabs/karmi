import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/index";
import type { ThreadEventData } from "../src/thread-events";
import { deferAll, foldLoaded, searchTools, SEARCH_LIMIT } from "../src/loading";

const tool = (name: string, description: string, input: z.ZodObject = z.object({})) =>
  defineTool({ name, description, input, execute: () => "" });

const index = [
  tool("get_weather", "Current weather for a city", z.object({ city: z.string() })),
  tool("book_room", "Book a hotel room", z.object({ room: z.number(), nights: z.number() })),
  tool("list_maps", "Ancient maps in the archive"),
  tool("scan_map", "Scan one ancient map at high resolution", z.object({ mapId: z.string() })),
  tool("send_mail", "Send an email", z.object({ to: z.string(), subject: z.string() })),
  tool("read_mail", "Read the inbox"),
  tool("archive_mail", "Move mail to the archive"),
];

describe("searchTools", () => {
  it("select: loads the named Tools exactly and reports the names it does not know", () => {
    expect(searchTools("select:get_weather, scan_map,nope", index)).toEqual({
      matches: ["get_weather", "scan_map"],
      unknown: ["nope"],
    });
  });

  it("ranks keyword matches over name, description and argument names, best first", () => {
    expect(searchTools("ancient map", index).matches).toEqual(["list_maps", "scan_map"]);
    expect(searchTools("nights", index).matches).toEqual(["book_room"]);
    expect(searchTools("mail", index).matches).toEqual(["send_mail", "read_mail", "archive_mail"]);
  });

  it("is case-insensitive, caps the matches at the limit and answers nothing for no match", () => {
    expect(searchTools("MAIL archive", index).matches[0]).toBe("archive_mail");
    const many = Array.from({ length: 12 }, (_, i) => tool(`t${i}`, "same words here"));
    expect(searchTools("same words", many).matches).toHaveLength(SEARCH_LIMIT);
    expect(searchTools("zebra", index)).toEqual({ matches: [], unknown: [] });
    expect(searchTools("   ", index)).toEqual({ matches: [], unknown: [] });
  });
});

describe("deferAll", () => {
  const definitions = [
    { name: "a", description: "x".repeat(400), inputSchema: {} },
    { name: "b", description: "y".repeat(400), inputSchema: {} },
  ];
  it("always and never decide alone; auto compares the deferrable definitions against threshold × window", () => {
    expect(deferAll({ defer: "always", threshold: 0.1 }, definitions, 1_000_000)).toBe(true);
    expect(deferAll({ defer: "never", threshold: 0.1 }, definitions, 10)).toBe(false);
    // About 230 tokens of definitions: over 10% of a 2000-token window, under 10% of 200k.
    expect(deferAll({ defer: "auto", threshold: 0.1 }, definitions, 2_000)).toBe(true);
    expect(deferAll({ defer: "auto", threshold: 0.1 }, definitions, 200_000)).toBe(false);
    expect(deferAll({ defer: "auto", threshold: 0.1 }, [], 10)).toBe(false);
  });
});

describe("foldLoaded", () => {
  it("unions every load point and remembers which Skills were activated", () => {
    const events: ThreadEventData[] = [
      { type: "tools.loaded", names: ["a", "b"] },
      { type: "turn.completed", stopReason: "end_turn", message: [] },
      { type: "tools.loaded", names: ["b", "c"], skill: { name: "research" } },
    ];
    const loaded = foldLoaded(events);
    expect([...loaded.tools]).toEqual(["a", "b", "c"]);
    expect([...loaded.skills]).toEqual(["research"]);
  });
});
