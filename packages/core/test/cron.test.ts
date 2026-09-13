import { describe, expect, it } from "vitest";
import { nextCronTime, parseCron } from "../src/cron";

const at = (iso: string) => Date.parse(iso);

describe("parseCron", () => {
  it("accepts the five standard fields with lists, ranges and steps", () => {
    expect(parseCron("*/15 9-17 * * 1-5")).toBeDefined();
    expect(parseCron("0 0 1,15 * *")).toBeDefined();
    expect(parseCron("30 4 * * sun")).toBeDefined();
    expect(parseCron("0 12 * jan-mar *")).toBeDefined();
  });
  it("rejects anything else", () => {
    expect(parseCron("* * * *")).toBeUndefined();
    expect(parseCron("60 * * * *")).toBeUndefined();
    expect(parseCron("* 24 * * *")).toBeUndefined();
    expect(parseCron("* * 0 * *")).toBeUndefined();
    expect(parseCron("* * * 13 *")).toBeUndefined();
    expect(parseCron("* * * * 8")).toBeUndefined();
    expect(parseCron("*/0 * * * *")).toBeUndefined();
    expect(parseCron("5-1 * * * *")).toBeUndefined();
    expect(parseCron("a * * * *")).toBeUndefined();
  });
});

describe("nextCronTime", () => {
  it("finds the next minute strictly after the given instant, in UTC", () => {
    expect(nextCronTime("*/15 * * * *", at("2026-09-14T10:00:00Z"), "UTC")).toBe(at("2026-09-14T10:15:00Z"));
    expect(nextCronTime("*/15 * * * *", at("2026-09-14T10:14:59.500Z"), "UTC")).toBe(at("2026-09-14T10:15:00Z"));
    expect(nextCronTime("0 9 * * 1-5", at("2026-09-11T09:00:00Z"), "UTC")).toBe(at("2026-09-14T09:00:00Z"));
  });
  it("honours the IANA zone, including a DST change", () => {
    // 2026-03-29 02:00 CET does not exist; the 02:30 job runs at the next valid 02:30, on the 30th.
    expect(nextCronTime("30 2 * * *", at("2026-03-28T12:00:00Z"), "Europe/Berlin")).toBe(at("2026-03-30T00:30:00Z"));
    expect(nextCronTime("0 9 * * *", at("2026-07-01T00:00:00Z"), "America/New_York")).toBe(at("2026-07-01T13:00:00Z"));
  });
  it("matches either day field when both are restricted", () => {
    // Friday the 13th or the 1st, whichever comes first.
    expect(nextCronTime("0 0 1 * 5", at("2026-11-02T00:00:00Z"), "UTC")).toBe(at("2026-11-06T00:00:00Z"));
  });
  it("gives up on an expression that can never fire", () => {
    expect(nextCronTime("0 0 30 2 *", at("2026-01-01T00:00:00Z"), "UTC")).toBeUndefined();
  });
});
