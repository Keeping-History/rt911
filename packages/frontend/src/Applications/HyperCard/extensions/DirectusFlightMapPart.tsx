import type { HyperCardPartProps } from "classicy";
import { useClassicyDateTime } from "classicy";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { MediaStreamContext } from "../../../Providers/MediaStream/MediaStreamContext";
import { virtualUtcMs } from "../../../Providers/MediaStream/virtualClock";
import { BASEMAP_URLS, type BasemapStyleId } from "../../../lib/basemap/basemapStyles";
import { FlightMap, type FlightMapHandle } from "../../FlightTracker/FlightMap";
import { isNotable } from "../../FlightTracker/notableFlights";
import "./DirectusFlightMapPart.css";

/**
 * `directusFlightMap` HyperCard part — a live plane map for the current virtual
 * instant, reusing the Flight Tracker's `FlightMap` (maplibre/WebGL). It shares
 * the desktop's single flight WebSocket channel (`MediaStreamContext`) and the
 * virtual clock, so planes move in lockstep with the rest of the desktop.
 *
 *   { "id": "map", "type": "directusFlightMap", "rect": [8, 32, 404, 240],
 *     "options": { "notablesOnly": true, "flight": "AA11", "mapStyle": "radar" } }
 *
 * Options: `notablesOnly` curates to the four hijacked flights; `flight` focuses
 * the camera on a callsign; `mapStyle`/`darkMap`/`radarSweep`/`trailMultiplier`
 * mirror the app's map settings; `pinColor`/`notablePinColor`/`observerPinColor`
 * override the pin colors; `buildingHeroColorLight`/`buildingHeroColorDark`
 * (packed 0xRRGGBB numbers) override the hero-landmark tint. Requires WebGL
 * and a sized card.
 */

const DEFAULT_PIN = "#f5a623";
const DEFAULT_NOTABLE_PIN = "#ff3b30";
const DEFAULT_OBSERVER_PIN = "#4a90d9";
// Mirrors FlightMap's own hero-landmark defaults (buildings.ts / flightMapSettings.ts).
const DEFAULT_HERO_COLOR_LIGHT = 0xb0a48c;
const DEFAULT_HERO_COLOR_DARK = 0xc7b8a0;

function readMapStyle(v: unknown): BasemapStyleId {
	return v === "radar" || v === "satellite" ? v : "classic";
}

export const DirectusFlightMapPart = ({ options, resolve, value, partId, stackId }: HyperCardPartProps) => {
	const focusFlight = useMemo(() => {
		const raw = typeof options.flight === "string" ? options.flight : value;
		const r = raw ? resolve(String(raw)).trim().toUpperCase() : "";
		return r || undefined;
	}, [options.flight, value, resolve]);
	const notablesOnly = options.notablesOnly === true;
	const mapStyle = readMapStyle(options.mapStyle);
	const darkMap = options.darkMap === true;
	const radarSweep = options.radarSweep === true;
	const trailMultiplier = typeof options.trailMultiplier === "number" ? options.trailMultiplier : 1;
	const pinColor = typeof options.pinColor === "string" ? options.pinColor : DEFAULT_PIN;
	const notablePinColor =
		typeof options.notablePinColor === "string" ? options.notablePinColor : DEFAULT_NOTABLE_PIN;
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

	// Fly the camera to a focused callsign once it first appears on the map.
	const mapApi = useRef<FlightMapHandle>(null);
	const flownFor = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!focusFlight) {
			flownFor.current = undefined;
			return;
		}
		if (flownFor.current === focusFlight) return;
		const pos = flightPositions.find((p) => p.flight === focusFlight);
		if (pos) {
			mapApi.current?.flyTo([pos.lon, pos.lat], 7);
			flownFor.current = focusFlight;
		}
	}, [focusFlight, flightPositions]);

	const noop = useCallback(() => {}, []);

	return (
		<div className="classicyHyperCardFlightMap">
			<FlightMap
				ref={mapApi}
				positions={positions}
				basemapUrls={BASEMAP_URLS}
				trackGeoJSON={null}
				nowMs={nowMs}
				playing={!paused}
				mapStyle={mapStyle}
				darkMap={darkMap}
				pinColor={pinColor}
				notablePinColor={notablePinColor}
				observerPinColor={observerPinColor}
				buildingHeroColorLight={buildingHeroColorLight}
				buildingHeroColorDark={buildingHeroColorDark}
				radarSweep={radarSweep}
				trailMultiplier={trailMultiplier}
				onSelectFlight={noop}
				onClearSelection={noop}
			/>
		</div>
	);
};
