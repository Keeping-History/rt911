import { describe, expect, it } from "vitest";
import { describeDuration, transportBalloons } from "./transportBalloons";

describe("describeDuration", () => {
	it("spells durations out in prose, singular and plural", () => {
		expect(describeDuration(1)).toBe("1 second");
		expect(describeDuration(45)).toBe("45 seconds");
		expect(describeDuration(60)).toBe("1 minute");
		expect(describeDuration(120)).toBe("2 minutes");
		expect(describeDuration(150)).toBe("2 minutes 30 seconds");
		expect(describeDuration(61)).toBe("1 minute 1 second");
	});

	it("never returns an empty string", () => {
		expect(describeDuration(0)).toBe("0 seconds");
	});
});

describe("transportBalloons", () => {
	const base = { skipMinutes: 5, stepSeconds: 90, scrubSeconds: 10, paused: false };

	it("quotes the live Settings distances, not fixed copy", () => {
		const b = transportBalloons(base);
		expect(b.skipBack.content).toContain("back 5 minutes");
		expect(b.skipForward.content).toContain("forward 5 minutes");
		expect(b.stepBack.content).toContain("back 1 minute 30 seconds");
		expect(b.stepForward.content).toContain("forward 1 minute 30 seconds");
		expect(b.scrubBack.content).toContain("back 10 seconds");
		expect(b.scrubForward.content).toContain("forward 10 seconds");

		const changed = transportBalloons({ ...base, skipMinutes: 1 });
		expect(changed.skipBack.content).toContain("back 1 minute.");
	});

	it("points at File > Settings… for every distance button", () => {
		const b = transportBalloons(base);
		for (const key of [
			"skipBack",
			"stepBack",
			"scrubBack",
			"scrubForward",
			"stepForward",
			"skipForward",
		] as const) {
			expect(b[key].content).toContain("Settings…");
		}
	});

	it("explains why the dimmed one of Play/Pause is unavailable", () => {
		const running = transportBalloons({ ...base, paused: false });
		expect(running.play.content).toMatch(/^Not available/);
		expect(running.pause.content).not.toMatch(/^Not available/);

		const paused = transportBalloons({ ...base, paused: true });
		expect(paused.play.content).not.toMatch(/^Not available/);
		expect(paused.pause.content).toMatch(/^Not available/);
	});

	it("gives every button a title usable as its accessible name", () => {
		const b = transportBalloons(base);
		expect(Object.values(b).map((x) => x.title)).toEqual([
			"Skip Back",
			"Step Back",
			"Scrub Back",
			"Play",
			"Pause",
			"Scrub Forward",
			"Step Forward",
			"Skip Forward",
		]);
	});
});
