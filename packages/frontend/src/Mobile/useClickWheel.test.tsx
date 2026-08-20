import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClickWheel, type ClickWheelHandlers } from "./useClickWheel";

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
