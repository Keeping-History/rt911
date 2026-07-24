// bookmarkTime.test.ts
import { describe, expect, it } from "vitest";
import {
  parseDirectusUtc, toDirectusUtcString, utcToLocalParts, localPartsToUtcDate,
} from "./bookmarkTime";

describe("bookmarkTime", () => {
  it("parses a bare UTC string as UTC", () => {
    expect(parseDirectusUtc("2001-09-11T12:46:40").toISOString()).toBe("2001-09-11T12:46:40.000Z");
  });
  it("respects an existing zone designator", () => {
    expect(parseDirectusUtc("2001-09-11T12:46:40Z").toISOString()).toBe("2001-09-11T12:46:40.000Z");
  });
  it("serializes a Date to a bare UTC wall-clock string", () => {
    expect(toDirectusUtcString(new Date("2001-09-11T12:46:40.000Z"))).toBe("2001-09-11T12:46:40");
  });
  it("splits a UTC instant into local 12h parts (UTC-4)", () => {
    // 12:46:40Z - 4h = 08:46:40 local -> 8:46:40 AM
    expect(utcToLocalParts(new Date("2001-09-11T12:46:40.000Z"), -4)).toEqual({
      hours: "8", minutes: "46", seconds: "40", ampm: "AM",
    });
  });
  it("round-trips local parts back to the same UTC instant", () => {
    const base = new Date("2001-09-11T00:00:00.000Z");
    const parts = { hours: "8", minutes: "46", seconds: "40", ampm: "AM" };
    expect(toDirectusUtcString(localPartsToUtcDate(base, parts, -4))).toBe("2001-09-11T12:46:40");
  });
  it("handles 12 PM/12 AM correctly", () => {
    const base = new Date("2001-09-11T00:00:00.000Z");
    expect(toDirectusUtcString(localPartsToUtcDate(base, { hours: "12", minutes: "0", seconds: "0", ampm: "PM" }, 0)))
      .toBe("2001-09-11T12:00:00");
    expect(toDirectusUtcString(localPartsToUtcDate(base, { hours: "12", minutes: "0", seconds: "0", ampm: "AM" }, 0)))
      .toBe("2001-09-11T00:00:00");
  });
});
