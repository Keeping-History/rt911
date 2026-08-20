import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperCardPartProps } from "classicy";
import { DirectusNewsPart } from "./DirectusNewsPart";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
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
});
