import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinpointById } from "./mapPinpoints";
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
	cameraMode: "track",
	cameraFollow: false,
	canFollow: false,
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
	onClearFilter: vi.fn(),
	onSetCameraMode: vi.fn(),
	onToggleCameraFollow: vi.fn(),
});

// classicy's ClassicyPopUpMenu renders as a <button id=…> whose label isn't
// htmlFor-associated, plus a listbox that only mounts while open. Menus are
// told apart by their element ids: read the shown value from the button's
// label span; pick an option by opening the button and clicking its label.
const popupButton = (id: string): HTMLButtonElement => {
	const el = document.getElementById(id);
	if (!(el instanceof HTMLButtonElement)) throw new Error(`no popup #${id}`);
	return el;
};
const popupValue = (id: string): string =>
	popupButton(id).querySelector(".classicyPopUpMenuValue")?.textContent ?? "";
const pickOption = (id: string, label: string) => {
	fireEvent.click(popupButton(id));
	fireEvent.click(within(screen.getByRole("listbox")).getByText(label));
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
		// The button shows the placeholder until (and after) a pick — no value sticks.
		expect(popupValue("flight_map_pinpoints")).toBe("Choose…");
		const pentagon = pinpointById("pentagon")!;
		pickOption("flight_map_pinpoints", pentagon.label);
		// Assert against the data table, not a hardcoded copy — zoom tuning is a
		// product decision this test must follow, not police.
		expect(p.onPinpoint).toHaveBeenCalledWith(pentagon.center, pentagon.zoom);
		// Remounted onto the placeholder — the picked value never sticks.
		expect(popupValue("flight_map_pinpoints")).toBe("Choose…");
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
		expect(popupValue("flight_map_style")).toBe("Satellite");
		pickOption("flight_map_style", "Radar");
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

	it("Clear Filter is disabled with no filter, enabled + fires when a filter is applied (#310)", () => {
		const p = baseProps();
		const { rerender } = render(<MapControls {...p} filterOn={false} />);
		const clear = screen.getByRole("button", { name: "Clear filter" }) as HTMLButtonElement;
		expect(clear.disabled).toBe(true);
		fireEvent.click(clear);
		expect(p.onClearFilter).not.toHaveBeenCalled();
		rerender(<MapControls {...p} filterOn={true} />);
		expect(clear.disabled).toBe(false);
		fireEvent.click(clear);
		expect(p.onClearFilter).toHaveBeenCalledOnce();
	});

	it("follow toggle is disabled until a tracked flight is selectable, then arms", () => {
		const p = baseProps();
		const { rerender } = render(<MapControls {...p} canFollow={false} />);
		const follow = screen.getByRole("checkbox") as HTMLInputElement; // the follow toggle (only checkbox here)
		// Disabled (and unchecked) until a tracked flight is selectable. The
		// disabled input can't be toggled by a real user, so the attribute is the
		// guarantee here (jsdom's synthetic click would bypass it).
		expect(follow.disabled).toBe(true);
		expect(follow.checked).toBe(false);
		// A tracked flight is selected: the checkbox arms.
		rerender(<MapControls {...p} canFollow={true} />);
		expect(follow.disabled).toBe(false);
		fireEvent.click(follow);
		expect(p.onToggleCameraFollow).toHaveBeenCalledOnce();
	});

	it("camera mode dropdown shows the current mode and fires onSetCameraMode", () => {
		const p = baseProps();
		render(<MapControls {...p} cameraMode="cockpit" />);
		expect(popupValue("flight_camera_mode")).toBe("Cockpit");
		expect(popupButton("flight_camera_mode").disabled).toBe(false); // preference stays editable
		pickOption("flight_camera_mode", "Highlight");
		expect(p.onSetCameraMode).toHaveBeenCalledWith("highlight");
	});

	it("locks out zoom, marquee, and pinpoints while following (depressed toggle)", () => {
		const p = baseProps();
		render(<MapControls {...p} canFollow={true} cameraFollow={true} />);
		const follow = screen.getByRole("checkbox") as HTMLInputElement; // the follow toggle (only checkbox here)
		expect(follow.checked).toBe(true); // checked = following
		for (const name of ["Zoom in", "Zoom out", "Select rectangle", "Select circle"]) {
			expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
		}
		expect(popupButton("flight_map_pinpoints").disabled).toBe(true);
		// The follow checkbox itself stays live so you can turn it off.
		expect(follow.disabled).toBe(false);
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
