import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyperCardPartProps } from "classicy";
import { DirectusPagerPart } from "./DirectusPagerPart";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => body } as unknown as Response;
}

function partProps(options: Record<string, unknown>): HyperCardPartProps {
	return {
		part: { id: "p", type: "directusPager" },
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

describe("DirectusPagerPart", () => {
	it("shows a placeholder with no id", () => {
		render(<DirectusPagerPart {...partProps({})} />);
		expect(screen.getByText("No page selected")).toBeTruthy();
	});

	it("renders the message and metadata row", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: {
					id: 5,
					start_date: "2001-09-11T13:00:00",
					provider: "SkyTel",
					recipient_id: "123456",
					mode: "ALPHA",
					message: "CALL OPS CENTER",
				},
			}),
		);
		render(<DirectusPagerPart {...partProps({ itemId: 5 })} />);
		expect(await screen.findByText("CALL OPS CENTER")).toBeTruthy();
		expect(screen.getByText(/SkyTel/)).toBeTruthy();
		expect(screen.getByText(/123456/)).toBeTruthy();
	});

	it("hides metadata when showMeta is false", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({ data: { id: 5, message: "PAGE", provider: "SkyTel" } }),
		);
		render(<DirectusPagerPart {...partProps({ itemId: 5, showMeta: false })} />);
		await screen.findByText("PAGE");
		expect(screen.queryByText(/SkyTel/)).toBeNull();
	});

	it("shows an error note when the fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, false, 500));
		render(<DirectusPagerPart {...partProps({ itemId: 5 })} />);
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(/Could not load page/)).toBeTruthy();
	});

	// issue #560 — itemId widened from a scalar to an array.
	it("shows a placeholder for an empty itemId array", () => {
		render(<DirectusPagerPart {...partProps({ itemId: [] })} />);
		expect(screen.getByText("No page selected")).toBeTruthy();
	});

	it("renders a stack of readouts when itemId holds more than one id", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
			const isFive = String(url).includes("/5?");
			return Promise.resolve(
				jsonResponse({ data: { id: isFive ? 5 : 6, message: isFive ? "PAGE FIVE" : "PAGE SIX" } }),
			);
		});
		render(<DirectusPagerPart {...partProps({ itemId: [5, 6] })} />);
		expect(await screen.findByText("PAGE FIVE")).toBeTruthy();
		expect(screen.getByText("PAGE SIX")).toBeTruthy();
	});
});
