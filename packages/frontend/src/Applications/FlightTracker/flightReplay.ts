import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { exaggeratedHeightM } from "./flightAltitude";
import { isNotable } from "./notableFlights";
import {
	PLANE_INSTANCE_STRIDE,
	type PlaneInstances,
	lngLatToMercator,
	mercatorPerMeter,
} from "./plane3dMesh";

// Time-indexed replay buffer for loop mode. Unlike MotionBuffer (stateful,
// strictly forward-in-time), this holds every sample in the window sorted by
// timestamp so the playhead can be scrubbed to any instant, backward or forward.

export interface ReplaySample {
	t: number; // UTC ms
	lat: number;
	lon: number;
	alt_ft: number; // per-sample so 3D replay trails float at the replayed altitude
}

export interface ReplayFlight {
	samples: ReplaySample[]; // sorted by t, unique t
	// Replay-trail-point properties, refreshed from the latest-inserted sample; the
	// replay-trail layers only style by `notable`, the rest satisfies the shared FC shape.
	props: {
		flight: string;
		carrier: string;
		alt_ft: number;
		phase: string;
		notable: boolean;
	};
	id: number; // stable feature id (latest sample's row id)
}

export type ReplayBuffer = Map<string, ReplayFlight>;

// Index of the first sample with t >= target (lower bound).
function lowerBound(samples: ReplaySample[], target: number): number {
	let lo = 0;
	let hi = samples.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (samples[mid].t < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// Insert positions (history chunks or live promotions) into the buffer.
// Idempotent — a sample whose timestamp already exists for its flight is
// skipped — so re-feeding an already-seen batch is safe, and sorted insertion
// makes out-of-order arrival (history chunks racing live frames) a non-event.
export function insertReplaySamples(
	buffer: ReplayBuffer,
	positions: FlightPosition[],
): void {
	for (const p of positions) {
		const t = Date.parse(p.start_date);
		let f = buffer.get(p.flight);
		if (!f) {
			f = {
				samples: [],
				props: {
					flight: p.flight,
					carrier: p.carrier ?? "",
					alt_ft: p.alt_ft,
					phase: p.phase ?? "",
					notable: isNotable(p.flight),
				},
				id: p.id,
			};
			buffer.set(p.flight, f);
		}
		const i = lowerBound(f.samples, t);
		if (f.samples[i]?.t === t) continue; // duplicate sample
		f.samples.splice(i, 0, { t, lat: p.lat, lon: p.lon, alt_ft: p.alt_ft });
		if (i === f.samples.length - 1) {
			// Newest sample so far: refresh the display properties.
			f.props.carrier = p.carrier ?? "";
			f.props.alt_ft = p.alt_ft;
			f.props.phase = p.phase ?? "";
			f.id = p.id;
		}
	}
}

// Drop samples older than the sliding window's trailing edge; a flight left
// with no samples is removed entirely.
export function pruneReplay(buffer: ReplayBuffer, oldestMs: number): void {
	for (const [flight, f] of buffer) {
		const i = lowerBound(f.samples, oldestMs);
		if (i > 0) f.samples.splice(0, i);
		if (f.samples.length === 0) buffer.delete(flight);
	}
}

// Replay-trail points at playhead tMs: each flight whose sampled lifetime contains tMs
// contributes one linearly-interpolated point. No dead-reckoning beyond the
// first/last sample — aircraft appear and disappear mid-loop, matching reality.
export function replayPointsAt(
	buffer: ReplayBuffer,
	tMs: number,
	// Draw-time filter (issue #188): replay trails of hidden flights are skipped, the
	// buffer itself stays complete so clearing the filter restores them instantly.
	visible: Set<string> | null = null,
): FlightFeatureCollection {
	const features: FlightFeatureCollection["features"] = [];
	for (const [flight, f] of buffer) {
		if (visible && !visible.has(flight)) continue;
		const at = replaySampleAt(f, tMs);
		if (!at) continue;
		features.push({
			type: "Feature",
			id: f.id,
			geometry: { type: "Point", coordinates: [at.lon, at.lat] },
			// heading: replay-trail layers are circles, not rotated plane icons.
			properties: { ...f.props, heading: 0, family: "generic" },
		});
	}
	return { type: "FeatureCollection", features };
}

// Interpolated fix (position + altitude) for one flight at playhead tMs, or
// null when tMs is outside its sampled lifetime.
function replaySampleAt(
	f: ReplayFlight,
	tMs: number,
): { lat: number; lon: number; alt_ft: number } | null {
	const s = f.samples;
	if (s.length === 0 || tMs < s[0].t || tMs > s[s.length - 1].t) return null;
	const i = lowerBound(s, tMs);
	if (s[i]?.t === tMs || i === 0) {
		return { lat: s[i].lat, lon: s[i].lon, alt_ft: s[i].alt_ft };
	}
	const a = s[i - 1];
	const b = s[i];
	const k = (tMs - a.t) / (b.t - a.t);
	return {
		lat: a.lat + (b.lat - a.lat) * k,
		lon: a.lon + (b.lon - a.lon) * k,
		alt_ft: a.alt_ft + (b.alt_ft - a.alt_ft) * k,
	};
}

/**
 * 3D replay-trail spheres (mercator): each replayed flight packed at its interpolated
 * fix into the shared custom-layer instance layout (PLANE_INSTANCE_STRIDE).
 * Spheres are rotation-invariant so heading/pitch stay 0; halfSize carries the
 * sphere radius in meters. radiusKm comes from the same zoom-scaled sizing as
 * the 3D planes.
 */
export function buildReplayTrailInstances(
	buffer: ReplayBuffer,
	tMs: number,
	visible: Set<string> | null,
	radiusKm: number,
): PlaneInstances {
	const data = new Float32Array(buffer.size * PLANE_INSTANCE_STRIDE);
	const flights: string[] = [];
	let count = 0;
	for (const [flight, f] of buffer) {
		if (visible && !visible.has(flight)) continue;
		const at = replaySampleAt(f, tMs);
		if (!at || at.alt_ft <= 0) continue;
		const [mx, my] = lngLatToMercator(at.lon, at.lat);
		const o = count * PLANE_INSTANCE_STRIDE;
		data[o] = mx;
		data[o + 1] = my;
		data[o + 2] = exaggeratedHeightM(at.alt_ft);
		data[o + 3] = mercatorPerMeter(at.lat);
		data[o + 6] = radiusKm * 1000;
		data[o + 7] = f.props.notable ? 1 : 0;
		flights.push(flight);
		count++;
	}
	return { data: data.subarray(0, count * PLANE_INSTANCE_STRIDE), count, flights };
}

