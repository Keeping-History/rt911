import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapControls, type MapControlsProps } from "./MapControls";

afterEach(cleanup);

const baseProps = (): MapControlsProps => ({
	globe: false,
	threeD: false,
	terrain: false,
	cluster: false,
	selectMode: "off",
	mapStyle: "classic",
	darkMap: false,
	filterOn: false,
	onZoomIn: vi.fn(),
	onZoomOut: vi.fn(),
	onToggleGlobe: vi.fn(),
	onToggleThreeD: vi.fn(),
	onToggleTerrain: vi.fn(),
	onToggleCluster: vi.fn(),
	onSetSelectMode: vi.fn(),
	onPinpoint: vi.fn(),
	onSetMapStyle: vi.fn(),
	onToggleDarkMap: vi.fn(),
	onOpenFilter: vi.fn(),
});

// ClassicyPopUpMenu's label isn't wired to the select for a11y-name queries,
// so the two menus (pinpoints, style) are told apart by their element ids.
const selectById = (id: string): HTMLSelectElement => {
	const el = document.getElementById(id);
	if (!(el instanceof HTMLSelectElement)) throw new Error(`no select #${id}`);
	return el;
};

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

	it("reflects and toggles the terrain state", () => {
		const p = baseProps();
		render(<MapControls {...p} terrain={true} />);
		const terrain = screen.getByRole("button", { name: "Terrain" });
		expect(terrain.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(terrain);
		expect(p.onToggleTerrain).toHaveBeenCalledOnce();
	});

	it("pinpoints dropdown flies to the chosen place then snaps back to Choose…", () => {
		const p = baseProps();
		render(<MapControls {...p} />);
		const dd = selectById("flight_map_pinpoints");
		const placeholder = screen.getByText("Choose…") as HTMLOptionElement;
		expect(placeholder.disabled).toBe(true);
		expect(dd.value).toBe(placeholder.value);
		fireEvent.change(dd, { target: { value: "pentagon" } });
		expect(p.onPinpoint).toHaveBeenCalledWith([-77.0563, 38.8719], 10.5);
		// Remounted onto the placeholder — the picked value never sticks.
		expect(selectById("flight_map_pinpoints").value).toBe(placeholder.value);
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

	it("style dropdown shows the current style and fires onSetMapStyle", () => {
		const p = baseProps();
		render(<MapControls {...p} mapStyle="satellite" />);
		const dd = selectById("flight_map_style");
		expect(dd.value).toBe("satellite");
		fireEvent.change(dd, { target: { value: "radar" } });
		expect(p.onSetMapStyle).toHaveBeenCalledWith("radar");
	});

	it("dark toggle reflects darkMap and fires onToggleDarkMap", () => {
		const p = baseProps();
		render(<MapControls {...p} darkMap={true} />);
		const dark = screen.getByRole("button", { name: "Dark map" }) as HTMLButtonElement;
		expect(dark.getAttribute("aria-pressed")).toBe("true");
		expect(dark.disabled).toBe(false);
		fireEvent.click(dark);
		expect(p.onToggleDarkMap).toHaveBeenCalledOnce();
	});

	it("filter button opens the filter window and reflects an active filter", () => {
		const p = baseProps();
		const { rerender } = render(<MapControls {...p} />);
		const filter = screen.getByRole("button", { name: "Filter flights" });
		expect(filter.textContent).toBe("Filter…");
		expect(filter.getAttribute("aria-pressed")).toBeNull();
		fireEvent.click(filter);
		expect(p.onOpenFilter).toHaveBeenCalledOnce();
		rerender(<MapControls {...p} filterOn={true} />);
		expect(filter.textContent).toBe("Filter (on)…");
		expect(filter.getAttribute("aria-pressed")).toBe("true");
	});

	it("radar scope disables the dark toggle and shows it unpressed, keeping darkMap", () => {
		const p = baseProps();
		// darkMap stays true in state — radar only ignores it (effectiveTone),
		// so the button must read disabled AND unpressed without clearing the flag.
		render(<MapControls {...p} mapStyle="radar" darkMap={true} />);
		const dark = screen.getByRole("button", { name: "Dark map" }) as HTMLButtonElement;
		expect(dark.disabled).toBe(true);
		expect(dark.getAttribute("aria-pressed")).toBeNull();
		fireEvent.click(dark);
		expect(p.onToggleDarkMap).not.toHaveBeenCalled();
	});
});
