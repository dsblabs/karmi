import { describe, expect, it } from "vitest";
import { forkMedia } from "../src/fork";

const ref = (key: string, id = "01ARZ") => ({ id, key, mimeType: "application/pdf", bytes: 9 });
const row = (seq: number, body: unknown) => ({ seq, turn: 1, at: 0, json: JSON.stringify(body) });
const decoded = (rows: { json: string }[]) => rows.map((r): unknown => JSON.parse(r.json));

describe("forkMedia", () => {
  it("moves every ref the original Thread may read into the Fork's own prefixes", () => {
    const rows = [
      row(1, { type: "turn.input", input: { parts: [{ type: "file", media: ref("s/media/orig/01A", "01A") }] } }),
      row(2, {
        type: "tool.result",
        content: [{ type: "media", media: ref("s/media/orig/call/01B", "01B") }],
        output: ref("s/threads/orig/tool-output/2", "2"),
        structuredOutput: ref("s/threads/orig/tool-output/2.json", "2-structured"),
      }),
    ];
    const { rows: seeded, copies } = forkMedia(rows, "s", "orig", "fork", () => "minted");
    expect(decoded(seeded)).toEqual([
      { type: "turn.input", input: { parts: [{ type: "file", media: ref("s/media/fork/01A", "01A") }] } },
      {
        type: "tool.result",
        content: [{ type: "media", media: ref("s/media/fork/01B", "01B") }],
        output: ref("s/threads/fork/tool-output/2", "2"),
        structuredOutput: ref("s/threads/fork/tool-output/2.json", "2-structured"),
      },
    ]);
    expect(copies).toEqual([
      ["s/media/orig/01A", "s/media/fork/01A"],
      ["s/media/orig/call/01B", "s/media/fork/01B"],
      ["s/threads/orig/tool-output/2", "s/threads/fork/tool-output/2"],
      ["s/threads/orig/tool-output/2.json", "s/threads/fork/tool-output/2.json"],
    ]);
    expect(seeded.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("gives another Thread's spilled output a fresh media id so it cannot collide with the Fork's own", () => {
    const rows = [row(1, { parts: [{ type: "file", media: ref("s/threads/orig/call/tool-output/4", "4") }] })];
    const { rows: seeded, copies } = forkMedia(rows, "s", "orig", "fork", () => "minted");
    expect(decoded(seeded)).toEqual([{ parts: [{ type: "file", media: ref("s/media/fork/minted", "minted") }] }]);
    expect(copies).toEqual([["s/threads/orig/call/tool-output/4", "s/media/fork/minted"]]);
  });

  it("copies an object once however many rows refer to it", () => {
    const media = ref("s/media/orig/01A", "01A");
    const { copies } = forkMedia([row(1, { media }), row(2, { again: [media] })], "s", "orig", "fork");
    expect(copies).toEqual([["s/media/orig/01A", "s/media/fork/01A"]]);
  });

  it("leaves refs the original Thread may not read, and rows without refs, as they were", () => {
    const rows = [
      row(1, { media: ref("s/media/other/01A") }),
      row(2, { media: ref("x/media/orig/01A") }),
      row(3, { type: "text", text: "s/media/orig/01A" }),
    ];
    const { rows: seeded, copies } = forkMedia(rows, "s", "orig", "fork");
    expect(seeded).toEqual(rows);
    expect(copies).toEqual([]);
  });
});
