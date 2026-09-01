import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HOLD_DELAY_MS,
	HOLD_REPEAT_MS,
	useClickWheel,
	type ClickWheelHandlers,
} from "./useClickWheel";

afterEach(cleanup);

function Harness({ handlers }: { handlers: ClickWheelHandlers }) {
	const { wheelRef, wheelHandlers, buttonDown, pressed } = useClickWheel(handlers);
	return (
		<div
			data-testid="wheel"
			data-pressed={pressed ?? ""}
			ref={wheelRef as React.RefObject<HTMLDivElement>}
			{...wheelHandlers}
		>
			<button type="button" data-testid="menu-btn" onPointerDown={buttonDown("menu")} />
			<button type="button" data-testid="mid-btn" onPointerDown={buttonDown("select")} />
			<button type="button" data-testid="prev-btn" onPointerDown={buttonDown("prev")} />
			<button type="button" data-testid="next-btn" onPointerDown={buttonDown("next")} />
		</div>
	);
}

const makeHandlers = (): ClickWheelHandlers => ({
	onScroll: vi.fn(),
	onSelect: vi.fn(),
	onMenu: vi.fn(),
	onPrev: vi.fn(),
	onNext: vi.fn(),
	onPlayPause: vi.fn(),
});

// Center the wheel at (100, 100) with a 200×200 rect; jsdom's default rect is
// all zeros, so the hook's angle math needs a real geometry to chew on.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 200,
		width: 200, height: 200,
		toJSON: () => ({}),
	} as DOMRect);
});

// Points on a circle around (100,100): angle 0° = (200,100), 90° = (100,200).
const at = (deg: number) => ({
	clientX: 100 + 100 * Math.cos((deg * Math.PI) / 180),
	clientY: 100 + 100 * Math.sin((deg * Math.PI) / 180),
});

describe("useClickWheel", () => {
	it("fires onScroll once per 25° of drag", () => {
		const handlers = makeHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		fireEvent.pointerDown(wheel, { pointerId: 1, ...at(0) });
		fireEvent.pointerMove(wheel, { pointerId: 1, ...at(30) });
		expect(handlers.onScroll).toHaveBeenCalledWith(1);
	});

	it("a tap on a button fires its action; a drag does not", () => {
		const handlers = makeHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		const menu = screen.getByTestId("menu-btn");

		// Tap: down on button (bubbles to wheel), up without movement.
		fireEvent.pointerDown(menu, { pointerId: 1, ...at(90) });
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(90) });
		expect(handlers.onMenu).toHaveBeenCalledTimes(1);

		// Drag starting on the button: movement crosses the dead zone → no action.
		fireEvent.pointerDown(menu, { pointerId: 2, ...at(90) });
		fireEvent.pointerMove(wheel, { pointerId: 2, ...at(120) });
		fireEvent.pointerUp(wheel, { pointerId: 2, ...at(120) });
		expect(handlers.onMenu).toHaveBeenCalledTimes(1); // unchanged
		expect(handlers.onScroll).toHaveBeenCalled();
	});

	it("exposes the pressed button for styling and clears it on release", () => {
		const handlers = makeHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		const mid = screen.getByTestId("mid-btn");
		fireEvent.pointerDown(mid, { pointerId: 1, ...at(0) });
		expect(wheel.dataset.pressed).toBe("select");
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(0) });
		expect(wheel.dataset.pressed).toBe("");
		expect(handlers.onSelect).toHaveBeenCalledTimes(1);
	});
});

// Holding ⏮/⏭ past HOLD_DELAY_MS repeats the hold handler instead of firing
// the tap on release — the shell maps tap to a 30s clock skip and hold ticks
// to an accelerating skip driven by heldMs (holdSeekRamp.ts).
describe("useClickWheel hold-repeat", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const holdHandlers = () => ({
		...makeHandlers(),
		onPrevHold: vi.fn(),
		onNextHold: vi.fn(),
	});

	it("fires the hold handler after the delay, repeats, and suppresses the tap", () => {
		vi.useFakeTimers();
		const handlers = holdHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		fireEvent.pointerDown(screen.getByTestId("prev-btn"), { pointerId: 1, ...at(180) });
		vi.advanceTimersByTime(HOLD_DELAY_MS);
		expect(handlers.onPrevHold).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(HOLD_REPEAT_MS * 2);
		expect(handlers.onPrevHold).toHaveBeenCalledTimes(3);
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(180) });
		expect(handlers.onPrev).not.toHaveBeenCalled(); // the hold consumed the gesture
		vi.advanceTimersByTime(HOLD_REPEAT_MS * 3);
		expect(handlers.onPrevHold).toHaveBeenCalledTimes(3); // stopped on release
	});

	it("reports how long the hold has been running so handlers can accelerate", () => {
		vi.useFakeTimers(); // fake timers also drive Date.now, so heldMs is exact
		const handlers = holdHandlers();
		render(<Harness handlers={handlers} />);
		fireEvent.pointerDown(screen.getByTestId("next-btn"), { pointerId: 1, ...at(0) });
		vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_REPEAT_MS * 2);
		expect(handlers.onNextHold.mock.calls.map((c) => c[0])).toEqual([
			0,
			HOLD_REPEAT_MS,
			HOLD_REPEAT_MS * 2,
		]);
	});

	it("a quick tap still fires the tap handler and never the hold", () => {
		vi.useFakeTimers();
		const handlers = holdHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		fireEvent.pointerDown(screen.getByTestId("next-btn"), { pointerId: 1, ...at(0) });
		vi.advanceTimersByTime(100);
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(0) });
		expect(handlers.onNext).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_REPEAT_MS * 3);
		expect(handlers.onNextHold).not.toHaveBeenCalled();
	});

	it("a drag that becomes a scroll cancels the pending hold", () => {
		vi.useFakeTimers();
		const handlers = holdHandlers();
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		fireEvent.pointerDown(screen.getByTestId("prev-btn"), { pointerId: 1, ...at(90) });
		fireEvent.pointerMove(wheel, { pointerId: 1, ...at(120) }); // crosses the dead zone
		vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_REPEAT_MS * 2);
		expect(handlers.onPrevHold).not.toHaveBeenCalled();
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(120) });
		expect(handlers.onPrev).not.toHaveBeenCalled(); // scrolls never tap either
	});

	it("without a hold handler, a long press stays an ordinary tap", () => {
		vi.useFakeTimers();
		const handlers = makeHandlers(); // no onPrevHold/onNextHold registered
		render(<Harness handlers={handlers} />);
		const wheel = screen.getByTestId("wheel");
		fireEvent.pointerDown(screen.getByTestId("prev-btn"), { pointerId: 1, ...at(180) });
		vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_REPEAT_MS * 4);
		fireEvent.pointerUp(wheel, { pointerId: 1, ...at(180) });
		expect(handlers.onPrev).toHaveBeenCalledTimes(1);
	});
});
