import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { insertReplaySamples, type ReplayBuffer } from "./flightReplay";

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
		ctorOpts: Record<string, unknown>;
		constructor(opts: { style: unknown } & Record<string, unknown>) {
			this.style = opts.style;
			this.ctorOpts = opts;
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
			// __raw keeps the original object: custom layer INSTANCES lose their
			// prototype methods under spread, and tests poke their live state.
			this.layers.push({ ...def, beforeId, __raw: def });
		}
		repaints = 0;
		triggerRepaint() { this.repaints++; }
		setPaintProperty(layerId: string, name: string, value: unknown) {
			(this.paint[layerId] ??= {})[name] = value;
		}
		setLayoutProperty(layerId: string, name: string, value: unknown) {
			(this.layout[layerId] ??= {})[name] = value;
		}
		images: Record<string, unknown> = {};
		updatedImages: Record<string, unknown> = {};
		hasImage(id: string) { return id in this.images; }
		addImage(id: string, img: unknown) { this.images[id] = img; }
		updateImage(id: string, img: unknown) { this.updatedImages[id] = img; this.images[id] = img; }
		getSource(id: string) {
			const s = this.sources[id];
			return s
				? {
					setData: (d: unknown) => { s.data = d; },
					// Clustered-source API: tests always expand to zoom 8.
					getClusterExpansionZoom: async () => 8,
				}
				: undefined;
		}
		queryRenderedFeatures() { return this.queryResult; }
		project(c: [number, number]) { return { x: c[0], y: c[1] }; }
		zoom = 3;
		bearing = 0;
		getBearing() { return this.bearing; }
		getCenter() { return { lng: -98, lat: 39 }; }
		pitch = 0;
		getPitch() { return this.pitch; }
		maxPitchCalls: number[] = [];
		minPitchCalls: number[] = [];
		// Interleaved order log — MapLibre throws if min ever exceeds max.
		pitchLimitLog: string[] = [];
		setMaxPitch(v: number) {
			this.maxPitchCalls.push(v);
			this.pitchLimitLog.push(`max:${v}`);
			// Real maplibre clamps the live pitch immediately and fires "pitch".
			if (this.pitch > v) {
				this.pitch = v;
				this.fire("pitch");
			}
		}
		setMinPitch(v: number) {
			this.minPitchCalls.push(v);
			this.pitchLimitLog.push(`min:${v}`);
			if (this.pitch < v) {
				this.pitch = v;
				this.fire("pitch");
			}
		}
		dragPanDisabled = false;
		dragPan = {
			disable: () => { this.dragPanDisabled = true; },
			enable: () => { this.dragPanDisabled = false; },
		};
		canvasStyle: Record<string, string> = {};
		getCanvas() { return { style: this.canvasStyle } as unknown as HTMLCanvasElement; }
		easeToCalls: Record<string, unknown>[] = [];
		flyToCalls: Record<string, unknown>[] = [];
		projections: Record<string, unknown>[] = [];
		setProjection(p: Record<string, unknown>) { this.projections.push(p); }
		skies: unknown[] = [];
		setSky(sky: unknown) { this.skies.push(sky); }
		jumpToCalls: Record<string, unknown>[] = [];
		jumpTo(o: Record<string, unknown>) {
			this.jumpToCalls.push(o);
			// Mimic the real map: the camera moves and "pitch" fires synchronously.
			if (typeof o.pitch === "number") {
				this.pitch = o.pitch;
				this.fire("pitch");
			}
		}
		getZoom() { return this.zoom; }
		easeTo(o: Record<string, unknown>) { this.easeToCalls.push(o); }
		flyTo(o: Record<string, unknown>) { this.flyToCalls.push(o); }
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
// Real constants, fake rasterizer — jsdom has no canvas. The fake records the
// fill so tests can assert which color went into which image.
vi.mock("./flightIcons", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./flightIcons")>();
	return {
		...actual,
		buildPlaneImage: vi.fn(async (_svg: string, fill: string) => ({ fill }) as unknown as ImageData),
	};
});

import { createRef } from "react";
import { FlightMap, type FlightMapHandle, nonNotableFeatures } from "./FlightMap";
import { motionPointsToGeoJSON, updateMotion, type MotionBuffer } from "./flightMotion";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA1002", start_date: "2001-09-11T13:00:00Z",
	lat: 40, lon: -74, alt_ft: 30000, ...over,
});

