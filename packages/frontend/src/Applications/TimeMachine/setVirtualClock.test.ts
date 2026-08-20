import { describe, expect, it, vi } from "vitest";
import { formatUtcAsLocalTime, setDateTimeFromUtc } from "./setVirtualClock";

describe("setDateTimeFromUtc", () => {
	it("parses a bare Directus datetime (no zone) as UTC", () => {
		const setDateTime = vi.fn();
		const applied = setDateTimeFromUtc(setDateTime, "2001-09-11T12:46:40");
		// 12:46:40 with no zone must be read as UTC, not local — this is the whole
		// point of the helper (Directus omits the "Z").
		expect(applied.toISOString()).toBe("2001-09-11T12:46:40.000Z");
		expect(setDateTime).toHaveBeenCalledExactlyOnceWith(applied);
	});

	it("respects an explicit Z suffix", () => {
		const setDateTime = vi.fn();
		const applied = setDateTimeFromUtc(setDateTime, "2001-09-11T13:02:57Z");
		expect(applied.toISOString()).toBe("2001-09-11T13:02:57.000Z");
	});

	it("respects an explicit numeric offset", () => {
		const setDateTime = vi.fn();
		const applied = setDateTimeFromUtc(setDateTime, "2001-09-11T08:46:40-04:00");
		expect(applied.toISOString()).toBe("2001-09-11T12:46:40.000Z");
	});

	it("throws on an unparseable string instead of seeking to Invalid Date", () => {
		const setDateTime = vi.fn();
		expect(() => setDateTimeFromUtc(setDateTime, "not a date")).toThrow(/Unparseable UTC date string/);
		expect(setDateTime).not.toHaveBeenCalled();
	});
});

describe("formatUtcAsLocalTime", () => {
	it("shifts a bare-UTC datetime into 12-hour local time (EDT, -4)", () => {
		// 12:46:40 UTC → 08:46:40 EDT — the moment the first plane hit.
		expect(formatUtcAsLocalTime("2001-09-11T12:46:40", -4)).toBe("8:46:40 AM");
	});

	it("renders noon and midnight correctly (12-hour, not 0)", () => {
		expect(formatUtcAsLocalTime("2001-09-11T16:00:00", -4)).toBe("12:00:00 PM");
		expect(formatUtcAsLocalTime("2001-09-11T04:00:00", -4)).toBe("12:00:00 AM");
	});

	it("uses the instant as-is at a zero offset", () => {
		expect(formatUtcAsLocalTime("2001-09-11T13:02:57Z", 0)).toBe("1:02:57 PM");
	});
});
