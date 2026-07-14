import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

export interface Station {
	key: string;
	label: string;
	items: MediaItem[];
}

/** Parse a Directus/UTC datetime string to epoch ms (append Z when tz-less). */
function toMs(value: string): number {
	const s = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
	return new Date(s).getTime();
}

/** The station a MediaItem belongs to: its source, or its title when blank. */
function stationKey(item: MediaItem): string {
	const src = item.source?.trim();
	return src && src.length > 0 ? src : item.title;
}

/** Effective end ms, or null when neither end_date nor calc_duration is known. */
function effectiveEndMs(item: MediaItem): number | null {
	if (item.end_date) return toMs(item.end_date);
	if (typeof item.calc_duration === "number") {
		return toMs(item.start_date) + item.calc_duration * 1000;
	}
	return null;
}

/** Seconds into the audio file that correspond to the given wall-clock time. */
export function calcSeekSeconds(item: MediaItem, clockMs: number): number {
	const raw = (clockMs - toMs(item.start_date)) / 1000 + item.jump;
	return Math.max(0, raw);
}

/**
 * MM:SS remaining until `item` starts, for the Coming Up countdown. Rounds up
 * to whole seconds (so it hits 00:00 exactly at the start instant, never a
 * second early) and clamps at 00:00 once the start has passed. Minutes keep
 * counting past 59 (e.g. "75:07") rather than rolling into hours.
 */
export function countdownLabel(item: MediaItem, nowMs: number): string {
	const totalSeconds = Math.max(
		0,
		Math.ceil((toMs(item.start_date) - nowMs) / 1000),
	);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Group items into stations keyed by source (title fallback), first-seen order. */
export function groupStations(items: MediaItem[]): Station[] {
	const order: string[] = [];
	const byKey = new Map<string, Station>();
	for (const item of items) {
		const key = stationKey(item);
		let station = byKey.get(key);
		if (!station) {
			station = { key, label: key, items: [] };
			byKey.set(key, station);
			order.push(key);
		}
		station.items.push(item);
	}
	return order.map((k) => byKey.get(k) as Station);
}

/** Every segment whose window contains nowMs (start ≤ now < effectiveEnd). */
export function activeSegments(station: Station, nowMs: number): MediaItem[] {
	return station.items.filter((item) => {
		if (nowMs < toMs(item.start_date)) return false;
		const end = effectiveEndMs(item);
		return end === null ? true : nowMs < end;
	});
}

/** The segment to attach the waveform to: the latest-starting in-window one. */
export function primarySegment(segments: MediaItem[]): MediaItem | null {
	if (segments.length === 0) return null;
	return segments.reduce((best, cur) =>
		toMs(cur.start_date) > toMs(best.start_date) ? cur : best,
	);
}

/** Up to `count` not-yet-started items for `station`, sorted earliest-first. */
export function upcomingSegments(
	station: Station,
	upcoming: MediaItem[],
	nowMs: number,
	count = 5,
): MediaItem[] {
	return upcoming
		.filter((item) => stationKey(item) === station.key && toMs(item.start_date) > nowMs)
		.sort((a, b) => toMs(a.start_date) - toMs(b.start_date))
		.slice(0, count);
}

/** Every ended item for `station` from the history list, most recent first. */
export function previousSegments(
	station: Station,
	history: MediaItem[],
	nowMs: number,
): MediaItem[] {
	return history
		.filter((item) => {
			if (stationKey(item) !== station.key) return false;
			const end = effectiveEndMs(item);
			return end !== null && end <= nowMs;
		})
		.sort((a, b) => toMs(b.start_date) - toMs(a.start_date));
}

/** Stations pinned to the front of the strip regardless of online state. */
export const PINNED_STATIONS = ["WINS", "WCBS"];

/**
 * Display order for the station strip: pinned stations first (in
 * PINNED_STATIONS order), then the remaining online stations, then offline
 * ones — each group keeping its incoming relative order.
 */
export function sortStations(stations: Station[], nowMs: number): Station[] {
	const pinned = PINNED_STATIONS.flatMap((key) =>
		stations.filter((s) => s.key === key),
	);
	const rest = stations.filter((s) => !PINNED_STATIONS.includes(s.key));
	const online = rest.filter((s) => activeSegments(s, nowMs).length > 0);
	const offline = rest.filter((s) => activeSegments(s, nowMs).length === 0);
	return [...pinned, ...online, ...offline];
}

/**
 * Build the full station list from the time-independent audio source catalogue,
 * overlaying active items. Sources with no active items have an empty items array
 * (OFFLINE). Sources that appear in items but not in audioSources are appended at
 * the end (defensive — should not happen in practice).
 */
export function mergeWithSources(audioSources: string[], items: MediaItem[]): Station[] {
	const order: string[] = [...audioSources];
	const byKey = new Map<string, Station>();
	for (const key of audioSources) {
		byKey.set(key, { key, label: key, items: [] });
	}
	for (const it of items) {
		const key = stationKey(it);
		if (!byKey.has(key)) {
			byKey.set(key, { key, label: key, items: [] });
			order.push(key);
		}
		(byKey.get(key) as Station).items.push(it);
	}
	return order.map((k) => byKey.get(k) as Station);
}
