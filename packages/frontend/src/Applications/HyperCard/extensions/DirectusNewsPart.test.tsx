import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperCardPartProps } from "classicy";

const dispatchMock = vi.hoisted(() => vi.fn());
const balloonHandlers = vi.hoisted(() => ({ onMouseEnter: vi.fn(), onMouseLeave: vi.fn() }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useAppManagerDispatch: () => dispatchMock,
	useClassicyBalloonHelp: () => ({
		handlers: balloonHandlers,
		balloon: <div data-testid="balloon-portal" />,
	}),
}));

import { DirectusNewsPart } from "./DirectusNewsPart";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	dispatchMock.mockClear();
	balloonHandlers.onMouseEnter.mockClear();
	balloonHandlers.onMouseLeave.mockClear();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as unknown as Response;
}

function partProps(options: Record<string, unknown>): HyperCardPartProps {
	return {
		part: { id: "p", type: "directusNews" },
		partId: "p",
		stackId: "s",
		options,
		locked: false,
		value: "",
		setValue: vi.fn(),
		fire: vi.fn(),
		getVariable: vi.fn(),
		resolve: (e: string) => e,
	} as unknown as HyperCardPartProps;
}

describe("DirectusNewsPart", () => {
	it("shows a placeholder with no id", () => {
		render(<DirectusNewsPart {...partProps({})} />);
		expect(screen.getByText("No article selected")).toBeTruthy();
	});

	it("renders the headline, dateline, image and HTML body", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: {
					id: 9,
					title: "Short",
					full_title: "A Fuller Headline",
					start_date: "2001-09-11T12:46:00",
					image: "https://x/hero.jpg",
					image_caption: "the caption",
					content: "<p>Body <strong>text</strong>.</p>",
				},
			}),
		);
		render(<DirectusNewsPart {...partProps({ itemId: 9 })} />);
		expect(await screen.findByText("A Fuller Headline")).toBeTruthy();
		expect(screen.getByText(/Body/)).toBeTruthy();
		expect((screen.getByAltText("the caption") as HTMLImageElement).getAttribute("src")).toBe(
			"https://x/hero.jpg",
		);
		expect(screen.getByText(/September/)).toBeTruthy();
	});

	it("hides the image when showImage is false", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ data: { id: 9, title: "T", image: "https://x/hero.jpg", content: "<p>b</p>" } }),
		);
		render(<DirectusNewsPart {...partProps({ itemId: 9, showImage: false })} />);
		await screen.findByText("T");
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("shows an error note when the fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, false, 404));
		render(<DirectusNewsPart {...partProps({ itemId: 9 })} />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Could not load article/)).toBeTruthy();
	});

	// issue #560 — itemId widened from a scalar to an array.
	it("shows a placeholder for an empty itemId array", () => {
		render(<DirectusNewsPart {...partProps({ itemId: [] })} />);
		expect(screen.getByText("No article selected")).toBeTruthy();
	});

	it("clicking an internal cross-reference link opens the News app and focuses that article", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { id: 9, title: "T", content: '<p>See <a href="#/news-item/55">also</a>.</p>' },
			}),
		);
		render(<DirectusNewsPart {...partProps({ itemId: 9 })} />);
		await screen.findByText("T");

		fireEvent.click(screen.getByText("also"));

		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ClassicyAppOpen" }),
		);
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "ClassicyAppNewsFocusItem", docId: 55 }),
		);
	});

	it("clicking an external link opens it in a new window instead of navigating in place", async () => {
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: {
					id: 9,
					title: "T",
					content:
						'<p>Per <a href="https://web.archive.org/web/2015/http://historycommons.org/x">History Commons</a>.</p>',
				},
			}),
		);
		render(<DirectusNewsPart {...partProps({ itemId: 9 })} />);
		await screen.findByText("T");

		fireEvent.click(screen.getByText("History Commons"));

		expect(openSpy).toHaveBeenCalledWith(
			"https://web.archive.org/web/2015/http://historycommons.org/x",
			"_blank",
			"noopener,noreferrer",
		);
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it("hovering a link with a data-balloon-title shows the balloon", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: {
					id: 9,
					title: "T",
					content: '<p>See <a href="#/news-item/55" data-balloon-title="Target Headline">also</a>.</p>',
				},
			}),
		);
		render(<DirectusNewsPart {...partProps({ itemId: 9 })} />);
		await screen.findByText("T");

		fireEvent.mouseOver(screen.getByText("also"));

		expect(balloonHandlers.onMouseEnter).toHaveBeenCalled();
		expect(screen.getByTestId("balloon-portal")).toBeTruthy();
	});

	it("renders a list of articles when itemId holds more than one id", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
			const isNine = String(url).includes("/9?");
			return Promise.resolve(
				jsonResponse({ data: { id: isNine ? 9 : 10, title: isNine ? "Nine" : "Ten" } }),
			);
		});
		render(<DirectusNewsPart {...partProps({ itemId: [9, 10] })} />);
		expect(await screen.findByText("Nine")).toBeTruthy();
		expect(screen.getByText("Ten")).toBeTruthy();
	});
});
