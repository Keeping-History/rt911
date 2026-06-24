import { describe, expect, it } from "vitest";
import { virtualUtcMs } from "./virtualClock";

// toLocalDate mirrors the Classicy hook: localDate is the UTC instant shifted by
// the timezone offset (the display clock). These tests assert that virtualUtcMs
// inverts that shift, so the stream gate/seek instant stays in UTC.
const toLocalDate = (utcMs: number, tz: number) =>
	new Date(utcMs + tz * 60 * 60 * 1000);

describe("virtualUtcMs", () => {
	it("recovers the UTC instant from the tz-shifted display clock", () => {
		const utcMs = new Date("2001-09-11T12:46:00.000Z").getTime();
		for (const tz of [-5, -4, 0, 1, 9]) {
			expect(virtualUtcMs(toLocalDate(utcMs, tz), tz)).toBe(utcMs);
		}
	});

	it("equals the UTC dateTime the seek path sends, not the shifted localDate", () => {
		// Regression: the reveal gate must equal the seek instant. The old bug used
		// localDate.getTime() directly, which sits tzOffset hours away from the UTC
		// instant the server windows around — so fresh items never surface.
		const utcMs = new Date("2001-09-11T13:00:00.000Z").getTime();
		const tz = -4;
		const localDate = toLocalDate(utcMs, tz);
		expect(virtualUtcMs(localDate, tz)).toBe(utcMs);
		expect(virtualUtcMs(localDate, tz)).not.toBe(localDate.getTime());
	});

	it("advances per second as the display clock ticks (UTC frame preserved)", () => {
		const utcMs = new Date("2001-09-11T13:00:00.000Z").getTime();
		const tz = 5;
		// localDate ticks forward one second; the UTC instant must track it 1:1.
		const t0 = virtualUtcMs(toLocalDate(utcMs, tz), tz);
		const t1 = virtualUtcMs(toLocalDate(utcMs + 1000, tz), tz);
		expect(t1 - t0).toBe(1000);
		expect(t0).toBe(utcMs);
	});
});
