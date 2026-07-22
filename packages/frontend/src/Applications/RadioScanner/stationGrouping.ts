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

/**
 * Short "M/D, h:mm AM" label for an item's start instant, rendered in the
 * desktop's display timezone: shift the UTC epoch by tzOffsetHours and format
 * as UTC — the same trick as lib/loopClock.ts's formatPlayhead, so the label
 * matches the menu-bar clock for every visitor regardless of browser locale.
 */
export function startTimeLabel(item: MediaItem, tzOffsetHours: number): string {
	return new Date(
		toMs(item.start_date) + tzOffsetHours * 3_600_000,
	).toLocaleString("en-US", {
		timeZone: "UTC",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
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

/**
 * Up to `count` not-yet-started items for `station`, sorted earliest-first.
 * The default cap is generous (the streamer now feeds a ~50-minute mp3
 * look-ahead window) so the "Coming Up" list shows the station's full near-term
 * schedule rather than only the next few clips.
 */
export function upcomingSegments(
	station: Station,
	upcoming: MediaItem[],
	nowMs: number,
	count = 50,
): MediaItem[] {
	return upcoming
		.filter((item) => stationKey(item) === station.key && toMs(item.start_date) > nowMs)
		.sort((a, b) => toMs(a.start_date) - toMs(b.start_date))
		.slice(0, count);
}

export type StationStatus = "on-air" | "upcoming" | "offline";

/**
 * Indicator state for a station-strip button: on-air while any segment is
 * in-window (which wins even when more items are queued), otherwise upcoming
 * when a future item is waiting for the station, otherwise offline.
 */
export function stationStatus(
	station: Station,
	upcoming: MediaItem[],
	nowMs: number,
): StationStatus {
	if (activeSegments(station, nowMs).length > 0) return "on-air";
	const hasUpcoming = upcoming.some(
		(item) => stationKey(item) === station.key && toMs(item.start_date) > nowMs,
	);
	return hasUpcoming ? "upcoming" : "offline";
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

/** Membership test: does this item belong to any station in `keys`? */
function itemInKeys(item: MediaItem, keys: Set<string>): boolean {
	return keys.has(stationKey(item));
}

/**
 * Coming Up for several stations combined (the "All Traffic" view): every
 * not-yet-started item belonging to any of `stations`, earliest-first, capped.
 * Mirrors upcomingSegments but matches a set of stations instead of one.
 */
export function combinedUpcoming(
	stations: Station[],
	upcoming: MediaItem[],
	nowMs: number,
	count = 50,
): MediaItem[] {
	const keys = new Set(stations.map((s) => s.key));
	return upcoming
		.filter((item) => itemInKeys(item, keys) && toMs(item.start_date) > nowMs)
		.sort((a, b) => toMs(a.start_date) - toMs(b.start_date))
		.slice(0, count);
}

/**
 * Previous for several stations combined (the "All Traffic" view): every ended
 * item belonging to any of `stations`, most recent first. Mirrors
 * previousSegments but matches a set of stations instead of one.
 */
export function combinedPrevious(
	stations: Station[],
	history: MediaItem[],
	nowMs: number,
): MediaItem[] {
	const keys = new Set(stations.map((s) => s.key));
	return history
		.filter((item) => {
			if (!itemInKeys(item, keys)) return false;
			const end = effectiveEndMs(item);
			return end !== null && end <= nowMs;
		})
		.sort((a, b) => toMs(b.start_date) - toMs(a.start_date));
}

/** Stations pinned to the front of the strip regardless of online state. */
export const PINNED_STATIONS = ["WINS", "WCBS"];

// Strip order among non-pinned stations: on-air first (something playing now),
// then upcoming (queued but quiet), then offline (nothing). The "All Traffic"
// pseudo-station is appended by the view itself and is always last, so it is
// not part of this list.
const STATUS_RANK: Record<StationStatus, number> = {
	"on-air": 0,
	upcoming: 1,
	offline: 2,
};

/**
 * Display order for the station strip: pinned stations first (in
 * PINNED_STATIONS order), then the remaining stations by status — on-air, then
 * upcoming, then offline — each group keeping its incoming relative order.
 * `upcoming` is the reveal-buffer snapshot used to tell "upcoming" from
 * "offline" (same input stationStatus takes).
 */
export function sortStations(
	stations: Station[],
	upcoming: MediaItem[],
	nowMs: number,
): Station[] {
	const pinned = PINNED_STATIONS.flatMap((key) =>
		stations.filter((s) => s.key === key),
	);
	const rest = stations.filter((s) => !PINNED_STATIONS.includes(s.key));
	return [
		...pinned,
		...rest
			.map((s, i) => ({
				s,
				i,
				rank: STATUS_RANK[stationStatus(s, upcoming, nowMs)],
			}))
			// Stable within a rank: break ties by original index (Array.sort is
			// not guaranteed stable for all engines/inputs, so sort explicitly).
			.sort((a, b) => a.rank - b.rank || a.i - b.i)
			.map(({ s }) => s),
	];
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
