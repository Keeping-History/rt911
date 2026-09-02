import type { HyperCardPartProps } from "classicy";
import { useClassicyDateTime } from "classicy";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { MediaStreamContext, type FlightPosition } from "../../../Providers/MediaStream/MediaStreamContext";
import { virtualUtcMs } from "../../../Providers/MediaStream/virtualClock";
import { BASEMAP_URLS, type BasemapStyleId } from "../../../lib/basemap/basemapStyles";
import { FlightMap, type FlightMapHandle } from "../../FlightTracker/FlightMap";
import { isNotable } from "../../FlightTracker/notableFlights";
import { HyperCardPartGrid } from "./HyperCardPartGrid";
import { resolveItemIds } from "./useDirectusItem";
import "./DirectusFlightMapPart.css";

/**
 * `directusFlightMap` HyperCard part — a live plane map for the current virtual
 * instant, reusing the Flight Tracker's `FlightMap` (maplibre/WebGL). It shares
 * the desktop's single flight WebSocket channel (`MediaStreamContext`) and the
 * virtual clock, so planes move in lockstep with the rest of the desktop.
 *
 *   { "id": "map", "type": "directusFlightMap", "rect": [8, 32, 404, 240],
 *     "options": { "notablesOnly": true, "flight": ["AA11"], "mapStyle": "radar" } }
 *
 * Options: `notablesOnly` curates to the four hijacked flights; `flight` is an
 * array of callsigns to focus (issue #560's `FlightMapPicker` always writes
 * one), but a bare scalar/variable callsign is still accepted for a part
 * authored before that change. Zero or one resolved callsign renders exactly
 * as before — a single map, optionally focused; two or more lay out as a
 * `DirectusMultiviewPart`-style grid, one map per focused callsign, each
 * still showing every position on the shared channel.
 * `mapStyle`/`darkMap`/`radarSweep`/`trailMultiplier` mirror the app's map
 * settings; `pinColor`/`notablePinColor`/`observerPinColor` override the pin
 * colors; `buildingHeroColorLight`/`buildingHeroColorDark` (packed 0xRRGGBB
 * numbers) override the hero-landmark tint. Requires WebGL and a sized card.
 */

const DEFAULT_PIN = "#f5a623";
const DEFAULT_NOTABLE_PIN = "#ff3b30";
const DEFAULT_OBSERVER_PIN = "#4a90d9";
const DEFAULT_ANON_PIN = "#8b7d6b";
// Mirrors FlightMap's own hero-landmark defaults (buildings.ts / flightMapSettings.ts).
const DEFAULT_HERO_COLOR_LIGHT = 0xb0a48c;
const DEFAULT_HERO_COLOR_DARK = 0xc7b8a0;

function readMapStyle(v: unknown): BasemapStyleId {
	return v === "radar" || v === "satellite" ? v : "classic";
}

/** Resolves `flight` into a list of callsigns to focus — array-valued per issue #560, with a single legacy scalar/variable still accepted; unset/empty means "no focus". */
function readFocusFlights(
	options: Record<string, unknown>,
	value: string,
	resolve: (expr: string) => string,
): string[] {
	return resolveItemIds(options.flight, value, resolve)
		.map((f) => f.toUpperCase())
		.filter((f) => f !== "");
}

interface FlightMapTileProps {
	focusFlight: string | undefined;
	positions: FlightPosition[];
	nowMs: number;
	playing: boolean;
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	pinColor: string;
	notablePinColor: string;
	anonPinColor: string;
	observerPinColor: string;
	buildingHeroColorLight: number;
	buildingHeroColorDark: number;
	radarSweep: boolean;
	trailMultiplier: number;
}

