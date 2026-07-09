import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { isNotable } from "./notableFlights";

// How far ahead of its last sample a dot may be dead-reckoned before it holds —
// keeps a flight that stopped reporting (about to land / leave the set) from
// sailing off the map. ~1.5 samples.
export const MAX_EXTRAPOLATION_MS = 90_000;
// How many recent real positions each flight retains for its breadcrumb trail.
// At ~1 sample/minute this is ~20 minutes of path; older points are dropped and
// the trail fades to transparent, so the map stays clean over long sessions.
export const TRAIL_POINTS = 20;
// Upper bound of the user's trail-length multiplier (Settings slider). The
// buffer always RETAINS this many × TRAIL_POINTS so sliding the multiplier up
// lengthens tails instantly from history; the display length is applied when
// building the GeoJSON (motionTrailsToGeoJSON's displayPoints).
export const TRAIL_MULTIPLIER_MAX = 10;

export interface FlightMotion {
	prev: { lat: number; lon: number };
	cur: { lat: number; lon: number };
	prevT: number; // prev sample UTC ms
	curT: number; // cur sample UTC ms
	item: FlightPosition; // latest sample — supplies point properties
	// Last TRAIL_POINTS real positions as [lon,lat], oldest → newest.
	trail: [number, number][];
	// Direction of travel in degrees clockwise from north. Updated only when a
	// new sample actually moves the flight, so a static flight holds its last
	// heading instead of snapping to north. 0 until first movement.
	headingDeg: number;
}

// Keyed by `flight` (callsign): the DB id changes each per-minute sample, the
// callsign is stable, and the airborne snapshot holds one row per flight.
export type MotionBuffer = Map<string, FlightMotion>;

// Compass bearing from → to, degrees clockwise from north. Longitude is
// compressed by cos(midLat) so the bearing matches the on-screen direction
// (and the trail) at mid-latitudes, not the raw degree-space vector.
export function bearingDeg(
	from: { lat: number; lon: number },
	to: { lat: number; lon: number },
): number {
	const midLatRad = (((from.lat + to.lat) / 2) * Math.PI) / 180;
	const deg =
		(Math.atan2((to.lon - from.lon) * Math.cos(midLatRad), to.lat - from.lat) * 180) / Math.PI;
	return (deg + 360) % 360;
}

// Fold the current airborne snapshot into the buffer: seed unseen flights
// (prev == cur → static until a 2nd sample gives a direction), shift cur→prev and
// append to the breadcrumb on a newer sample, refresh item props on a same/older
// one, and prune flights that left the set.
export function updateMotion(
	buffer: MotionBuffer,
	positions: FlightPosition[],
): MotionBuffer {
	const seen = new Set<string>();
	for (const p of positions) {
		seen.add(p.flight);
		const t = Date.parse(p.start_date);
		const m = buffer.get(p.flight);
		if (!m) {
			buffer.set(p.flight, {
				prev: { lat: p.lat, lon: p.lon },
				cur: { lat: p.lat, lon: p.lon },
				prevT: t,
				curT: t,
				item: p,
				trail: [[p.lon, p.lat]],
				headingDeg: 0,
			});
		} else if (t > m.curT) {
			m.prev = m.cur;
			m.prevT = m.curT;
			m.cur = { lat: p.lat, lon: p.lon };
			m.curT = t;
			m.item = p;
			m.trail.push([p.lon, p.lat]);
			while (m.trail.length > TRAIL_POINTS * TRAIL_MULTIPLIER_MAX) m.trail.shift();
			if (m.cur.lat !== m.prev.lat || m.cur.lon !== m.prev.lon) {
				m.headingDeg = bearingDeg(m.prev, m.cur);
			}
		} else {
			m.item = p; // same/older sample: keep freshest props, don't shift or append
		}
	}
	for (const flight of buffer.keys()) {
		if (!seen.has(flight)) buffer.delete(flight);
	}
	return buffer;
}

export function velocityOf(m: FlightMotion): { vlat: number; vlon: number } {
	const dt = m.curT - m.prevT;
	if (dt <= 0) return { vlat: 0, vlon: 0 };
	return {
		vlat: (m.cur.lat - m.prev.lat) / dt,
		vlon: (m.cur.lon - m.prev.lon) / dt,
	};
}

// Forward dead-reckoning from the last sample, clamped so a stale flight holds.
export function extrapolate(m: FlightMotion, now: number): { lat: number; lon: number } {
	const { vlat, vlon } = velocityOf(m);
	const dt = Math.min(Math.max(now - m.curT, 0), MAX_EXTRAPOLATION_MS);
	return { lat: m.cur.lat + vlat * dt, lon: m.cur.lon + vlon * dt };
}

// Point FC of extrapolated heads — same shape flightsToGeoJSON emits, so the
// existing flights-dots / flights-notable layers consume it unchanged.
export function motionPointsToGeoJSON(
	buffer: MotionBuffer,
	now: number,
): FlightFeatureCollection {
	const features: FlightFeatureCollection["features"] = [];
	for (const m of buffer.values()) {
		const head = extrapolate(m, now);
		features.push({
			type: "Feature",
			id: m.item.id,
			geometry: { type: "Point", coordinates: [head.lon, head.lat] },
			properties: {
				flight: m.item.flight,
				carrier: m.item.carrier ?? "",
				alt_ft: m.item.alt_ft,
				phase: m.item.phase ?? "",
				notable: isNotable(m.item.flight),
				heading: m.headingDeg,
			},
		});
	}
	return { type: "FeatureCollection", features };
}

export interface TrailFeatureCollection {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "LineString"; coordinates: [number, number][] };
		properties: { notable: boolean };
	}>;
}

// Breadcrumb FC: each flight's real recent path (its retained trail) extended to
// the current gliding head, so the line connects the true track to the moving
// dot. A line-gradient (see flightMapStyle) fades it from transparent at the
// oldest end to opaque at the head. Flights with a single sample (no direction
// yet) emit nothing.
export function motionTrailsToGeoJSON(
	buffer: MotionBuffer,
	now: number,
	displayPoints: number = TRAIL_POINTS,
): TrailFeatureCollection {
	const features: TrailFeatureCollection["features"] = [];
	if (displayPoints <= 1) return { type: "FeatureCollection", features }; // tails off
	for (const m of buffer.values()) {
		if (m.trail.length < 2) continue;
		const head = extrapolate(m, now);
		features.push({
			type: "Feature",
			geometry: {
				type: "LineString",
				coordinates: [...m.trail.slice(-displayPoints), [head.lon, head.lat]],
			},
			properties: { notable: isNotable(m.item.flight) },
		});
	}
	return { type: "FeatureCollection", features };
}
