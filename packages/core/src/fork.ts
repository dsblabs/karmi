import { ulid } from "ulid";
import { isMediaRef, type MediaRef } from "./context";
import { keys, parseObjectKey, threadMayRead, type ObjectKey } from "./keys";
import type { ObjectCopy } from "./media";

/** The rows a Fork is seeded with and the R2 copies that must land before them. */
export interface ForkMedia<Row> {
  /** The original Thread's rows with every ref it may read pointing into the Fork's prefixes. */
  rows: Row[];
  /** One copy per object the rows refer to. */
  copies: ObjectCopy[];
}

/**
 * Rewrites every MediaRef in `rows` that Thread `source` may read so that it points into the Fork `target`'s own
 * prefixes, and lists the copies that make those keys real (ADR-0004). Each object is copied once however many
 * rows refer to it. A ref `source` may not read is left as it was. `mint` makes a media id for a spilled output
 * that a Delegation parent or child wrote, whose sequence number could collide with the Fork's own.
 */
export function forkMedia<Row extends { json: string }>(
  rows: readonly Row[],
  scope: string,
  source: string,
  target: string,
  mint: () => string = ulid,
): ForkMedia<Row> {
  const moved = new Map<string, Pick<MediaRef, "id" | "key">>();
  const move = (ref: MediaRef): MediaRef => {
    const owner = parseObjectKey(ref.key);
    if (!owner || !threadMayRead(ref.key, scope, source)) return ref;
    let to = moved.get(ref.key);
    if (!to) moved.set(ref.key, (to = destination(owner, ref, source, target, mint)));
    return { ...ref, ...to };
  };
  // Every ref key starts with the Scope, so a row that does not mention it is left unparsed.
  const marker = JSON.stringify(`${scope}/`).slice(0, -1);
  const seeded = rows.map((row) =>
    row.json.includes(marker) ? { ...row, json: JSON.stringify(rewrite(JSON.parse(row.json), move)) } : row,
  );
  return { rows: seeded, copies: [...moved].map(([from, to]) => [from, to.key]) };
}

function destination(
  owner: ObjectKey,
  ref: MediaRef,
  source: string,
  target: string,
  mint: () => string,
): Pick<MediaRef, "id" | "key"> {
  if (owner.kind === "media") return { id: ref.id, key: keys.media(owner.scope, target, owner.id) };
  // A Thread reads its own spilled output back by sequence number, so the Fork keeps that number.
  if (owner.threadId === source)
    return {
      id: ref.id,
      key: owner.structured
        ? keys.structuredToolOutput(owner.scope, target, owner.seq)
        : keys.toolOutput(owner.scope, target, owner.seq),
    };
  const id = mint();
  return { id, key: keys.media(owner.scope, target, id) };
}

function rewrite(value: unknown, move: (ref: MediaRef) => MediaRef): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, move));
  if (typeof value !== "object" || value === null) return value;
  if ("key" in value && isMediaRef(value)) return move(value);
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewrite(item, move)]));
}
