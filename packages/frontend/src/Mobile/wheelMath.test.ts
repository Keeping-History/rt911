import { describe, expect, it } from "vitest";
import { angleDeg, WheelTracker } from "./wheelMath";

describe("angleDeg", () => {
	it("measures the angle of a point around a center", () => {
		expect(angleDeg(0, 0, 10, 0)).toBeCloseTo(0);
		expect(angleDeg(0, 0, 0, 10)).toBeCloseTo(90);
		expect(angleDeg(0, 0, -10, 0)).toBeCloseTo(180);
	});
});

describe("WheelTracker", () => {
	it("emits one step per 25 degrees of rotation, carrying the remainder", () => {
		const t = new WheelTracker();
		t.start(0, 1000);
		expect(t.move(20, 1010)).toBe(0); // below threshold
		expect(t.move(30, 1020)).toBe(1); // total 30 → 1 step, 5° carried
		expect(t.move(50, 1030)).toBe(1); // carry 5 + 20 = 25 → 1 step
	});

	it("emits negative steps for counter-clockwise rotation", () => {
		const t = new WheelTracker();
		t.start(90, 1000);
		expect(t.move(40, 1010)).toBe(-2); // −50° → −2 steps
	});

	it("handles the ±180° wrap without a spurious jump", () => {
		const t = new WheelTracker();
		t.start(170, 1000);
		expect(t.move(-165, 1010)).toBe(1); // 170 → −165 is +25° through the wrap
	});

	it("rejects impossible jumps (>60° in one move)", () => {
		const t = new WheelTracker();
		t.start(0, 1000);
		expect(t.move(90, 1010)).toBe(0); // teleport across the wheel: ignored
		expect(t.move(115, 1020)).toBe(1); // tracking resumes from 90
	});

	it("resets accumulation after a 150ms stall", () => {
		const t = new WheelTracker();
		t.start(0, 1000);
		expect(t.move(20, 1010)).toBe(0);
		expect(t.move(45, 1500)).toBe(0); // stale: re-anchors, drops the 20°
		expect(t.move(70, 1510)).toBe(1);
	});

	it("distinguishes taps from scrolls with a 5° dead zone", () => {
		const t = new WheelTracker();
		t.start(0, 1000);
		t.move(3, 1010);
		expect(t.hasScrolled).toBe(false); // a wobbling tap
		t.move(9, 1020);
		expect(t.hasScrolled).toBe(true);
	});

	it("clears state on end()/start()", () => {
		const t = new WheelTracker();
		t.start(0, 1000);
		t.move(20, 1010);
		expect(t.hasScrolled).toBe(true);
		t.end();
		t.start(0, 2000);
		expect(t.hasScrolled).toBe(false); // reset by start(), before any move
		expect(t.move(20, 2010)).toBe(0); // previous 20° did not leak
	});
});
