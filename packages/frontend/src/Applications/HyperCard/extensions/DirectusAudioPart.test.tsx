import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperCardPartProps } from "classicy";
import { DirectusAudioPart } from "./DirectusAudioPart";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// Build the part props with sensible defaults; each test overrides what it needs.
function props(overrides: Partial<HyperCardPartProps> = {}): HyperCardPartProps {
	return {
		part: { id: "clip", type: "directusAudio" },
		partId: "clip",
		stackId: "stack-1",
		options: {},
		locked: false,
		value: "",
		setValue: vi.fn(),
		fire: vi.fn(),
		getVariable: vi.fn(),
		resolve: (expr: string) => expr,
		...overrides,
	} as HyperCardPartProps;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as unknown as Response;
}

describe("DirectusAudioPart", () => {
	it("renders 'No audio source' with no url or itemId", () => {
		render(<DirectusAudioPart {...props()} />);
		expect(screen.getByText("No audio source")).toBeTruthy();
	});

	it("plays a direct url with no fetch", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		render(
			<DirectusAudioPart
				{...props({ options: { url: "https://x/a.mp3", title: "Direct Clip" } })}
			/>,
		);
		const audio = screen.getByLabelText("Audio: Direct Clip") as HTMLAudioElement;
		expect(audio.getAttribute("src")).toBe("https://x/a.mp3");
		expect(screen.getByText("Direct Clip")).toBeTruthy();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fetches an item by id and renders its url and title", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ data: { id: 42, title: "t", full_title: "Full Title", url: "https://x/42.mp3" } }),
		);
		render(<DirectusAudioPart {...props({ options: { itemId: 42 } })} />);

		const audio = (await screen.findByLabelText("Audio: Full Title")) as HTMLAudioElement;
		expect(audio.getAttribute("src")).toBe("https://x/42.mp3");
		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain("/items/mp3_items/42?fields=");
	});

	it("resolves itemId through the expression engine before fetching", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ data: { id: 5, title: "Five", url: "https://x/5.mp3" } }),
		);
		// resolve maps the variable name "clip" to the id "5".
		render(
			<DirectusAudioPart
				{...props({
					options: { itemId: "clip" },
					resolve: (expr) => (expr === "clip" ? "5" : expr),
				})}
			/>,
		);
		await screen.findByLabelText("Audio: Five");
		expect(fetchSpy.mock.calls[0][0]).toContain("/items/mp3_items/5?fields=");
	});

	it("shows an error note when the fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, false, 500));
		render(<DirectusAudioPart {...props({ options: { itemId: 1 } })} />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Could not load audio/)).toBeTruthy();
	});

	it("hides the native transport when locked", () => {
		render(
			<DirectusAudioPart
				{...props({ locked: true, options: { url: "https://x/a.mp3", title: "Locked" } })}
			/>,
		);
		const audio = screen.getByLabelText("Audio: Locked") as HTMLAudioElement;
		expect(audio.hasAttribute("controls")).toBe(false);
	});
});
