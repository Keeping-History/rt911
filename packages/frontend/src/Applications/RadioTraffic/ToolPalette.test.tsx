import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

import { TOOL_BALLOONS, TOOL_LABELS, TOOLS } from "./toolMode";
import { ToolPalette } from "./ToolPalette";

const labels = TOOLS.map((tool) => TOOL_LABELS[tool]);

// ClassicyBalloonHelp's anchor wrapper, by its (public, styled) class name.
const ANCHOR = ".classicyBalloonHelpAnchor";

describe("ToolPalette", () => {
	it("offers all four tools", () => {
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={() => {}} />);
		for (const label of labels) expect(getByRole("radio", { name: label })).not.toBeNull();
	});

	it("marks exactly one tool active at a time", () => {
		for (const active of TOOLS) {
			cleanup();
			const { getAllByRole } = render(<ToolPalette tool={active} onSelect={() => {}} />);
			const pressed = getAllByRole("radio").filter(
				(b) => b.getAttribute("aria-checked") === "true",
			);
			expect(pressed).toHaveLength(1);
			expect(pressed[0].getAttribute("aria-label")).toBe(TOOL_LABELS[active]);
		}
	});

	it("reports the tool the listener picked", () => {
		const onSelect = vi.fn();
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={onSelect} />);
		fireEvent.click(getByRole("radio", { name: TOOL_LABELS.mute }));
		expect(onSelect).toHaveBeenCalledWith("mute");
	});

	it("still reports a click on the already-active tool", () => {
		// The palette is a controlled radio group, not a toggle: it reports every
		// pick and the owner decides. Swallowing the active one here would make
		// that seam conditional for no reason.
		const onSelect = vi.fn();
		const { getByRole } = render(<ToolPalette tool="hand" onSelect={onSelect} />);
		fireEvent.click(getByRole("radio", { name: TOOL_LABELS.hand }));
		expect(onSelect).toHaveBeenCalledWith("hand");
	});

	it("carries its own icon per tool", () => {
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={() => {}} />);
		const icons = TOOLS.map(
			(tool) => getByRole("radio", { name: TOOL_LABELS[tool] }).querySelector("img")?.src,
		);
		expect(icons.every((src) => !!src)).toBe(true);
		expect(new Set(icons).size).toBe(TOOLS.length);
	});

	it("groups the tools so a screen reader reads them as one choice", () => {
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={() => {}} />);
		expect(getByRole("radiogroup", { name: "Tools" })).not.toBeNull();
	});

	describe("balloon help", () => {
		it("gives every tool its own balloon anchor", () => {
			render(<ToolPalette tool="arrow" onSelect={() => {}} />);
			// ClassicyBalloonHelp wraps its child in a `.classicyBalloonHelpAnchor`
			// <div> — one per tool, and no button left without one, which is the
			// whole of the requirement. (Since classicy 2.0.9 the anchor carries no
			// role; `role="tooltip"` belongs to the balloon, and only while shown.)
			expect(document.querySelectorAll(ANCHOR)).toHaveLength(TOOLS.length);
			expect(screen.queryByRole("tooltip")).toBeNull();
			for (const tool of TOOLS) {
				const button = document.querySelector(
					`[aria-label="${TOOL_LABELS[tool]}"]`,
				) as HTMLElement | null;
				expect(button?.closest(ANCHOR)).not.toBeNull();
			}
		});

		it("shows each tool's own copy on hover", () => {
			// The glyphs are placeholders, so the balloon is the only thing that
			// says what a tool does; a shared or empty string would leave the modal
			// palette exactly as unreadable as it was.
			vi.useFakeTimers();
			try {
				for (const tool of TOOLS) {
					cleanup();
					render(<ToolPalette tool="arrow" onSelect={() => {}} />);
					const anchor = document
						.querySelector(`[aria-label="${TOOL_LABELS[tool]}"]`)
						?.closest(ANCHOR) as HTMLElement;
					fireEvent.mouseEnter(anchor);
					act(() => {
						vi.advanceTimersByTime(600);
					});
					expect(screen.getByText(TOOL_BALLOONS[tool])).toBeTruthy();
					// The shown balloon is the tooltip, and it describes the anchor.
					const tooltip = screen.getByRole("tooltip");
					expect(tooltip.textContent).toContain(TOOL_BALLOONS[tool]);
					expect(anchor.getAttribute("aria-describedby")).toBe(tooltip.id);
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it("says something different about every tool", () => {
			// Four tools that all claim the same thing would pass the test above
			// and still tell the listener nothing.
			expect(new Set(Object.values(TOOL_BALLOONS)).size).toBe(TOOLS.length);
			expect(Object.values(TOOL_BALLOONS).every((t) => t.length > 0)).toBe(true);
		});
	});
});
