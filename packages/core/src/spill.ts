import type { MediaRef } from "./context.js";

// Spill: a Tool result over the Agent's `context.toolOutput` limit is stored whole and shown to the
// model as head + tail + a marker naming the ref `read_output` re-reads it by.

export interface OutputLimits {
  maxChars: number;
  maxLines: number;
}

export type Truncation = { truncated: false; text: string } | { truncated: true; head: string; tail: string; omitted: { chars: number; lines: number } };

export function truncateOutput(text: string, limits: OutputLimits): Truncation {
  const lines = text.split("\n");
  if (text.length <= limits.maxChars && lines.length <= limits.maxLines) return { truncated: false, text };
  let head: string;
  let tail: string;
  if (lines.length > limits.maxLines) {
    const keep = Math.floor(limits.maxLines / 2);
    head = lines.slice(0, keep).join("\n");
    tail = lines.slice(lines.length - keep).join("\n");
  } else {
    head = text;
    tail = "";
  }
  if (head.length + tail.length > limits.maxChars) {
    const keep = Math.floor(limits.maxChars / 2);
    head = head.slice(0, keep);
    tail = tail.slice(tail.length - Math.min(keep, tail.length)) || text.slice(-keep);
  }
  const count = (part: string) => (part ? part.split("\n").length : 0);
  return { truncated: true, head, tail, omitted: { chars: Math.max(0, text.length - head.length - tail.length), lines: Math.max(0, lines.length - count(head) - count(tail)) } };
}

/** What the model sees in place of a spilled result. */
export function renderTruncated(cut: Extract<Truncation, { truncated: true }>, ref: MediaRef | undefined): string {
  const where = ref ? `The full output is stored as ref "${ref.id}"; call read_output with that ref to read it.` : "The full output could not be stored.";
  return `${cut.head}\n\n[... ${cut.omitted.chars} characters (${cut.omitted.lines} lines) omitted. ${where} ...]\n\n${cut.tail}`;
}
