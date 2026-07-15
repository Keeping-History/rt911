import type { MotionBuffer } from "./flightMotion";
import { extrapolate } from "./flightMotion";
import { isNotable } from "./notableFlights";

// 3D altitude rendering (issue #224). MapLibre has no elevated symbol layers —
// icons are ground-clamped — so altitude renders natively as fill-extrusion
// geometry: a translucent "drop column" per plane, and a curtain wall under
// the selected flight's path (curtainToGeoJSON).

// Real-scale altitude is invisible at regional zooms (cruise ≈ 10 km against a
// ~1000 km viewport), so heights are exaggerated by a fixed factor.
export const ALT_EXAGGERATION = 10;
export const FT_TO_M = 0.3048;
// Half-width of a column's diamond footprint, in km.
export const COLUMN_HALF_KM = 1.5;
// Perpendicular thickness of a curtain-wall segment, in degrees latitude.
export const CURTAIN_OFFSET_DEG = 0.002;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Exaggerated metric height for an altitude in feet. */
export function exaggeratedHeightM(altFt: number): number {
	return altFt * FT_TO_M * ALT_EXAGGERATION;
}

/**
 * 4-vertex diamond as a closed ring (5 coords) centered on lon/lat. The
 * east/west half-width divides by cos(lat) so the footprint stays visually
 * square as latitude climbs.
 */
export function diamondRing(
	lon: number,
	lat: number,
	halfKm: number = COLUMN_HALF_KM,
): [number, number][] {
	const dLat = halfKm / KM_PER_DEG_LAT;
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	const dLon = halfKm / (KM_PER_DEG_LON_EQUATOR * cosLat);
	return [
		[lon + dLon, lat],
		[lon, lat + dLat],
		[lon - dLon, lat],
		[lon, lat - dLat],
		[lon + dLon, lat],
	];
}

/**
 * One extruded diamond per airborne flight at its extrapolated (gliding) head.
 * Properties: { flight, notable, height } — height in exaggerated meters for
 * fill-extrusion-height. Flights at/below ground level emit nothing.
 */
export function motionColumnsToGeoJSON(
	buffer: MotionBuffer,
	now: number,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	for (const m of buffer.values()) {
		if (m.item.alt_ft <= 0) continue;
		const head = extrapolate(m, now);
		features.push({
			type: "Feature",
			geometry: { type: "Polygon", coordinates: [diamondRing(head.lon, head.lat)] },
			properties: {
				flight: m.item.flight,
				notable: isNotable(m.item.flight),
				height: exaggeratedHeightM(m.item.alt_ft),
			},
		});
	}
	return { type: "FeatureCollection", features };
}

export interface AltitudeSample {
	lat: number;
	lon: number;
	alt_ft: number;
	utc: string;
}

/**
 * Curtain wall under a flight path: one thin extruded quad per consecutive
 * sample pair, height = the pair's max altitude (exaggerated meters). The
 * perpendicular offset gives each wall segment polygon area — a bare segment
 * would be degenerate. Returns an empty FC for null/short profiles.
 */
export function curtainToGeoJSON(
	profile: AltitudeSample[] | null,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	if (!profile || profile.length < 2) return { type: "FeatureCollection", features };
	for (let i = 1; i < profile.length; i++) {
		const a = profile[i - 1];
		const b = profile[i];
		const alt = Math.max(a.alt_ft, b.alt_ft);
		if (alt <= 0) continue;
		// Perpendicular to the segment in lat/lon space, normalized to
		// CURTAIN_OFFSET_DEG; degenerate (same-point) pairs fall back to a
		// north offset so the quad still has area.
		const dx = b.lon - a.lon;
		const dy = b.lat - a.lat;
		const len = Math.hypot(dx, dy);
		const ox = len > 0 ? (-dy / len) * CURTAIN_OFFSET_DEG : 0;
		const oy = len > 0 ? (dx / len) * CURTAIN_OFFSET_DEG : CURTAIN_OFFSET_DEG;
		features.push({
			type: "Feature",
			geometry: {
				type: "Polygon",
				coordinates: [[
					[a.lon, a.lat],
					[b.lon, b.lat],
					[b.lon + ox, b.lat + oy],
					[a.lon + ox, a.lat + oy],
					[a.lon, a.lat],
				]],
			},
			properties: { height: exaggeratedHeightM(alt) },
		});
	}
	return { type: "FeatureCollection", features };
}