const TEST_URLS = {
	vector: "x.pmtiles",
	satelliteDay: "day.pmtiles",
	satelliteNight: "night.pmtiles",
};

describe("FlightMap", () => {
	beforeEach(() => { FakeMap.last = null; });
	afterEach(() => {
		// No RTL auto-cleanup in this repo — unmount so screen queries in later
		// tests don't match elements from earlier renders.
		cleanup();
		// Restore globals/spies stubbed by the animation-loop test (rAF, performance.now)
		// so a future test appended here doesn't inherit a frozen clock / stubbed rAF.
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("creates a map, adds the flights source on load, and pushes positions", () => {
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrls={TEST_URLS}
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
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
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrls={TEST_URLS}
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={onSelect} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
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
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrls={TEST_URLS}
				trackGeoJSON={null} nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={onClear}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.queryResult = []; // nothing near the click
		map.fire("click", { point: { x: 200, y: 200 } });
		expect(onClear).toHaveBeenCalled();
	});

	it("removes the map on unmount (frees the WebGL context)", () => {
		const { unmount } = render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
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
			basemapUrls: TEST_URLS, trackGeoJSON: null, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
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

	it("installs plane icons from pin colors and re-themes/recolors live (no re-mount)", async () => {
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {}, radarSweep: false, trailMultiplier: 1,
		};
		const { rerender } = render(
			<FlightMap {...common} darkMap={false} mapStyle="classic" pinColor="#00aa00" notablePinColor="#123456" />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		// Basemap still themed via paint; pin colors now flow through the icons.
		expect(map.paint["background"]?.["background-color"]).toBe("#efe9dd");
		await vi.waitFor(() => {
			expect((map.images["plane-icon"] as { fill: string }).fill).toBe("#00aa00");
			expect((map.images["plane-notable-icon"] as { fill: string }).fill).toBe("#123456");
		});

		rerender(
			<FlightMap {...common} darkMap={true} mapStyle="classic" pinColor="#ffffff" notablePinColor="#ff0000" />,
		);
		expect(FakeMap.last).toBe(map); // no map re-creation
		expect(map.paint["background"]?.["background-color"]).toBe("#1c1c22");
		// Trail fade uses a themed line-gradient (dark #9a9aa6 → rgb 154,154,166).
		expect(JSON.stringify(map.paint["flight-trails"]?.["line-gradient"])).toContain("154,154,166");
		await vi.waitFor(() => {
			expect((map.updatedImages["plane-icon"] as { fill: string }).fill).toBe("#ffffff");
			expect((map.updatedImages["plane-notable-icon"] as { fill: string }).fill).toBe("#ff0000");
		});
	});

	it("renders planes as heading-rotated symbol layers (regular excludes notables)", () => {
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const dots = map.layers.find((l) => l.id === "flights-dots") as {
			type: string; filter: unknown; layout: Record<string, unknown>;
		};
		expect(dots.type).toBe("symbol");
		expect(dots.filter).toEqual(["!=", ["get", "notable"], true]);
		expect(dots.layout["icon-image"]).toBe("plane-icon");
		expect(dots.layout["icon-rotate"]).toEqual(["-", ["get", "heading"], 90]);
		expect(dots.layout["icon-rotation-alignment"]).toBe("map");
		expect(dots.layout["icon-allow-overlap"]).toBe(true);
		expect(dots.layout["icon-ignore-placement"]).toBe(true);
		// Regular planes grow to 1.5× while zooming in, capping at ~zoom 9
		// (≈100 mi visible); interpolate clamps beyond the last stop.
		expect(dots.layout["icon-size"]).toEqual(
			["interpolate", ["linear"], ["zoom"], 4, 1, 9, 1.5],
		);
		const notable = map.layers.find((l) => l.id === "flights-notable") as {
			type: string; layout: Record<string, unknown>;
		};
		expect(notable.type).toBe("symbol");
		expect(notable.layout["icon-image"]).toBe("plane-notable-icon");
		expect(notable.layout["icon-size"]).toBeUndefined(); // notables stay fixed
	});

	it("creates radar layers under the track line, visible when radarSweep is on", () => {
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={true} trailMultiplier={1} />,
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
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a", notablePinColor: "#c0202a",
		};
		const { rerender } = render(<FlightMap {...common} radarSweep={true} trailMultiplier={1} />);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(<FlightMap {...common} radarSweep={false} trailMultiplier={1} />);
		expect(map.layout["radar-sweep"]?.visibility).toBe("none");
		expect(map.layout["radar-trail"]?.visibility).toBe("none");
		rerender(<FlightMap {...common} radarSweep={true} trailMultiplier={1} />);
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
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={true} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const tipAtLoad = (map.sources["radar-sweep"]!.data as {
			geometry: { coordinates: [number, number][] };
		}).geometry.coordinates[1];
		expect(tipAtLoad[0]).toBeCloseTo(-98.35, 2); // t=0 → due north of center

		// One frame 7.5 virtual seconds later → quarter turn (30s period) → tip due east.
		rafCb!(7_500);
		const tip = (map.sources["radar-sweep"]!.data as {
			geometry: { coordinates: [number, number][] };
		}).geometry.coordinates[1];
		expect(tip[0]).toBeGreaterThan(-80);
		expect(tip[1]).toBeCloseTo(39.83, 2);
	});

	it("turns trails off next frame when trailMultiplier drops to 0", () => {
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		const t1 = Date.parse("2001-09-11T13:01:00.000Z");
		const p1 = pos({ id: 1, flight: "AA1", lon: -74, start_date: "2001-09-11T13:00:00.000Z" });
		const p2 = pos({ id: 2, flight: "AA1", lon: -73, start_date: "2001-09-11T13:01:00.000Z" });
		const common = {
			basemapUrls: TEST_URLS, trackGeoJSON: null, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false,
		};
		const { rerender } = render(
			<FlightMap positions={[p1]} nowMs={Date.parse("2001-09-11T13:00:00.000Z")} playing trailMultiplier={1} {...common} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(<FlightMap positions={[p2]} nowMs={t1} playing trailMultiplier={1} {...common} />);
		rafCb!(1_000);
		expect((map.sources["flight-trails"]!.data as { features: unknown[] }).features).toHaveLength(1);

		rerender(<FlightMap positions={[p2]} nowMs={t1} playing trailMultiplier={0} {...common} />);
		rafCb!(2_000);
		expect((map.sources["flight-trails"]!.data as { features: unknown[] }).features).toHaveLength(0);
	});

	it("adds ghost source and layers under the live dots on load", () => {
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false}
				trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.sources["ghost-flights"]).toBeDefined();
		const ghostDots = map.layers.find((l) => l.id === "ghost-dots");
		const ghostNotable = map.layers.find((l) => l.id === "ghost-notable");
		expect(ghostDots?.beforeId).toBe("flights-dots");
		expect(ghostNotable?.beforeId).toBe("flights-dots");
	});

	it("clears the ghost source when loop mode turns off", () => {
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false,
			trailMultiplier: 1,
			loopWindowMs: 1_800_000,
			loopClock: { anchorVirtual: 0, anchorWall: 0, speed: 10 as const, scrubbing: false, paused: false },
			replayBuffer: new Map(),
		};
		const { rerender } = render(<FlightMap {...common} loopEnabled={true} />);
		const map = FakeMap.last!;
		map.fire("load");
		// Seed the ghost source with a non-empty FC to prove the disable clears it.
		map.getSource("ghost-flights")?.setData({
			type: "FeatureCollection",
			features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} }],
		});
		rerender(<FlightMap {...common} loopEnabled={false} />);
		const data = map.sources["ghost-flights"].data as { features: unknown[] };
		expect(data.features).toEqual([]);
	});

	it("derives an immediate heading for single-sample flights from seedPositions", () => {
		// Live snapshot has ONE sample per flight (the first-open case); the seed
		// lookback supplies the previous minute so the plane doesn't point north.
		const live = pos({ id: 2, flight: "AA1", lat: 40, lon: -73, start_date: "2001-09-11T13:00:00Z" });
		const seed = pos({ id: 1, flight: "AA1", lat: 40, lon: -74, start_date: "2001-09-11T12:59:00Z" });
		render(
			<FlightMap positions={[live]} seedPositions={[seed]} basemapUrls={TEST_URLS}
				trackGeoJSON={null} nowMs={Date.parse("2001-09-11T13:00:00Z")} playing={false}
				onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const data = map.sources.flights?.data as {
			features: { properties: { heading: number } }[];
		};
		expect(data.features[0].properties.heading).toBeCloseTo(90, 5); // due east, not north
	});

	it("applies seedPositions that arrive after the live snapshot", () => {
		// Chunked replies mean the seed can land a render after the snapshot; the
		// seed effect marks the map dirty so the next animation frame redraws.
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		const live = pos({ id: 2, flight: "AA1", lat: 40, lon: -73, start_date: "2001-09-11T13:00:00Z" });
		const seed = pos({ id: 1, flight: "AA1", lat: 40, lon: -74, start_date: "2001-09-11T12:59:00Z" });
		const common = {
			basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: Date.parse("2001-09-11T13:00:00Z"),
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
		};
		const { rerender } = render(<FlightMap positions={[live]} seedPositions={[]} {...common} />);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(<FlightMap positions={[live]} seedPositions={[seed]} {...common} />);
		rafCb!(100); // one paused-but-dirty frame
		const data = map.sources.flights?.data as {
			features: { properties: { heading: number } }[];
		};
		expect(data.features[0].properties.heading).toBeCloseTo(90, 5);
	});

	it("skips ghost points for flights outside visibleFlights", () => {
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		const t0 = Date.parse("2001-09-11T13:00:00.000Z");
		const buffer: ReplayBuffer = new Map();
		// One sample each at the loop-clock anchor instant, so the paused
		// playhead lands exactly on both flights' sampled lifetimes.
		insertReplaySamples(buffer, [
			pos({ id: 1, flight: "AA11", start_date: "2001-09-11T12:50:00.000Z" }),
			pos({ id: 2, flight: "UA175", start_date: "2001-09-11T12:50:00.000Z" }),
		]);

		render(
			<FlightMap
				positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null} nowMs={t0} playing
				onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1}
				loopEnabled loopWindowMs={1_800_000}
				loopClock={{
					anchorVirtual: t0 - 600_000, anchorWall: 0, speed: 10,
					scrubbing: false, paused: true,
				}}
				replayBuffer={buffer}
				visibleFlights={new Set(["AA11"])}
			/>,
		);
		const map = FakeMap.last!;
		map.fire("load");
		rafCb!(100);

		const ghosts = (
			map.sources["ghost-flights"]?.data as {
				features: { properties: { flight: string } }[];
			}
		).features;
		expect(ghosts.map((g) => g.properties.flight)).toEqual(["AA11"]);
	});

	it("applies globe projection at load and re-applies on toggle", () => {
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a",
			notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
		};
		const { rerender } = render(<FlightMap {...common} globe={false} />);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.projections.at(-1)).toEqual({ type: "mercator" });
		rerender(<FlightMap {...common} globe={true} />);
		expect(map.projections.at(-1)).toEqual({ type: "globe" });
		rerender(<FlightMap {...common} globe={false} />);
		expect(map.projections.at(-1)).toEqual({ type: "mercator" });
	});

	it("3D toggle gates pitch: lifts maxPitch + eases in, clamps flat on exit", () => {
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a",
			notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
		};
		const { rerender, unmount } = render(<FlightMap {...common} threeD={false} />);
		const map = FakeMap.last!;
		// Constructed flat-locked: right-drag can never change the z axis in 2D.
		expect((map.ctorOpts as { maxPitch?: number }).maxPitch).toBe(0);
		map.fire("load");
		expect(map.jumpToCalls).toHaveLength(0); // flat start: no pitch seed
		rerender(<FlightMap {...common} threeD={true} />);
		expect(map.maxPitchCalls.at(-1)).toBe(60);
		// 3D also floors the pitch: right-drag can tilt but never flatten back
		// into 2D (max must lift before min — maplibre rejects min > max).
		expect(map.minPitchCalls.at(-1)).toBe(10);
		expect(map.pitchLimitLog).toEqual(["max:60", "min:10"]);
		expect(map.easeToCalls.at(-1)).toMatchObject({ pitch: 60 });
		map.pitch = 60;
		rerender(<FlightMap {...common} threeD={false} />);
		// Exiting 3D collapses the band to 0 (min drops first), snapping flat.
		expect(map.pitchLimitLog.slice(2)).toEqual(["min:0", "max:0"]);
		expect(map.pitch).toBe(0);
		unmount();

		// A session restored with 3D on constructs unlocked and pitches at load.
		render(<FlightMap {...common} threeD={true} />);
		const map2 = FakeMap.last!;
		expect((map2.ctorOpts as { maxPitch?: number }).maxPitch).toBe(60);
		expect((map2.ctorOpts as { minPitch?: number }).minPitch).toBe(10);
		map2.fire("load");
		expect(map2.jumpToCalls.at(-1)).toMatchObject({ pitch: 60 });
		// Regression (refresh with 3D persisted): the pitch seed fires BEFORE the
		// layers exist, so the end-of-load visibility sync must hide the 2D pins
		// and arm the 3D aircraft — the event alone can't.
		expect(map2.layout["flights-dots"]?.visibility).toBe("none");
		expect(map2.layout["flights-notable"]?.visibility).toBe("none");
		const model2 = map2.layers.find((l) => l.id === "planes-3d-model")!
			.__raw as import("./planes3DLayer").Planes3DLayer;
		expect(model2.visible).toBe(true);
		expect(map2.layout["track-curtain"]?.visibility).toBe("visible");
	});

	it("nonNotableFeatures drops the notable flights (they never cluster)", () => {
		const buf: MotionBuffer = new Map();
		updateMotion(buf, [
			pos({ id: 1, flight: "AA11" }),
			pos({ id: 2, flight: "DL404" }),
		]);
		const out = nonNotableFeatures(motionPointsToGeoJSON(buf, 0));
		expect(out.features.map((f) => f.properties.flight)).toEqual(["DL404"]);
	});

	it("cluster toggle swaps the plane/trail layers for the cluster layers", () => {
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a",
			notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
		};
		const { rerender } = render(<FlightMap {...common} cluster={false} />);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.sources["flights-clustered"]).toBeDefined();
		for (const id of ["cluster-circles", "cluster-counts", "cluster-planes"]) {
			const layer = map.layers.find((l) => l.id === id) as { layout: { visibility: string } };
			expect(layer.layout.visibility).toBe("none");
		}
		rerender(<FlightMap {...common} cluster={true} />);
		expect(map.layout["flights-dots"]?.visibility).toBe("none");
		expect(map.layout["flight-trails"]?.visibility).toBe("none");
		expect(map.layout["cluster-circles"]?.visibility).toBe("visible");
		expect(map.layout["cluster-counts"]?.visibility).toBe("visible");
		expect(map.layout["cluster-planes"]?.visibility).toBe("visible");
		rerender(<FlightMap {...common} cluster={false} />);
		expect(map.layout["flights-dots"]?.visibility).toBe("visible");
		expect(map.layout["cluster-circles"]?.visibility).toBe("none");
	});

	it("clicking a cluster eases to its expansion zoom instead of selecting", async () => {
		const onSelect = vi.fn();
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={onSelect} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} cluster={true} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.queryResult = [
			{
				geometry: { type: "Point", coordinates: [-80, 40] },
				properties: { cluster: true, cluster_id: 7, point_count: 12 },
			},
		];
		map.fire("click", { point: { x: 10, y: 10 } });
		await vi.waitFor(() => {
			expect(map.easeToCalls.at(-1)).toMatchObject({ center: [-80, 40], zoom: 8 });
		});
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("drag-selects flights in the box, deduped, and disables panning while armed", () => {
		const onAreaSelect = vi.fn();
		const common = {
			positions: [], basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0,
			playing: false, onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a",
			notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1, onAreaSelect,
		};
		const { rerender } = render(<FlightMap {...common} selectMode="off" />);
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.dragPanDisabled).toBe(false);
		rerender(<FlightMap {...common} selectMode="rect" />);
		expect(map.dragPanDisabled).toBe(true);

		// project() maps [lon,lat]→{x:lon,y:lat}: both dots land inside the box.
		map.queryResult = [
			{ geometry: { type: "Point", coordinates: [50, 40] }, properties: { flight: "DL404" } },
			{ geometry: { type: "Point", coordinates: [80, 60] }, properties: { flight: "UA93" } },
			{ geometry: { type: "Point", coordinates: [50, 40] }, properties: { flight: "DL404" } },
		];
		map.fire("mousedown", { point: { x: 10, y: 10 } });
		map.fire("mousemove", { point: { x: 120, y: 90 } });
		map.fire("mouseup", { point: { x: 120, y: 90 } });
		expect(onAreaSelect).toHaveBeenCalledWith(["DL404", "UA93"]);

		// Disarming re-enables panning.
		rerender(<FlightMap {...common} selectMode="off" />);
		expect(map.dragPanDisabled).toBe(false);
	});

	it("circle mode drops features outside the radius even when inside the query box", () => {
		const onAreaSelect = vi.fn();
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} selectMode="circle" onAreaSelect={onAreaSelect} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		// Center (0,0), radius 50. (18,24) is inside (dist 30); (49,49) is in the
		// bounding box but outside the circle (dist ~69).
		map.queryResult = [
			{ geometry: { type: "Point", coordinates: [18, 24] }, properties: { flight: "IN" } },
			{ geometry: { type: "Point", coordinates: [49, 49] }, properties: { flight: "OUT" } },
		];
		map.fire("mousedown", { point: { x: 0, y: 0 } });
		map.fire("mouseup", { point: { x: 30, y: 40 } });
		expect(onAreaSelect).toHaveBeenCalledWith(["IN"]);
	});

	it("pitching swaps flat icons for the true-3D aircraft layer (mercator)", () => {
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		render(
			<FlightMap positions={[pos({ id: 5, flight: "DL404", alt_ft: 31_000 })]}
				basemapUrls={TEST_URLS} trackGeoJSON={null} nowMs={0} playing={false}
				onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const model = map.layers.find((l) => l.id === "planes-3d-model")!
			.__raw as import("./planes3DLayer").Planes3DLayer;
		expect(model.type).toBe("custom");
		expect(model.visible).toBe(false); // flat start
		// The extrusion twin exists purely as the globe fallback.
		const slabs = map.layers.find((l) => l.id === "planes-3d") as { type: string };
		expect(slabs.type).toBe("fill-extrusion");

		map.pitch = 60;
		map.fire("pitch");
		// The aircraft move into true 3D: flat icons hide, the custom layer arms,
		// the extrusion fallback stays off under mercator.
		expect(model.visible).toBe(true);
		expect(map.layout["flights-dots"]?.visibility).toBe("none");
		expect(map.layout["flights-notable"]?.visibility).toBe("none");
		expect(map.layout["planes-3d"]?.visibility).toBe("none");
		rafCb!(100); // pitch marked the frame dirty → instances feed
		expect(model.instanceCount).toBe(1);
		expect(map.repaints).toBeGreaterThan(0);

		map.pitch = 0;
		map.fire("pitch");
		expect(model.visible).toBe(false);
		expect(map.layout["flights-dots"]?.visibility).toBe("visible");
	});

	it("globe projection falls back to the extrusion slabs while pitched", () => {
		let rafCb: FrameRequestCallback | null = null;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			rafCb = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		vi.spyOn(performance, "now").mockReturnValue(0);

		render(
			<FlightMap positions={[pos({ id: 5, flight: "DL404", alt_ft: 31_000 })]}
				basemapUrls={TEST_URLS} trackGeoJSON={null} nowMs={0} playing={false}
				onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} threeD={true} globe={true} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		const model = map.layers.find((l) => l.id === "planes-3d-model")!
			.__raw as import("./planes3DLayer").Planes3DLayer;
		// Custom-layer mercator math doesn't hold on the sphere: extrusions
		// render instead.
		expect(model.visible).toBe(false);
		expect(map.layout["planes-3d"]?.visibility).toBe("visible");
		rafCb!(100);
		const data = map.sources["planes-3d"]?.data as { features: unknown[] };
		expect(data.features).toHaveLength(1);
		expect(model.instanceCount).toBe(0);
	});

	it("reports pitch-threshold crossings so the 3D toggle can follow the camera", () => {
		const onPitchedChange = vi.fn();
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} threeD={true} onPitchedChange={onPitchedChange} />,
		);
		const map = FakeMap.last!;
		map.fire("load"); // jumpTo seed fires "pitch" at 60 → pitched
		expect(onPitchedChange).toHaveBeenLastCalledWith(true);
		// User right-drags the camera flat: one crossing, one callback.
		map.pitch = 3;
		map.fire("pitch");
		expect(onPitchedChange).toHaveBeenLastCalledWith(false);
		map.pitch = 2;
		map.fire("pitch"); // still flat — no duplicate call
		expect(onPitchedChange).toHaveBeenCalledTimes(2);
	});

	it("pitched click hit-tests the planes' elevated positions, not layer footprints", () => {
		const onSelect = vi.fn();
		const onClear = vi.fn();
		// Two airborne planes; stub project() maps lon/lat→x/y (no transform on
		// the stub, so projectAtAltitude falls back to ground projection).
		render(
			<FlightMap
				positions={[
					pos({ id: 1, flight: "DL404", lon: 40, lat: 30 }),
					pos({ id: 2, flight: "UA9", lon: 200, lat: 200 }),
				]}
				basemapUrls={TEST_URLS} trackGeoJSON={null} nowMs={0} playing={false}
				onSelectFlight={onSelect} onClearSelection={onClear}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} threeD={true} />,
		);
		const map = FakeMap.last!;
		map.fire("load"); // seeds pitch 60 → pitched hit path active
		// queryRenderedFeatures would return nothing here (footprints don't
		// contain the click) — the buffer-based test must still find DL404.
		map.queryResult = [];
		map.fire("click", { point: { x: 41, y: 31 } });
		expect(onSelect).toHaveBeenCalledWith("DL404");
		// A click far from every plane clears.
		map.fire("click", { point: { x: 500, y: 500 } });
		expect(onClear).toHaveBeenCalled();
	});

	it("pitched area select captures planes by elevated position", () => {
		const onAreaSelect = vi.fn();
		const common = {
			positions: [
				pos({ id: 1, flight: "DL404", lon: 40, lat: 30 }),
				pos({ id: 2, flight: "UA9", lon: 300, lat: 300 }),
			],
			basemapUrls: TEST_URLS, trackGeoJSON: null, nowMs: 0, playing: false,
			onSelectFlight: () => {}, onClearSelection: () => {},
			darkMap: false, mapStyle: "classic" as const, pinColor: "#3a3a3a",
			notablePinColor: "#c0202a", radarSweep: false, trailMultiplier: 1,
			threeD: true, onAreaSelect,
		};
		render(<FlightMap {...common} selectMode="rect" />);
		const map = FakeMap.last!;
		map.fire("load");
		map.queryResult = []; // footprint query must not be what selects
		map.fire("mousedown", { point: { x: 10, y: 10 } });
		map.fire("mouseup", { point: { x: 100, y: 100 } });
		expect(onAreaSelect).toHaveBeenCalledWith(["DL404"]); // UA9 outside box
	});

	it("compass tracks map rotation and resets bearing on click", () => {
		render(
			<FlightMap positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		map.bearing = 30;
		act(() => map.fire("rotate"));
		expect(screen.getByTestId("compass-needle").style.transform).toBe("rotate(-30deg)");
		fireEvent.click(screen.getByRole("button", { name: "Reset bearing to north" }));
		expect(map.easeToCalls.at(-1)).toMatchObject({ bearing: 0 });
	});

	it("exposes an imperative camera handle (zoom, flyTo, resetNorth)", () => {
		const ref = createRef<FlightMapHandle>();
		render(
			<FlightMap ref={ref} positions={[]} basemapUrls={TEST_URLS} trackGeoJSON={null}
				nowMs={0} playing={false} onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a" radarSweep={false} trailMultiplier={1} />,
		);
		const map = FakeMap.last!;
		map.fire("load");
		ref.current!.zoomIn();
		expect(map.easeToCalls.at(-1)).toMatchObject({ zoom: 4 });
		ref.current!.zoomOut();
		expect(map.easeToCalls.at(-1)).toMatchObject({ zoom: 2 });
		ref.current!.flyTo([-74, 40.7], 13.5);
		expect(map.flyToCalls.at(-1)).toMatchObject({ center: [-74, 40.7], zoom: 13.5 });
		ref.current!.resetNorth();
		expect(map.easeToCalls.at(-1)).toMatchObject({ bearing: 0 });
	});

	it("switching mapStyle to satellite flips ground visibility without recreating the map", () => {
		const common = {
			positions: [pos({})], seedPositions: undefined, basemapUrls: TEST_URLS,
			trackGeoJSON: null, nowMs: 0, playing: false,
			pinColor: "#3a3a3a", notablePinColor: "#c0202a", radarSweep: false,
			trailMultiplier: 1, onSelectFlight: () => {}, onClearSelection: () => {},
		};
		const { rerender } = render(<FlightMap {...common} mapStyle="classic" darkMap={false} />);
		const map = FakeMap.last!;
		map.fire("load");
		rerender(<FlightMap {...common} mapStyle="satellite" darkMap={false} />);
		expect(FakeMap.last).toBe(map); // no setStyle/recreate
		expect(map.layout["satellite-day"].visibility).toBe("visible");
		expect(map.layout.land.visibility).toBe("none");
		rerender(<FlightMap {...common} mapStyle="satellite" darkMap={true} />);
		expect(map.layout["satellite-night"].visibility).toBe("visible");
		expect(map.layout["satellite-day"].visibility).toBe("none");
	});
});
