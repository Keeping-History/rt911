// packages/frontend/src/Mobile/screens/ColorScreen.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorScreen } from "./ColorScreen";

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe("ColorScreen", () => {
	it("lists the five iPod mini finishes with a checkmark on the current one", () => {
		render(<ColorScreen color="blue" onColorChange={vi.fn()} />);
		for (const label of ["Silver", "Gold", "Blue", "Pink", "Green"]) {
			expect(screen.getByText(label)).toBeTruthy();
		}
		const checked = screen.getByText("✓").closest("li");
		expect(checked?.textContent).toContain("Blue");
	});

	it("tapping a color reports it and stays on the screen", () => {
		const onColorChange = vi.fn();
		render(<ColorScreen color="silver" onColorChange={onColorChange} />);
		fireEvent.click(screen.getByText("Pink"));
		expect(onColorChange).toHaveBeenCalledWith("pink");
		// Still mounted — the checkmark move (via the parent re-render) is the feedback.
		expect(screen.getByText("Green")).toBeTruthy();
	});

	it("starts with the wheel highlight on the current color", () => {
		render(<ColorScreen color="green" onColorChange={vi.fn()} />);
		expect(screen.getByText("Green").closest("li")?.className).toContain("selected");
	});
});