/** One map instance — split out so a multi-flight embed can render several, each flying to its own focused callsign. */
function FlightMapTile({ focusFlight, positions, ...mapSettings }: FlightMapTileProps) {
	// Fly the camera to a focused callsign once it first appears on the map.
	const mapApi = useRef<FlightMapHandle>(null);
	const flownFor = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!focusFlight) {
			flownFor.current = undefined;
			return;
		}
		if (flownFor.current === focusFlight) return;
		const pos = positions.find((p) => p.flight === focusFlight);
		if (pos) {
			mapApi.current?.flyTo([pos.lon, pos.lat], 7);
			flownFor.current = focusFlight;
		}
	}, [focusFlight, positions]);

	const noop = useCallback(() => {}, []);

	return (
		<FlightMap
			ref={mapApi}
			positions={positions}
			basemapUrls={BASEMAP_URLS}
			trackGeoJSON={null}
			{...mapSettings}
			onSelectFlight={noop}
			onClearSelection={noop}
		/>
	);
}

/**
 * Zero or one resolved `flight` renders exactly as before (a single map,
 * optionally focused); two or more lay out as a grid of maps, one per focused
 * callsign, all sharing the same position feed and map settings (issue #560).
 */
export const DirectusFlightMapPart = ({ options, resolve, value, partId, stackId }: HyperCardPartProps) => {
	const focusFlights = useMemo(() => readFocusFlights(options, value, resolve), [options, value, resolve]);
	const notablesOnly = options.notablesOnly === true;
	const mapStyle = readMapStyle(options.mapStyle);
	const darkMap = options.darkMap === true;
	const radarSweep = options.radarSweep === true;
	const trailMultiplier = typeof options.trailMultiplier === "number" ? options.trailMultiplier : 1;
	const pinColor = typeof options.pinColor === "string" ? options.pinColor : DEFAULT_PIN;
	const notablePinColor =
		typeof options.notablePinColor === "string" ? options.notablePinColor : DEFAULT_NOTABLE_PIN;
	const anonPinColor =
		typeof options.anonPinColor === "string" ? options.anonPinColor : DEFAULT_ANON_PIN;
	const observerPinColor =
		typeof options.observerPinColor === "string" ? options.observerPinColor : DEFAULT_OBSERVER_PIN;
	const buildingHeroColorLight =
		typeof options.buildingHeroColorLight === "number"
			? options.buildingHeroColorLight
			: DEFAULT_HERO_COLOR_LIGHT;
	const buildingHeroColorDark =
		typeof options.buildingHeroColorDark === "number" ? options.buildingHeroColorDark : DEFAULT_HERO_COLOR_DARK;

	const { flightPositions, subscribeFlights, unsubscribeFlights } = useContext(MediaStreamContext);

	const appId = `hc-flight-${stackId}-${partId}`;
	useEffect(() => {
		subscribeFlights(appId);
		return () => unsubscribeFlights(appId);
	}, [subscribeFlights, unsubscribeFlights, appId]);

	// Read-only clock → true-UTC instant + play state (same as FlightTracker).
	const { localDate, tzOffset, paused } = useClassicyDateTime({ tick: true });
	const nowMs = virtualUtcMs(localDate, tzOffset);

	const positions = useMemo(
		() => (notablesOnly ? flightPositions.filter((p) => isNotable(p.flight)) : flightPositions),
		[flightPositions, notablesOnly],
	);

	const mapSettings = {
		positions,
		nowMs,
		playing: !paused,
		mapStyle,
		darkMap,
		pinColor,
		notablePinColor,
		anonPinColor,
		observerPinColor,
		buildingHeroColorLight,
		buildingHeroColorDark,
		radarSweep,
		trailMultiplier,
	};

	if (focusFlights.length <= 1) {
		return (
			<div className="classicyHyperCardFlightMap">
				<FlightMapTile focusFlight={focusFlights[0]} {...mapSettings} />
			</div>
		);
	}

	return (
		<HyperCardPartGrid
			className="classicyHyperCardFlightMap"
			items={focusFlights}
			getKey={(flight, i) => `${flight}-${i}`}
			renderItem={(flight) => <FlightMapTile focusFlight={flight} {...mapSettings} />}
		/>
	);
};
