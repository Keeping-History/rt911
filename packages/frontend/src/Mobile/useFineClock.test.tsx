import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Partial-mock classicy: replace ONLY useClassicyDateTime. Never replace the
// whole module — new classicy imports elsewhere would explode.
// vi.hoisted is required: imports (and vi.mock) hoist above plain consts, so
// a bare `const clockState` would hit a TDZ error inside the mock factory.
const clockState = vi.hoisted(() => ({
	localDate: new Date("2001-09-11T08:40:00.000Z"),
	paused: false,
	tzOffset: -4 as number | string,
}));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useClassicyDateTime: () => clockState,
}));

import { useFineClock } from "./useFineClock";

afterEach(cleanup);

function Probe() {
	const { nowMs, clockPaused, tzOffset } = useFineClock();
	return (
		<div
			data-testid="probe"
			data-now={nowMs}
			data-paused={clockPaused}
			data-tz={tzOffset}
		/>
	);
}

describe("useFineClock", () => {
	afterEach(() => {
		clockState.localDate = new Date("2001-09-11T08:40:00.000Z");
		clockState.paused = false;
		clockState.tzOffset = -4;
	});

	it("strips the display tz offset off the ticking localDate (virtualUtcMs)", () => {
		// localDate is a DISPLAY value already shifted by tzOffset -4; the true
		// UTC instant is 4 hours ahead of it.
		render(<Probe />);
		const expected = Date.parse("2001-09-11T12:40:00.000Z");
		expect(Number(screen.getByTestId("probe").dataset.now)).toBe(expected);
	});

	it("derives nowMs fresh as the mocked localDate advances", () => {
		const { rerender } = render(<Probe />);
		const before = Number(screen.getByTestId("probe").dataset.now);

		clockState.localDate = new Date("2001-09-11T08:41:30.000Z");
		rerender(<Probe />);

		const after = Number(screen.getByTestId("probe").dataset.now);
		expect(after).toBe(before + 90_000);
	});

	it("passes clockPaused through and coerces tzOffset to a number", () => {
		clockState.paused = true;
		clockState.tzOffset = "-4";
		render(<Probe />);
		const probe = screen.getByTestId("probe");
		expect(probe.dataset.paused).toBe("true");
		expect(probe.dataset.tz).toBe("-4");
	});

	it("getNowMs() reflects the current value and stays referentially stable", () => {
		let firstGetNowMs: (() => number) | undefined;
		let secondGetNowMs: (() => number) | undefined;

		function IdentityProbe() {
			const { getNowMs } = useFineClock();
			if (!firstGetNowMs) firstGetNowMs = getNowMs;
			else secondGetNowMs = getNowMs;
			return null;
		}

		const { rerender } = render(<IdentityProbe />);
		clockState.localDate = new Date("2001-09-11T08:42:00.000Z");
		rerender(<IdentityProbe />);

		expect(secondGetNowMs).toBe(firstGetNowMs);
		expect(firstGetNowMs?.()).toBe(Date.parse("2001-09-11T12:42:00.000Z"));
	});
});
