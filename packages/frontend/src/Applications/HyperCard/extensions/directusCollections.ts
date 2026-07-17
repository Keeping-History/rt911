// Directus-collection access for HyperCard extensions.
//
// HyperCard stacks are pure, portable JSON (see classicy's HyperCardModel). A
// stack cannot fetch — so an *extension part* (registerHyperCardPart) does the
// fetching at render time and paints the result into the card. This module is
// the shared read seam every collection-backed part uses: one anonymous REST
// GET per embedded item, same direct-Directus pattern as
// README/useReadmeArticles.ts and Playlist/loadPlaylist.ts (reference data that
// bypasses the streamer entirely).

// Same env seam every other Directus caller uses; re-exported for parts.
export { DIRECTUS_URL } from "../../../Providers/Playlist/loadPlaylist";
import { DIRECTUS_URL } from "../../../Providers/Playlist/loadPlaylist";

/**
 * A minimal registry describing which Directus collections HyperCard stacks may
 * embed and the fields each part needs. Adding a new embeddable collection
 * (video, images, PDFs, …) is a one-line entry here plus a matching part
 * component — the fetch/plumbing below is collection-agnostic.
 */
export const DIRECTUS_COLLECTIONS = {
	/** Historical audio clips (radio, calls, broadcasts) — the mp3 pipeline. */
	audio: {
		collection: "mp3_items",
		fields: [
			"id",
			"title",
			"full_title",
			"url",
			"source",
			"start_date",
			"calc_duration",
			"subtitles",
		],
	},
	/**
	 * Stitched continuous TV channel streams (one HLS row per channel). The
	 * `start_date`/`end_date` span the whole assembled broadcast window and the
	 * stream is continuous across it, so a wall-clock instant inside that window
	 * maps to a stream offset of `(instant − start_date)` seconds.
	 */
	video: {
		collection: "tv_channels",
		fields: [
			"id",
			"title",
			"full_title",
			"url",
			"source",
			"start_date",
			"end_date",
			"calc_duration",
			"timezone",
			"subtitles",
		],
	},
} as const;

export type DirectusCollectionKey = keyof typeof DIRECTUS_COLLECTIONS;

/** One row of the `mp3_items` collection — the subset a stack embed reads. */
export interface DirectusAudioItem {
	id: number;
	title: string;
	full_title?: string | null;
	url: string;
	source?: string | null;
	start_date?: string | null;
	calc_duration?: number | null;
	subtitles?: string | null;
}

interface ItemEnvelope<T> {
	data?: T;
}

/**
 * Fetch a single item from a Directus collection by id.
 *
 * One request per call. Never batch these onto the same path concurrently:
 * api-beta can interleave response bodies under parallel same-path requests
 * (see README/useReadmeArticles.ts and FlightTracker/useRouteIndex.ts) — each
 * embed owning its own distinct `/items/<collection>/<id>` path avoids that.
 */
export async function fetchDirectusItem<T>(
	collection: string,
	id: string | number,
	fields: readonly string[],
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<T> {
	const url =
		`${DIRECTUS_URL}/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}` +
		`?fields=${fields.map(encodeURIComponent).join(",")}`;
	const res = await fetchFn(url, { signal });
	if (!res.ok) throw new Error(`Directus ${collection}/${id}: HTTP ${res.status}`);
	const body = (await res.json()) as ItemEnvelope<T>;
	if (body.data == null) throw new Error(`Directus ${collection}/${id}: not found`);
	return body.data;
}

/** Fetch one `mp3_items` row by id, projecting the audio-embed field set. */
export function fetchDirectusAudioItem(
	id: string | number,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<DirectusAudioItem> {
	const { collection, fields } = DIRECTUS_COLLECTIONS.audio;
	return fetchDirectusItem<DirectusAudioItem>(collection, id, fields, fetchFn, signal);
}

/** One row of the `tv_channels` collection — the subset a video embed reads. */
export interface DirectusVideoItem {
	id: number;
	title: string;
	full_title?: string | null;
	/** HLS (`.m3u8`) URL of the continuous channel stream. */
	url: string;
	source?: string | null;
	/** Start of the assembled broadcast window (the offset origin for seeks). */
	start_date?: string | null;
	end_date?: string | null;
	calc_duration?: number | null;
	timezone?: string | null;
	subtitles?: string | null;
}

/** Fetch one `tv_channels` row by id, projecting the video-embed field set. */
export function fetchDirectusVideoItem(
	id: string | number,
	fetchFn: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<DirectusVideoItem> {
	const { collection, fields } = DIRECTUS_COLLECTIONS.video;
	return fetchDirectusItem<DirectusVideoItem>(collection, id, fields, fetchFn, signal);
}
