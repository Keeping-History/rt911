import { useEffect, useState } from "react";

// A Time Machine bookmark: a labelled moment the desktop clock can jump to.
// `start_date` is a Directus datetime (UTC wall-clock, no timezone suffix).
export interface Bookmark {
	id:         number;
	title:      string;
	full_title: string | null;
	start_date: string;
}

export interface BookmarksState {
	bookmarks: Bookmark[];
	loading:   boolean;
	error:     string | null;
}

// Bookmarks are static reference data (the whole list is needed up-front to jump
// around), so — unlike playback data — they are read straight from Directus over
// REST rather than streamed through the MediaStream WebSocket. This mirrors the
// Feedback app's direct HTTP call and does not touch the streamer.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api-beta.911realtime.org";

const BOOKMARKS_URL =
	`${DIRECTUS_URL}/items/tm_bookmarks` +
	"?filter[approved][_eq]=1&sort=sort,start_date&fields=id,title,full_title,start_date&limit=-1";

export function useBookmarks(): BookmarksState {
	const [state, setState] = useState<BookmarksState>({ bookmarks: [], loading: true, error: null });

	useEffect(() => {
		const controller = new AbortController();

		fetch(BOOKMARKS_URL, { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = (await res.json()) as { data: Bookmark[] };
				setState({ bookmarks: json.data, loading: false, error: null });
			})
			.catch((err: unknown) => {
				if (controller.signal.aborted) return;
				setState({ bookmarks: [], loading: false, error: err instanceof Error ? err.message : String(err) });
			});

		return () => controller.abort();
	}, []);

	return state;
}
