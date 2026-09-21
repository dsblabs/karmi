import { expect, it } from "vitest";
import { boundBatches, MAX_BOUND_VALUES } from "../src/db/bound-values";

it("splits a list so that no batch binds more values than one statement can", () => {
  const items = Array.from({ length: 251 }, (_, index) => index);
  for (const valuesPerItem of [1, 5, 7, MAX_BOUND_VALUES, MAX_BOUND_VALUES + 1]) {
    const batches = boundBatches(items, valuesPerItem);
    expect(batches.flat()).toEqual(items);
    // One item that is wider than the limit still gets a batch, and SQLite reports it.
    for (const batch of batches)
      expect(batch.length * valuesPerItem).toBeLessThanOrEqual(Math.max(MAX_BOUND_VALUES, valuesPerItem));
  }
  expect(boundBatches([])).toEqual([]);
});
