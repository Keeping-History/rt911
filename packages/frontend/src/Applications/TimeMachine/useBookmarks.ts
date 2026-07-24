import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import type { PersonalBookmark } from "./bookmarksApi";
import { DIRECTUS_URL } from "../../Providers/Playlist/loadPlaylist";

// A global (admin) Time Machine bookmark: a labelled moment the clock can jump
// to. `start_date` is a bare UTC wall-clock Directus datetime. `category` groups
// bookmarks in the Bookmarks window (defaults to "General").
export interface Bookmark {
	id: number;
	title: string;
	full_title: string | null;
	start_date: string;
	category: string | null;
}

export interface BookmarksState {
	global: Bookmark[];
	personal: PersonalBookmark[];
	loading: boolean;
	error: string | null;
	signedIn: boolean;
	addPersonal: (b: PersonalBookmark) => void;
	updatePersonalLocal: (b: PersonalBookmark) => void;
	removePersonalLocal: (id: number) => void;
}

const GLOBAL_URL =
	`${DIRECTUS_URL}/items/tm_bookmarks` +
	"?filter[approved][_eq]=1&sort=sort,start_date" +
	"&fields=id,title,full_title,start_date,category&limit=-1";

const PERSONAL_URL =
	`${DIRECTUS_URL}/items/tm_bookmarks_personal` +
	"?sort=category,start_date&fields=id,title,category,start_date&limit=-1";

export function useBookmarks(): BookmarksState {
	const { status } = useAuth();
	const signedIn = status === "signedIn";

	const [global, setGlobal] = useState<Bookmark[]>([]);
	const [personal, setPersonal] = useState<PersonalBookmark[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;
		setLoading(true);
		setError(null);

		(async () => {
			try {
				// Serialized (never parallel) — api-beta can mix concurrent bodies.
				const gRes = await fetch(GLOBAL_URL, { signal: controller.signal });
				if (!gRes.ok) throw new Error(`HTTP ${gRes.status}`);
				const gJson = (await gRes.json()) as { data: Bookmark[] };
				if (cancelled) return;
				setGlobal(gJson.data);
			} catch (err: unknown) {
				if (cancelled || controller.signal.aborted) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
				return;
			}

			if (signedIn) {
				try {
					const pRes = await fetch(PERSONAL_URL, {
						signal: controller.signal,
						credentials: "include",
						cache: "no-store", // dodge stale browser cache (Directus cache non-purging)
					});
					if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
					const pJson = (await pRes.json()) as { data: PersonalBookmark[] };
					if (cancelled) return;
					setPersonal(pJson.data);
				} catch {
					// Personal-only failure (network, 500, or the collection not yet live)
					// must not blank the already-loaded globals — swallow quietly here.
					if (cancelled || controller.signal.aborted) return;
					setPersonal([]);
				}
			} else {
				setPersonal([]);
			}
			if (!cancelled) setLoading(false);
		})();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [signedIn]);

	const addPersonal = useCallback((b: PersonalBookmark) => {
		setPersonal((prev) => [...prev, b]);
	}, []);
	const updatePersonalLocal = useCallback((b: PersonalBookmark) => {
		setPersonal((prev) => prev.map((p) => (p.id === b.id ? b : p)));
	}, []);
	const removePersonalLocal = useCallback((id: number) => {
		setPersonal((prev) => prev.filter((p) => p.id !== id));
	}, []);

	return { global, personal, loading, error, signedIn, addPersonal, updatePersonalLocal, removePersonalLocal };
}
