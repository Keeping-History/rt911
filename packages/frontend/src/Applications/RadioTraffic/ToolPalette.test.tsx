import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

import { TOOL_LABELS, TOOLS } from "./toolMode";
import { ToolPalette } from "./ToolPalette";

const labels = TOOLS.map((tool) => TOOL_LABELS[tool]);

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

	it("carries a placeholder glyph per tool, swappable in one place", () => {
		// Robbie replaces the artwork; the test pins that each tool HAS its own
		// distinct glyph, not what that glyph looks like.
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={() => {}} />);
		const glyphs = TOOLS.map(
			(tool) => getByRole("radio", { name: TOOL_LABELS[tool] }).textContent,
		);
		expect(glyphs.every((g) => g !== null && g.length > 0)).toBe(true);
		expect(new Set(glyphs).size).toBe(TOOLS.length);
	});

	it("groups the tools so a screen reader reads them as one choice", () => {
		const { getByRole } = render(<ToolPalette tool="arrow" onSelect={() => {}} />);
		expect(getByRole("radiogroup", { name: "Tools" })).not.toBeNull();
	});
});
