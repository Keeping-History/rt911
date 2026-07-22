import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlightLayersPanel } from "./FlightLayersPanel";
import type { MapPoi } from "./mapPois";

afterEach(cleanup);

const poi = (id: number, layer: string): MapPoi => ({
	id, name: `P${id}`, layer, category: "airport", detailTitle: null,
	lat: 0, lon: 0, iata: null, icao: null, city: null, region: null, details: null,
});
const POIS = [poi(1, "Major Airports"), poi(2, "Air Bases")];

describe("FlightLayersPanel", () => {
	it("lists the master toggle and each distinct layer", () => {
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: [] }} onChange={() => {}} />);
		expect(screen.getByText("Show POI layers")).toBeTruthy();
		expect(screen.getByText("Major Airports")).toBeTruthy();
		expect(screen.getByText("Air Bases")).toBeTruthy();
	});

	it("toggling a layer off adds it to disabledLayers", () => {
		const onChange = vi.fn();
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: [] }} onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("Air Bases"));
		expect(onChange).toHaveBeenCalledWith({ enabled: true, disabledLayers: ["Air Bases"], unclusteredLayers: [] });
	});

	it("toggling a disabled layer back on removes it", () => {
		const onChange = vi.fn();
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: ["Air Bases"], unclusteredLayers: [] }} onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("Air Bases"));
		expect(onChange).toHaveBeenCalledWith({ enabled: true, disabledLayers: [], unclusteredLayers: [] });
	});

	it("master toggle flips enabled", () => {
		const onChange = vi.fn();
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: [] }} onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("Show POI layers"));
		expect(onChange).toHaveBeenCalledWith({ enabled: false, disabledLayers: [], unclusteredLayers: [] });
	});

	it("renders a Cluster checkbox per layer, checked when the layer is not in unclusteredLayers", () => {
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: ["Air Bases"] }} onChange={() => {}} />);
		expect((screen.getByLabelText("Cluster Major Airports") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByLabelText("Cluster Air Bases") as HTMLInputElement).checked).toBe(false);
	});

	it("toggling Cluster off adds the layer to unclusteredLayers", () => {
		const onChange = vi.fn();
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: [] }} onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("Cluster Major Airports"));
		expect(onChange).toHaveBeenCalledWith({ enabled: true, disabledLayers: [], unclusteredLayers: ["Major Airports"] });
	});

	it("toggling Cluster back on removes it", () => {
		const onChange = vi.fn();
		render(<FlightLayersPanel pois={POIS} settings={{ enabled: true, disabledLayers: [], unclusteredLayers: ["Major Airports"] }} onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("Cluster Major Airports"));
		expect(onChange).toHaveBeenCalledWith({ enabled: true, disabledLayers: [], unclusteredLayers: [] });
	});
});
