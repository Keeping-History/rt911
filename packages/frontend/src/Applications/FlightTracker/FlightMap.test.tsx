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
		layers: Record<string, unknown>[] = [];
		paint: Record<string, Record<string, unknown>> = {};
		layout: Record<string, Record<string, unknown>> = {};
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
		queryResult: unknown[] = [];
		fire(ev: string, payload?: unknown) { for (const h of this.handlers[ev] ?? []) h(payload); }
		fireLayer(ev: string, layer: string, payload: unknown) {
			for (const h of this.layerHandlers[ev]?.[layer] ?? []) h(payload);
		}
		addSource(id: string, def: { data: unknown }) { this.sources[id] = { data: def.data }; }
		addLayer(def: Record<string, unknown>, beforeId?: string) {
			this.layers.push({ ...def, beforeId });
		}
		setPaintProperty(layerId: string, name: string, value: unknown) {
			(this.paint[layerId] ??= {})[name] = value;
		}
		setLayoutProperty(layerId: string, name: string, value: unknown) {
			(this.layout[layerId] ??= {})[name] = value;
		}
		getSource(id: string) {
			const s = this.sources[id];
			return s ? { setData: (d: unknown) => { s.data = d; } } : undefined;
		}
		queryRenderedFeatures() { return this.queryResult; }
		project(c: [number, number]) { return { x: c[0], y: c[1] }; }
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
	afterEach(() => {
		// Restore globals/spies stubbed by the animation-loop test (rAF, performance.now)
		// so a future test appended here doesn't inherit a frozen clock / stubbed rAF.
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("creates a map, adds the flights source on load, and pushes positions", () => {
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrl="x.pmtiles"
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} />,
		);
		const map = FakeMap.last!;
		expect(map).toBeTruthy();
		map.fire("load");
		const data = map.sources.flights?.data as { features: unknown[] };
		expect(data.features).toHaveLength(1);
	});

	it("selects the nearest dot within the click tolerance box (forgiving near-miss)", () => {
		const onSelect = vi.fn();
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrl="x.pmtiles"
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={onSelect} onClearSelection={() => {}}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		// A near-miss click still finds dots in the tolerance box; the closer one wins.
		// project() maps [lon,lat] → {x:lon, y:lat}, so the click at (12,20) is nearest [12,20].
		map.queryResult = [
			{ geometry: { type: "Point", coordinates: [50, 50] }, properties: { flight: "FAR" } },
			{ geometry: { type: "Point", coordinates: [12, 20] }, properties: { flight: "AA11" } },
		];
		map.fire("click", { point: { x: 12, y: 20 } });
		expect(onSelect).toHaveBeenCalledWith("AA11");
	});

	it("clears the selection when no dot is within the tolerance box", () => {
		const onClear = vi.fn();
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrl="x.pmtiles"
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={onClear}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.queryResult = []; // nothing near the click
		map.fire("click", { point: { x: 200, y: 200 } });
		expect(onClear).toHaveBeenCalled();
	});

	it("removes the map on unmount (frees the WebGL context)", () => {
		const { unmount } = render(
			<FlightMap positions={[]} basemapUrl="x.pmtiles" trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} />,
		);
		const map = FakeMap.last!;
		unmount();
		expect(map.removed).toBe(true);
	});

	it("adds a flight-trails layer and glides dots forward via the animation loop", () => {
		// Control the animation frame + timestamp deterministically.
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		// Re-anchor (the [nowMs] effect) reads performance.now(); pin it to 0 so the
		// smooth clock's wall origin is 0 and the frame timestamp is the elapsed ms.
		vi.spyOn(performance, "now").mockReturnValue(0);

		const t1 = Date.parse("2001-09-11T13:01:00.000Z");
		const p1 = pos({ id: 1, flight: "AA1", lat: 40, lon: -74, start_date: "2001-09-11T13:00:00.000Z" });
		const p2 = pos({ id: 2, flight: "AA1", lat: 40, lon: -73, start_date: "2001-09-11T13:01:00.000Z" });

		const common = {
			basemapUrl: "x.pmtiles", trackGeoJSON: null, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false,
		};
		const { rerender } = render(
			<FlightMap positions={[p1]} nowMs={Date.parse("2001-09-11T13:00:00.000Z")} playing {...common} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.sources["flight-trails"]).toBeDefined();

		// Second sample → establishes velocity (+1 lon / 60s). Re-anchor now == t1, wall == 0.
		rerender(<FlightMap positions={[p2]} nowMs={t1} playing {...common} />);

		// Run one frame 30s of wall time later → smoothNow == t1 + 30_000 → head lon ≈ -72.5.
		rafCb!(30_000);

		const head = (map.sources.flights?.data as { features: { geometry: { coordinates: [number, number] } }[] })
			.features[0].geometry.coordinates;
		expect(head[0]).toBeGreaterThan(-73); // glided forward past the last sample
		expect(head[0]).toBeLessThan(-72); // but within the clamp, not overshot
		const trails = (map.sources["flight-trails"]?.data as { features: unknown[] }).features;
		expect(trails.length).toBe(1);
	});

	it("applies pin colors + theme on load and live via setPaintProperty (no re-mount)", () => {
		const common = {
			positions: [], basemapUrl: "x.pmtiles", trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {}, radarSweep: false,
		};
		const { rerender } = render(
			<FlightMap {...common} darkMap={false} pinColor="#00aa00" notablePinColor="#123456" />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		// The load handler applies the current colors over the just-added layers.
		expect(map.paint["flights-dots"]?.["circle-color"]).toBe("#00aa00");
		expect(map.paint["flights-notable"]?.["circle-color"]).toBe("#123456");
		expect(map.paint["background"]?.["background-color"]).toBe("#efe9dd");

		// Theme flip + recolor: live paint updates on the SAME map instance.
		rerender(
			<FlightMap {...common} darkMap={true} pinColor="#ffffff" notablePinColor="#ff0000" />,
		);
		expect(FakeMap.last).toBe(map); // no map re-creation
		expect(map.paint["background"]?.["background-color"]).toBe("#1c1c22");
		// Trail fade uses a themed line-gradient (dark #9a9aa6 → rgb 154,154,166).
		expect(JSON.stringify(map.paint["flight-trails"]?.["line-gradient"])).toContain("154,154,166");
		expect(map.paint["flights-dots"]?.["circle-color"]).toBe("#ffffff");
		expect(map.paint["flights-notable"]?.["circle-color"]).toBe("#ff0000");
	});

	it("creates radar layers under the track line, visible when radarSweep is on", () => {
		render(
			<FlightMap positions={[]} basemapUrl="x.pmtiles" trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={true} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.sources["radar-sweep"]).toBeDefined();
		const trail = map.sources["radar-trail"]?.data as { features: { properties: { opacity: number } }[] };
		expect(trail.features).toHaveLength(12);
		const radarLayers = map.layers.filter((l) =>
			l.id === "radar-sweep" || l.id === "radar-trail");
		expect(radarLayers).toHaveLength(2);
		for (const l of radarLayers) {
			expect(l.beforeId).toBe("track-line"); // radar renders below track + flights
			expect((l.layout as { visibility: string }).visibility).toBe("visible");
		}
		// jsdom resolves no theme var → fallback color on both layers.
		const sweep = map.layers.find((l) => l.id === "radar-sweep") as { paint: Record<string, unknown> };
		expect(sweep.paint["line-color"]).toBe("#808080");
	});

	it("toggles radar visibility via setLayoutProperty and re-applies the color on re-enable", () => {
		const common = {
			positions: [], basemapUrl: "x.pmtiles", trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, pinColor: "#3a3a3a", notablePinColor: "#c0202a",
		};
		const { rerender } = render(<FlightMap {...common} radarSweep={true} />);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(<FlightMap {...common} radarSweep={false} />);
		expect(map.layout["radar-sweep"]?.visibility).toBe("none");
		expect(map.layout["radar-trail"]?.visibility).toBe("none");
		rerender(<FlightMap {...common} radarSweep={true} />);
		expect(map.layout["radar-sweep"]?.visibility).toBe("visible");
		expect(map.paint["radar-sweep"]?.["line-color"]).toBe("#808080"); // re-resolved on re-enable
	});

	it("advances the sweep with the virtual clock in the animation loop", () => {
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		render(
			<FlightMap positions={[]} basemapUrl="x.pmtiles" trackGeoJSON={null}
				nowMs={0} playing onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={true} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const tipAtLoad = (map.sources["radar-sweep"]!.data as {
			geometry: { coordinates: [number, number][] };
		}).geometry.coordinates[1];
		expect(tipAtLoad[0]).toBeCloseTo(-98.35, 2); // t=0 → due north of center

		// One frame 15 virtual seconds later → quarter turn → tip due east (~27° lon away).
		rafCb!(15_000);
		const tip = (map.sources["radar-sweep"]!.data as {
			geometry: { coordinates: [number, number][] };
		}).geometry.coordinates[1];
		expect(tip[0]).toBeGreaterThan(-80);
		expect(tip[1]).toBeCloseTo(39.83, 2);
	});
});
