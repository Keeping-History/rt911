import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import type { FlightFeatureCollection } from "./flightGeoJSON";
import { isNotable } from "./notableFlights";

// Time-indexed replay buffer for loop mode. Unlike MotionBuffer (stateful,
// strictly forward-in-time), this holds every sample in the window sorted by
// timestamp so the playhead can be scrubbed to any instant, backward or forward.

export interface ReplaySample {
	t: number; // UTC ms
	lat: number;
	lon: number;
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
		f.samples.splice(i, 0, { t, lat: p.lat, lon: p.lon });
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
): FlightFeatureCollection {
	const features: FlightFeatureCollection["features"] = [];
	for (const f of buffer.values()) {
		const s = f.samples;
		if (s.length === 0 || tMs < s[0].t || tMs > s[s.length - 1].t) continue;
		const i = lowerBound(s, tMs);
		let lat: number;
		let lon: number;
		if (s[i]?.t === tMs || i === 0) {
			({ lat, lon } = s[i]);
		} else {
			const a = s[i - 1];
			const b = s[i];
			const k = (tMs - a.t) / (b.t - a.t);
			lat = a.lat + (b.lat - a.lat) * k;
			lon = a.lon + (b.lon - a.lon) * k;
		}
		features.push({
			type: "Feature",
			id: f.id,
			geometry: { type: "Point", coordinates: [lon, lat] },
			properties: { ...f.props },
		});
	}
	return { type: "FeatureCollection", features };
}
