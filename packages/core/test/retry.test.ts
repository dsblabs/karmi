import { describe, expect, it } from "vitest";
import { retry } from "../src/index.js";

const retryable = (error: unknown) => error instanceof Error && error.message === "again";

describe("retry", () => {
  it("returns the first successful result", async () => {
    let calls = 0;
    const value = await retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("again");
        return "ok";
      },
      { retryable, delayMs: 0 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows a non-retryable error at once", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        { retryable, delayMs: 0 },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("gives up after `attempts` and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("again");
        },
        { retryable, attempts: 2, delayMs: 0 },
      ),
    ).rejects.toThrow("again");
    expect(calls).toBe(2);
  });

  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = retry(
      async () => {
        calls++;
        throw new Error("again");
      },
      { retryable, attempts: 5, delayMs: 10_000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(retry(async () => void calls++, { retryable, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toBe(0);
  });
});
