import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";

// ---- maplibre-gl mock (jsdom has no WebGL) --------------------------------
// Vitest 4 hoists vi.mock factories above all module-scope declarations, so a
// plain `class FakeMap {}` referenced from the factory trips its "no top
// level variables inside a mock factory" guard (TDZ at hoist time). Wrapping
// the class in vi.hoisted() hoists the declaration itself to the same point,
// keeping the class (and FakeMap.last) usable both inside the factory and in
// the test bodies below.
type Handler = (...a: unknown[]) => void;
const FakeMap = vi.hoisted(() => {
	class FakeMap {
		static last: FakeMap | null = null;
		handlers: Record<string, Handler[]> = {};
		layerHandlers: Record<string, Record<string, Handler[]>> = {};
		sources: Record<string, { data: unknown }> = {};
		style: unknown;
		removed = false;
		constructor(opts: { style: unknown }) {
			this.style = opts.style;
			FakeMap.last = this;
		}
		on(ev: string, a?: unknown, b?: unknown) {
			if (typeof a === "string" && typeof b === "function") {
				(this.layerHandlers[ev] ??= {})[a] ??= [];
				this.layerHandlers[ev][a].push(b as Handler);
			} else if (typeof a === "function") {
				(this.handlers[ev] ??= []).push(a as Handler);
			}
		}
		fire(ev: string) { for (const h of this.handlers[ev] ?? []) h(); }
		fireLayer(ev: string, layer: string, payload: unknown) {
			for (const h of this.layerHandlers[ev]?.[layer] ?? []) h(payload);
		}
		addSource(id: string, def: { data: unknown }) { this.sources[id] = { data: def.data }; }
		addLayer() {}
		getSource(id: string) {
			const s = this.sources[id];
			return s ? { setData: (d: unknown) => { s.data = d; } } : undefined;
		}
		queryRenderedFeatures() { return [] as unknown[]; }
		resize() {}
		remove() { this.removed = true; }
	}
	return FakeMap;
});
vi.mock("maplibre-gl", () => ({
	default: { Map: FakeMap, addProtocol: vi.fn() },
	Map: FakeMap,
	addProtocol: vi.fn(),
}));
vi.mock("pmtiles", () => ({ Protocol: class { tile = vi.fn(); } }));

import { FlightMap } from "./FlightMap";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA1002", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 30000, ...over,
});

describe("FlightMap", () => {
	beforeEach(() => { FakeMap.last = null; });
	afterEach(() => vi.clearAllMocks());

	it("creates a map, adds the flights source on load, and pushes positions", () => {
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrl="x.pmtiles"
				trackGeoJSON={null} onSelectFlight={() => {}} onClearSelection={() => {}} />,
		);
		const map = FakeMap.last!;
		expect(map).toBeTruthy();
		map.fire("load");
		const data = map.sources.flights?.data as { features: unknown[] };
		expect(data.features).toHaveLength(1);
	});

	it("calls onSelectFlight when a plane is clicked", () => {
		const onSelect = vi.fn();
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrl="x.pmtiles"
				trackGeoJSON={null} onSelectFlight={onSelect} onClearSelection={() => {}} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.fireLayer("click", "flights-dots", { features: [{ properties: { flight: "AA11" } }] });
		expect(onSelect).toHaveBeenCalledWith("AA11");
	});

	it("removes the map on unmount (frees the WebGL context)", () => {
		const { unmount } = render(
			<FlightMap positions={[]} basemapUrl="x.pmtiles" trackGeoJSON={null}
				onSelectFlight={() => {}} onClearSelection={() => {}} />,
		);
		const map = FakeMap.last!;
		unmount();
		expect(map.removed).toBe(true);
	});
});
