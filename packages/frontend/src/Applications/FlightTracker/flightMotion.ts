import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { isNotable } from "./notableFlights";

// How far ahead of its last sample a dot may be dead-reckoned before it holds —
// keeps a flight that stopped reporting (about to land / leave the set) from
// sailing off the map. ~1.5 samples.
export const MAX_EXTRAPOLATION_MS = 90_000;
// Length of the comet tail, in ms of travel behind the head.
export const TAIL_MS = 120_000;

export interface FlightMotion {
	prev: { lat: number; lon: number };
	cur: { lat: number; lon: number };
	prevT: number; // prev sample UTC ms
	curT: number; // cur sample UTC ms
	item: FlightPosition; // latest sample — supplies point properties
}

// Keyed by `flight` (callsign): the DB id changes each per-minute sample, the
// callsign is stable, and the airborne snapshot holds one row per flight.
export type MotionBuffer = Map<string, FlightMotion>;

// Fold the current airborne snapshot into the buffer: seed unseen flights
// (prev == cur → static until a 2nd sample gives a direction), shift cur→prev on
// a newer sample, refresh item props, and prune flights that left the set.
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
			});
		} else if (t > m.curT) {
			m.prev = m.cur;
			m.prevT = m.curT;
			m.cur = { lat: p.lat, lon: p.lon };
			m.curT = t;
			m.item = p;
		} else {
			m.item = p; // same/older sample: keep freshest props, don't shift
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

// Comet tail as [ [lon,lat] tail, [lon,lat] head ]; null when static.
export function tailSegment(
	m: FlightMotion,
	now: number,
): [[number, number], [number, number]] | null {
	const { vlat, vlon } = velocityOf(m);
	if (vlat === 0 && vlon === 0) return null;
	const head = extrapolate(m, now);
	const tail = { lat: head.lat - vlat * TAIL_MS, lon: head.lon - vlon * TAIL_MS };
	return [
		[tail.lon, tail.lat],
		[head.lon, head.lat],
	];
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

export function motionTrailsToGeoJSON(
	buffer: MotionBuffer,
	now: number,
): TrailFeatureCollection {
	const features: TrailFeatureCollection["features"] = [];
	for (const m of buffer.values()) {
		const seg = tailSegment(m, now);
		if (!seg) continue;
		features.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates: seg },
			properties: { notable: isNotable(m.item.flight) },
		});
	}
	return { type: "FeatureCollection", features };
}
