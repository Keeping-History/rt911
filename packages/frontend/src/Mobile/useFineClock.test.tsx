import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial-mock classicy: replace ONLY useClassicyDateTime. Never replace the
// whole module — new classicy imports elsewhere would explode.
// vi.hoisted is required: imports (and vi.mock) hoist above plain consts, so
// a bare `const clockState` would hit a TDZ error inside the mock factory.
const clockState = vi.hoisted(() => ({
	dateTime: "2001-09-11T12:40:00.000Z",
	paused: false,
	tzOffset: -4,
}));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useClassicyDateTime: () => clockState,
}));

import { useFineClock } from "./useFineClock";

afterEach(cleanup);
beforeEach(() => {
	vi.useFakeTimers();
	clockState.paused = false;
});

function Probe() {
	const { nowMs, clockPaused, tzOffset } = useFineClock();
	return <div data-testid="probe" data-now={nowMs} data-paused={clockPaused} data-tz={tzOffset} />;
}

describe("useFineClock", () => {
	it("starts at the classicy dateTime and advances with real time", () => {
		render(<Probe />);
		const base = Date.parse("2001-09-11T12:40:00.000Z");
		expect(Number(screen.getByTestId("probe").dataset.now)).toBeGreaterThanOrEqual(base);
		act(() => vi.advanceTimersByTime(3000));
		const now = Number(screen.getByTestId("probe").dataset.now);
		expect(now - base).toBeGreaterThanOrEqual(3000);
		expect(now - base).toBeLessThan(5000);
	});

	it("freezes while the clock is paused", () => {
		clockState.paused = true;
		render(<Probe />);
		const before = Number(screen.getByTestId("probe").dataset.now);
		act(() => vi.advanceTimersByTime(3000));
		expect(Number(screen.getByTestId("probe").dataset.now)).toBe(before);
	});

	it("exposes the display timezone offset", () => {
		render(<Probe />);
		expect(screen.getByTestId("probe").dataset.tz).toBe("-4");
	});
});
