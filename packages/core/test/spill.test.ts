import { describe, expect, it } from "vitest";
import { truncateOutput } from "../src/spill";

describe("truncateOutput", () => {
  it("leaves output within both limits untouched", () => {
    expect(truncateOutput("a\nb\nc", { maxChars: 100, maxLines: 10 })).toEqual({ truncated: false, text: "a\nb\nc" });
  });

  it("keeps head and tail with a marker when the char limit is exceeded", () => {
    const text = "0123456789".repeat(10);
    const out = truncateOutput(text, { maxChars: 40, maxLines: 10 });
    expect(out.truncated).toBe(true);
    if (!out.truncated) return;
    expect(out.head).toBe(text.slice(0, 20));
    expect(out.tail).toBe(text.slice(-20));
    expect(out.omitted).toEqual({ chars: 60, lines: 0 });
  });

  it("cuts on line boundaries when the line limit is exceeded", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const out = truncateOutput(text, { maxChars: 1000, maxLines: 4 });
    expect(out.truncated).toBe(true);
    if (!out.truncated) return;
    expect(out.head).toBe("line 0\nline 1");
    expect(out.tail).toBe("line 8\nline 9");
    expect(out.omitted.lines).toBe(6);
  });
});
