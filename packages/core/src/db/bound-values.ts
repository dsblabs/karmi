/**
 * The most values that one SQL statement of a Durable Object can bind. SQLite refuses a statement above it with
 * `too many SQL variables`.
 */
export const MAX_BOUND_VALUES = 100;

/**
 * Splits `items` into batches that one SQL statement each can bind, in the same order. `valuesPerItem` is how many
 * values one item binds: the column count of an inserted row, or 1 for an entry of an `IN` list.
 */
export function boundBatches<T>(items: readonly T[], valuesPerItem = 1): T[][] {
  const size = Math.max(1, Math.floor(MAX_BOUND_VALUES / valuesPerItem));
  const batches: T[][] = [];
  for (let from = 0; from < items.length; from += size) batches.push(items.slice(from, from + size));
  return batches;
}
