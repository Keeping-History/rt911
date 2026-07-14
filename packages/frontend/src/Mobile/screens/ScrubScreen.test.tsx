// packages/frontend/src/Mobile/screens/ScrubScreen.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenNavContext, WheelContext, type ScreenWheelHandlers } from "../WheelContext";

const { setDateTime } = vi.hoisted(() => ({ setDateTime: vi.fn() }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<object>()),
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		paused: false,
		tzOffset: -4,
		setDateTime,
		pause: vi.fn(),
		resume: vi.fn(),
	}),
}));

import { ScrubScreen } from "./ScrubScreen";

afterEach(cleanup);

const BASE = Date.parse("2001-09-11T12:40:00.000Z");

// Capture what the screen registers so the test can drive the wheel directly.
function renderWithWheel(pop = vi.fn()) {
	let registered: ScreenWheelHandlers = {};
	render(
		<WheelContext.Provider
			value={{ register: (h) => { registered = h; return () => {}; } }}
		>
			<ScreenNavContext.Provider value={{ push: vi.fn(), pop }}>
				<ScrubScreen getNowMs={() => BASE} tzOffset={-4} />
			</ScreenNavContext.Provider>
		</WheelContext.Provider>,
	);
	return { wheel: () => registered, pop };
}

describe("ScrubScreen", () => {
	it("shows the anchored time and moves it one minute per wheel step", () => {
		const { wheel } = renderWithWheel();
		expect(screen.getByText("8:40:00 AM")).toBeTruthy();
		act(() => wheel().onScroll?.(5));
		expect(screen.getByText("8:45:00 AM")).toBeTruthy();
		expect(screen.getByText("+5 min")).toBeTruthy();
		act(() => wheel().onScroll?.(-10));
		expect(screen.getByText("8:35:00 AM")).toBeTruthy();
		expect(screen.getByText("-5 min")).toBeTruthy();
	});

	it("center-click commits the new time and pops back", () => {
		const { wheel, pop } = renderWithWheel();
		act(() => wheel().onScroll?.(5));
		act(() => wheel().onSelect?.());
		expect(setDateTime).toHaveBeenCalledWith(new Date(BASE + 5 * 60_000));
		expect(pop).toHaveBeenCalled();
	});
});
