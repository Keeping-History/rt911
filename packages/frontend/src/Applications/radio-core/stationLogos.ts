/**
 * Station artwork keyed by source slug, read once from Directus.
 *
 * The streamed mp3 items carry their station's logo on `image`, but a station
 * only has items while it is on air or inside the reveal-buffer look-ahead —
 * and most broadcast stations hold a single recording, so they are dark for
 * most of the virtual day. The tuner still wants to show whose frequency it is
 * sitting on, so the slug → logo map is fetched separately and is
 * time-independent.
 *
 * This is static reference data: one anonymous REST read per page load, shared
 * by every caller through the module-level cache below. Failure is not an
 * error — an empty map just means callers fall back to the text call sign, so
 * a 403 (the `image` field missing from the public grant) or an offline
 * Directus degrades the display rather than breaking it.
 */
import { useEffect, useState } from "react";
import { DIRECTUS_URL } from "../../lib/endpoints";

export type StationLogos = Record<string, string>;

interface LogoRow {
	image?: string | null;
	source?: { slug?: string | null } | null;
}

const EMPTY: StationLogos = {};

// One shared in-flight promise: several apps mounting at once must not each
// issue the same query, and the resolved map is reused for the page's life.
let cached: Promise<StationLogos> | null = null;

/** Fetch the slug → logo map. Never rejects; resolves to {} on any failure. */
export async function fetchStationLogos(
	fetchFn: typeof fetch = fetch,
): Promise<StationLogos> {
	try {
		const res = await fetchFn(
			`${DIRECTUS_URL}/items/mp3_items?filter[image][_nnull]=true&fields=source.slug,image&limit=-1`,
		);
		if (!res.ok) return EMPTY;
		const body = (await res.json()) as { data?: LogoRow[] };
		const logos: StationLogos = {};
		for (const row of body.data ?? []) {
			const slug = row.source?.slug;
			// First row wins: every row of a station carries the same artwork
			// (apply-mp3-station-logos.mjs normalizes them), and a per-clip
			// override should not become the whole station's identity.
			if (slug && row.image && !logos[slug]) logos[slug] = row.image;
		}
		return logos;
	} catch {
		return EMPTY;
	}
}

/** Reset the shared cache. Tests only — production reads it once per load. */
export function resetStationLogosCache(): void {
	cached = null;
}

/**
 * The slug → logo map, `{}` until the fetch resolves. Components re-render
 * once when it arrives; nothing blocks on it.
 */
export function useStationLogos(): StationLogos {
	const [logos, setLogos] = useState<StationLogos>(EMPTY);

	useEffect(() => {
		let alive = true;
		if (!cached) cached = fetchStationLogos();
		cached.then((next) => {
			if (alive) setLogos(next);
		});
		return () => {
			alive = false;
		};
	}, []);

	return logos;
}
