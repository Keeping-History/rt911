import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { discRing, exaggeratedHeightM } from "./flightAltitude";
import { isNotable } from "./notableFlights";

// Time-indexed replay buffer for loop mode. Unlike MotionBuffer (stateful,
// strictly forward-in-time), this holds every sample in the window sorted by
// timestamp so the playhead can be scrubbed to any instant, backward or forward.

export interface ReplaySample {
	t: number; // UTC ms
	lat: number;
	lon: number;
	alt_ft: number; // per-sample so 3D ghosts float at the replayed altitude
}

export interface ReplayFlight {
	samples: ReplaySample[]; // sorted by t, unique t
	// Ghost-point properties, refreshed from the latest-inserted sample; the
	// ghost layers only style by `notable`, the rest satisfies the shared FC shape.
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

// Ghost points at playhead tMs: each flight whose sampled lifetime contains tMs
// contributes one linearly-interpolated point. No dead-reckoning beyond the
// first/last sample — aircraft appear and disappear mid-loop, matching reality.
export function replayPointsAt(
	buffer: ReplayBuffer,
	tMs: number,
	// Draw-time filter (issue #188): ghosts of hidden flights are skipped, the
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
			// heading: ghost layers are circles, not rotated plane icons.
			properties: { ...f.props, heading: 0 },
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
 * 3D ghosts: while the camera is pitched, each replayed flight renders as a
 * small extruded disc ("sphere" at dot scale — true spheres would need a
 * custom WebGL layer) floating at its interpolated altitude. radiusKm comes
 * from the same zoom-scaled sizing as the 3D planes.
 */
export function replayGhosts3DAt(
	buffer: ReplayBuffer,
	tMs: number,
	visible: Set<string> | null,
	radiusKm: number,
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	const rM = radiusKm * 1000;
	for (const [flight, f] of buffer) {
		if (visible && !visible.has(flight)) continue;
		const at = replaySampleAt(f, tMs);
		if (!at || at.alt_ft <= 0) continue;
		const altM = exaggeratedHeightM(at.alt_ft);
		features.push({
			type: "Feature",
			id: f.id,
			geometry: { type: "Polygon", coordinates: [discRing(at.lon, at.lat, radiusKm)] },
			properties: {
				flight: f.props.flight,
				notable: f.props.notable,
				base: Math.max(altM - rM, 0),
				height: altM + rM,
			},
		});
	}
	return { type: "FeatureCollection", features };
}
