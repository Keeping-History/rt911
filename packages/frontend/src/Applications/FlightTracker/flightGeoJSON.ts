import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { isNotable } from "./notableFlights";

export interface FlightFeature {
	type: "Feature";
	id: number;
	geometry: { type: "Point"; coordinates: [number, number] };
	properties: {
		flight: string;
		carrier: string;
		alt_ft: number;
		phase: string;
		notable: boolean;
		// Degrees clockwise from north; drives the plane icons' icon-rotate.
		heading: number;
		// Airframe family (aircraftModels.AircraftFamily) — drives the
		// per-family 2D silhouette via the layers' data-driven icon-image.
		family: string;
	};
}

export interface FlightFeatureCollection {
	type: "FeatureCollection";
	features: FlightFeature[];
}

// Project the current airborne set into a GeoJSON FeatureCollection for a
// MapLibre geojson source. Coordinates are [lon, lat] (GeoJSON order). The
// `notable` prop drives the always-on highlight layer's filter.
export function flightsToGeoJSON(positions: FlightPosition[]): FlightFeatureCollection {
	return {
		type: "FeatureCollection",
		features: positions.map((p) => ({
			type: "Feature",
			id: p.id,
			geometry: { type: "Point", coordinates: [p.lon, p.lat] },
			properties: {
				flight: p.flight,
				carrier: p.carrier ?? "",
				alt_ft: p.alt_ft,
				phase: p.phase ?? "",
				notable: isNotable(p.flight),
				heading: 0, // static builder — no velocity context
				family: "generic", // static builder — no route-index context
			},
		})),
	};
}
