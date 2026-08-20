// packages/frontend/src/Mobile/IpodChrome.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpodChrome } from "./IpodChrome";
import { useClickWheel, type ClickWheelHandlers } from "./useClickWheel";

afterEach(cleanup);

const handlers: ClickWheelHandlers = {
	onScroll: vi.fn(), onSelect: vi.fn(), onMenu: vi.fn(),
	onPrev: vi.fn(), onNext: vi.fn(), onPlayPause: vi.fn(),
};

function Harness() {
	const wheel = useClickWheel(handlers);
	return (
		<IpodChrome wheel={wheel}>
			<div data-testid="screen-child">hello</div>
		</IpodChrome>
	);
}

describe("IpodChrome", () => {
	it("renders children inside the screen and the wheel buttons", () => {
		const { container } = render(<Harness />);
		expect(screen.getByTestId("screen-child")).toBeTruthy();
		expect(container.querySelector("#control-wheel")).toBeTruthy();
		expect(screen.getByAltText("Menu")).toBeTruthy();
		expect(screen.getByAltText("Play/Pause")).toBeTruthy();
	});

	it("a tap on the MENU button fires onMenu via the wheel pointerup", () => {
		const { container } = render(<Harness />);
		const wheelEl = container.querySelector("#control-wheel") as HTMLElement;
		const menuBtn = container.querySelector("#menu-btn") as HTMLElement;
		fireEvent.pointerDown(menuBtn, { pointerId: 1, clientX: 0, clientY: 0 });
		fireEvent.pointerUp(wheelEl, { pointerId: 1, clientX: 0, clientY: 0 });
		expect(handlers.onMenu).toHaveBeenCalled();
	});
});
