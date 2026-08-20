import { useEffect, useRef, useState } from "react";
import { directusGet } from "../../lib/directusQueue";

export type SpanPeaks = { id: number; startMs: number; endMs: number; peaks: number[][] };

interface Mp3ItemRow {
	id?: number;
	start_date?: string;
	calc_duration?: number;
	peaks?: number[][];
}

/**
 * How far back of the window the query reaches to catch a recording that was
 * already playing when the window opened.
 *
 * The overlap predicate we actually want is `start_date <= windowEnd AND
 * end_date >= windowStart`, but `mp3_items.end_date` is not in the anonymous
 * read policy (verified against production 2026-08-17: both projecting and
 * filtering on it return FORBIDDEN), so the end has to be reconstructed from
 * `start_date + calc_duration`. That can only be done client-side, which means
 * the server-side half of the predicate has to be a lookback wide enough that
 * no overlapping row is excluded before we see it. The longest recording in the
 * corpus is 8h18m (`aggregate[max]=calc_duration` = 29 880 s, same date), so
 * twelve hours clears it with room to spare; {@link overlappingSpans} then
 * applies the exact test to what comes back.
 */
const LOOKBACK_MS = 12 * 3_600_000;

/**
 * Row cap. Chosen to be unreachable rather than to truncate: the busiest
 * station in the corpus is `AA11` with 98 rows, and the whole `mp3_items` table
 * has 814 — 588 of which are approved, i.e. visible to this anonymous read
 * (production, 2026-08-17). So 200 cannot be hit by one station even over the
 * full ten-day span, while still bounding the payload, which carries a peaks
 * array per row (~4.1 KB of compact JSON each, ~400 KB for all 98 `AA11`
 * rows). A silent truncation would be indistinguishable from "nothing else
 * aired", which is why the cap is set out of reach instead of being surfaced.
 */
const ROW_LIMIT = 200;

/** Parse a Directus/UTC datetime string to epoch ms (append Z when tz-less). */
function toMs(value: string): number {
	const s = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
	return new Date(s).getTime();
}

/**
 * The rows that actually overlap `[windowStartMs, windowEndMs]`, as spans.
 *
 * Rows without an envelope are dropped: `peaks` is nullable and the backfill is
 * still running, and a missing preview is meant to be quiet. Rows without a
 * positive `calc_duration` are dropped for a different reason — with no
 * `end_date` available there is nothing to reconstruct an extent from, and a
 * zero-length span would render as a `width: 0%` slot: an invisible canvas that
 * looks identical to having drawn nothing, but costs a DOM node and a draw.
 *
 * Rows without a numeric `id` are dropped for a third reason: the id is the
 * slot's React key, and it is the ONLY unique thing about a row here.
 * `(source, start_date)` is not unique in production — 20 collision groups
 * across the corpus, 17 of them with differing durations (`UA93 @ 13:34:00` is
 * three recordings of 26 s, 86 s and 52 s) — so keying on the start instant
 * hands the reconciler indistinguishable siblings, and the next refetch that
 * changes the row set duplicates or omits them. `id` is projected explicitly
 * below and is anonymously readable, so this guard should never fire; it is
 * here so the uniqueness invariant is enforced where the span is built rather
 * than assumed where it is drawn.
 */
export function overlappingSpans(
	rows: Mp3ItemRow[],
	windowStartMs: number,
	windowEndMs: number,
): SpanPeaks[] {
	const out: SpanPeaks[] = [];
	for (const d of rows) {
		if (typeof d.id !== "number") continue;
		if (typeof d.start_date !== "string") continue;
		if (!Array.isArray(d.peaks) || d.peaks.length === 0) continue;
		const duration = d.calc_duration;
		if (typeof duration !== "number" || !(duration > 0)) continue;
		const startMs = toMs(d.start_date);
		const endMs = startMs + duration * 1000;
		if (endMs < windowStartMs || startMs > windowEndMs) continue;
		out.push({ id: d.id, startMs, endMs, peaks: d.peaks });
	}
	return out;
}

/**
 * Recordings that aired on `station` during the span, with their envelopes.
 *
 * A radio `MediaEntry` carries a station slug and a time window, not a
 * recording id (`playlistTypes.ts`: `itemId` is "station slug"), and a window
 * on that station can cover several `mp3_items` rows or none. So the preview
 * is assembled from whatever aired in the window — zero, one, or several
 * recordings, each drawn at its own time position — the same shape as the TV
 * thumbnail strip, which is also time-positioned rather than item-positioned.
 *
 * The span is the entry's own COMMITTED window, never the scroll viewport's.
 * Keying it on what is visible fired a fresh request per scroll frame, and
 * `directusGet` has no abort — the queue is a module-global FIFO, so a pan
 * parked ~60 unabortable requests in front of every other editor REST call.
 * The entry's window changes on selection and on an edge-drag commit, which is
 * exactly how often this should refetch.
 *
 * `mp3_items.source` is a relation to the station; filtering on
 * `source.slug` (not `source` itself) is required for the same reason
 * `stationLogos.ts` projects `source.slug` rather than `source`.
 */
export function usePeaksForSpan(
	station: string,
	startMs: number,
	endMs: number,
	fetchFn: typeof fetch = fetch,
): SpanPeaks[] {
	const [rows, setRows] = useState<SpanPeaks[]>([]);

	// Held in a ref, and deliberately NOT an effect dependency: callers pass an
	// injected fetch for tests, and an inline lambda (or a stubbed global) is a
	// new identity every render, which would refetch on every render forever.
	// The effect below only ever reads it at fire time.
	const fetchRef = useRef(fetchFn);
	useEffect(() => {
		fetchRef.current = fetchFn;
	}, [fetchFn]);

	useEffect(() => {
		let alive = true;
		const qs = new URLSearchParams({
			"filter[source][slug][_eq]": station,
			// URLSearchParams, never concatenation: a slug can contain a slash
			// (`NEADS/NORAD`) or other URL-significant characters.
			"filter[start_date][_between]": `${new Date(startMs - LOOKBACK_MS).toISOString()},${new Date(endMs).toISOString()}`,
			// `id` is not decoration: it is the only unique identity a row has
			// here, and the slots' React key. See {@link overlappingSpans}.
			fields: "id,start_date,calc_duration,peaks",
			limit: String(ROW_LIMIT),
			sort: "start_date",
		});
		directusGet(`/items/mp3_items?${qs.toString()}`, fetchRef.current)
			.then((data) => {
				if (!alive) return;
				setRows(overlappingSpans(data as Mp3ItemRow[], startMs, endMs));
			})
			.catch(() => {
				// A failed preview stays quiet rather than surfacing an error state.
				if (alive) setRows([]);
			});
		return () => {
			alive = false;
		};
	}, [station, startMs, endMs]);

	return rows;
}
