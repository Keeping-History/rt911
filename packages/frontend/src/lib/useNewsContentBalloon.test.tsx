import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const balloonHelpMock = vi.hoisted(() => vi.fn());
vi.mock("classicy", () => ({
	useClassicyBalloonHelp: (...args: unknown[]) => balloonHelpMock(...args),
}));

import { useNewsContentBalloon } from "./useNewsContentBalloon";

function Host() {
	const { containerHandlers, balloon } = useNewsContentBalloon();
	return (
		<div>
			<div data-testid="container" {...containerHandlers}>
				<a data-testid="internal" href="#/news-item/9" data-balloon-title="Target Title">
					link
				</a>
				<span data-testid="plain">plain text</span>
				<a data-testid="untitled" href="https://x">
					no title
				</a>
			</div>
			{balloon}
		</div>
	);
}

describe("useNewsContentBalloon", () => {
	const onMouseEnter = vi.fn();
	const onMouseLeave = vi.fn();

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	balloonHelpMock.mockImplementation(() => ({
		handlers: { onMouseEnter, onMouseLeave },
		balloon: <div data-testid="balloon-portal" />,
	}));

	function hoverEnter(el: Element, related: Element | null = null) {
		fireEvent.mouseOver(el, { relatedTarget: related });
	}

	function hoverLeave(el: Element, related: Element | null = null) {
		fireEvent.mouseOut(el, { relatedTarget: related });
	}

	it("shows the balloon with the hovered link's title", () => {
		const { getByTestId } = render(<Host />);
		hoverEnter(getByTestId("internal"));

		expect(onMouseEnter).toHaveBeenCalledTimes(1);
		const lastConfig = balloonHelpMock.mock.calls.at(-1)?.[1];
		expect(lastConfig).toMatchObject({ content: "Target Title" });
	});

	it("does not show a balloon for a link with no data-balloon-title", () => {
		const { getByTestId } = render(<Host />);
		hoverEnter(getByTestId("untitled"));
		expect(onMouseEnter).not.toHaveBeenCalled();
	});

	it("does not show a balloon when hovering plain (non-link) content", () => {
		const { getByTestId } = render(<Host />);
		hoverEnter(getByTestId("plain"));
		expect(onMouseEnter).not.toHaveBeenCalled();
	});

	it("hides the balloon when the mouse leaves the link entirely", () => {
		const { getByTestId } = render(<Host />);
		const link = getByTestId("internal");
		hoverEnter(link);
		hoverLeave(link, getByTestId("container"));
		expect(onMouseLeave).toHaveBeenCalledTimes(1);
	});

	it("does not hide the balloon when the mouse moves to a child of the same link", () => {
		const { getByTestId } = render(
			<Host />,
		);
		const link = getByTestId("internal");
		const child = link.firstChild as Element;
		hoverEnter(link);
		hoverLeave(link, child as Element);
		expect(onMouseLeave).not.toHaveBeenCalled();
	});
});
