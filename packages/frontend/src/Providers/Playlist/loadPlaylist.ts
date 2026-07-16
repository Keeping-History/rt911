// Resolve-my-playlist seam. Today: id in the URL, anonymous Directus read.
// A future auth layer replaces only this module ("whatever playlist my teacher
// assigned"), leaving the provider/engine untouched.
import { parsePlaylist } from "./parsePlaylist";
import type { PlaylistDefinition } from "./playlistTypes";

export const DIRECTUS_URL: string =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

// uuid-shaped: letters, digits, hyphens. Anything else is ignored (no fetch).
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function playlistIdFromSearch(search: string): string | null {
	const id = new URLSearchParams(search).get("playlist");
	return id && ID_RE.test(id) ? id : null;
}

export interface LoadedPlaylist {
	title: string;
	definition: PlaylistDefinition;
	warnings: string[];
}

interface PlaylistRow {
	data?: { title?: unknown; status?: unknown; definition?: unknown };
}

// Exactly ONE request. Never add concurrent fetches here: parallel same-path
// requests to api-beta can return mixed response bodies (see useRouteIndex.ts).
export async function loadPlaylist(
	id: string,
	fetchFn: typeof fetch = fetch,
): Promise<LoadedPlaylist> {
	const fail = () => new Error("playlist-unavailable");
	let row: PlaylistRow;
	try {
		const res = await fetchFn(`${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}`);
		if (!res.ok) throw fail();
		row = (await res.json()) as PlaylistRow;
	} catch (err) {
		console.warn("playlist fetch failed:", err);
		throw fail();
	}
	if (row.data?.status !== "published") throw fail();
	const { definition, warnings } = parsePlaylist(row.data.definition);
	for (const w of warnings) console.warn("playlist:", w);
	if (!definition) throw fail();
	return { title: String(row.data.title ?? ""), definition, warnings };
}
