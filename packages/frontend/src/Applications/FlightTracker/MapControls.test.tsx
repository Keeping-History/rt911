import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapControls, type MapControlsProps } from "./MapControls";

afterEach(cleanup);

const baseProps = (): MapControlsProps => ({
	globe: false,
	threeD: false,
	cluster: false,
	selectMode: "off",
	onZoomIn: vi.fn(),
	onZoomOut: vi.fn(),
	onToggleGlobe: vi.fn(),
	onToggleThreeD: vi.fn(),
	onToggleCluster: vi.fn(),
	onSetSelectMode: vi.fn(),
	onPinpoint: vi.fn(),
});

describe("MapControls", () => {
	it("fires zoom callbacks", () => {
		const p = baseProps();
		render(<MapControls {...p} />);
		fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
		fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
		expect(p.onZoomIn).toHaveBeenCalledOnce();
		expect(p.onZoomOut).toHaveBeenCalledOnce();
	});

	it("reflects and toggles the globe/3D/cluster states", () => {
		const p = baseProps();
		render(<MapControls {...p} globe={true} />);
		// ClassicyButton's depressed prop drives aria-pressed: "true" when held
		// down, attribute absent when not (the library's own convention).
		const globe = screen.getByRole("button", { name: "Globe" });
		expect(globe.getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "3D" }).getAttribute("aria-pressed")).toBeNull();
		fireEvent.click(globe);
		fireEvent.click(screen.getByRole("button", { name: "3D" }));
		fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
		expect(p.onToggleGlobe).toHaveBeenCalledOnce();
		expect(p.onToggleThreeD).toHaveBeenCalledOnce();
		expect(p.onToggleCluster).toHaveBeenCalledOnce();
	});

	it("pinpoints dropdown flies to the chosen place then snaps back to Choose…", () => {
		const p = baseProps();
		render(<MapControls {...p} />);
		const dd = screen.getByRole("combobox") as HTMLSelectElement;
		const placeholder = screen.getByText("Choose…") as HTMLOptionElement;
		expect(placeholder.disabled).toBe(true);
		expect(dd.value).toBe(placeholder.value);
		fireEvent.change(dd, { target: { value: "pentagon" } });
		expect(p.onPinpoint).toHaveBeenCalledWith([-77.0563, 38.8719], 13.5);
		// Remounted onto the placeholder — the picked value never sticks.
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(placeholder.value);
	});

	it("select tools are mutually exclusive toggles: active tool re-click turns off", () => {
		const p = baseProps();
		render(<MapControls {...p} selectMode="rect" />);
		expect(
			screen.getByRole("button", { name: "Select rectangle" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen.getByRole("button", { name: "Select circle" }).getAttribute("aria-pressed"),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Select rectangle" }));
		expect(p.onSetSelectMode).toHaveBeenCalledWith("off");
		fireEvent.click(screen.getByRole("button", { name: "Select circle" }));
		expect(p.onSetSelectMode).toHaveBeenCalledWith("circle");
	});
});
