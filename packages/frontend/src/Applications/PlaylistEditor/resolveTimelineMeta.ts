import type { EditorEntry } from "./editorState";
import { directusGet } from "./directusQueue";

export async function resolveTimelineMeta(
	entries: EditorEntry[],
	fetchFn?: typeof fetch,
): Promise<Map<string, EditorEntry["timelineMeta"]>> {
	const out = new Map<string, EditorEntry["timelineMeta"]>();
	for (const e of entries) {
		if (e.entry.kind !== "media" || e.timelineMeta !== undefined) continue;
		try {
			if (e.entry.app === "news") {
				const rows = (await directusGet(
					`/items/news_items/${encodeURIComponent(e.entry.itemId)}?fields=start_date`,
					fetchFn,
				)) as unknown as { start_date?: string };
				// single-item reads return an object, not an array
				const row = Array.isArray(rows) ? rows[0] : rows;
				if (row?.start_date) out.set(e.uid, { publishedAt: row.start_date });
			} else if (e.entry.app === "flights") {
				const rows = (await directusGet(
					`/items/flight_tracks?filter[flight][_eq]=${encodeURIComponent(e.entry.itemId)}&filter[flight_date][_eq]=2001-09-11&fields=wheels_off_utc,wheels_on_utc&limit=1`,
					fetchFn,
				)) as { wheels_off_utc: string | null; wheels_on_utc: string | null }[];
				if (rows[0]) out.set(e.uid, { departure: rows[0].wheels_off_utc, arrival: rows[0].wheels_on_utc });
			}
		} catch {
			// missing meta only degrades the timeline display; never block the editor
		}
	}
	return out;
}
