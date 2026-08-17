import { useEffect, useState } from "react";
import { directusGet } from "./directusQueue";

export type SpanPeaks = { startMs: number; endMs: number; peaks: number[][] };

interface Mp3ItemRow {
	start_date?: string;
	calc_duration?: number;
	peaks?: number[][];
}

/** Parse a Directus/UTC datetime string to epoch ms (append Z when tz-less). */
function toMs(value: string): number {
	const s = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
	return new Date(s).getTime();
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

	useEffect(() => {
		let alive = true;
		const qs = new URLSearchParams({
			"filter[source][slug][_eq]": station,
			"filter[start_date][_between]": `${new Date(startMs).toISOString()},${new Date(endMs).toISOString()}`,
			fields: "start_date,calc_duration,peaks",
			limit: "20",
			sort: "start_date",
		});
		directusGet(`/items/mp3_items?${qs.toString()}`, fetchFn)
			.then((data) => {
				if (!alive) return;
				setRows(
					(data as Mp3ItemRow[])
						.filter((d): d is Mp3ItemRow & { start_date: string; peaks: number[][] } =>
							typeof d.start_date === "string" && Array.isArray(d.peaks) && d.peaks.length > 0,
						)
						.map((d) => {
							const start = toMs(d.start_date);
							return {
								startMs: start,
								endMs: start + (d.calc_duration ?? 0) * 1000,
								peaks: d.peaks,
							};
						}),
				);
			})
			.catch(() => {
				// A failed preview stays quiet rather than surfacing an error state.
				if (alive) setRows([]);
			});
		return () => {
			alive = false;
		};
	}, [station, startMs, endMs, fetchFn]);

	return rows;
}
