import { useEffect, useState } from "react";

// A README article: present-day site news authored in Directus. Unlike every
// other app's data this is NOT time-gated — dates are real-world dates and the
// list refreshes from Directus about once a minute while the app is open.
export interface ReadmeArticle {
	id:           number;
	headline:     string;
	author:       string | null;
	date_created: string;
	date_updated: string | null;
	body:         string;
}

export interface ReadmeArticlesState {
	articles: ReadmeArticle[];
	loading:  boolean;
	error:    string | null;
}

// Same direct-REST pattern as TimeMachine/useBookmarks.ts: reference data that
// bypasses the streamer entirely.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api-beta.911realtime.org";

export const ARTICLES_URL =
	`${DIRECTUS_URL}/items/readme_articles` +
	"?filter[status][_eq]=published&sort=-date_created" +
	"&fields=id,headline,author,date_created,date_updated,body&limit=-1";

// One cheap aggregate row: (count, max date_updated) is a change signature —
// count catches creates/deletes, max(date_updated) catches edits. Blind spot
// (delete + create in the same minute that cancel out) self-heals on the next
// real edit; see plans/2026-07-16-readme-app-design.md.
export const PROBE_URL =
	`${DIRECTUS_URL}/items/readme_articles` +
	"?filter[status][_eq]=published&aggregate[count]=*&aggregate[max]=date_updated";

export const REFRESH_INTERVAL_MS = 60_000;

// count arrives as a string or number depending on the SQL driver; the
// signature treats it opaquely.
interface ProbeRow {
	count: number | string;
	max:   { date_updated: string | null } | null;
}

export function useReadmeArticles(enabled: boolean): ReadmeArticlesState {
	const [state, setState] = useState<ReadmeArticlesState>({
		articles: [],
		loading:  true,
		error:    null,
	});

	useEffect(() => {
		if (!enabled) return;

		const controller = new AbortController();
		let signature: string | null = null;
		let busy   = false;
		let loaded = false;

		const probe = async (): Promise<string> => {
			const res = await fetch(PROBE_URL, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: ProbeRow[] };
			const row = json.data[0];
			return `${row?.count ?? 0}|${row?.max?.date_updated ?? ""}`;
		};

		const fetchList = async () => {
			const res = await fetch(ARTICLES_URL, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: ReadmeArticle[] };
			loaded = true;
			setState({ articles: json.data, loading: false, error: null });
		};

		// Probe → (maybe) fetch, strictly sequential: api-beta mixes response
		// bodies under concurrent requests, and a slow cycle must finish before
		// the next tick starts. The signature is committed only after a
		// successful list fetch so a failed fetch retries on the next tick.
		const tick = async () => {
			if (busy) return;
			busy = true;
			try {
				const sig = await probe();
				if (sig !== signature) {
					await fetchList();
					signature = sig;
				}
			} catch (err) {
				// After a successful load, errors are silent: keep the
				// last-good list and let the next tick retry.
				if (!controller.signal.aborted && !loaded) {
					setState({
						articles: [],
						loading:  false,
						error:    err instanceof Error ? err.message : String(err),
					});
				}
			} finally {
				busy = false;
			}
		};

		void tick();
		const interval = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
		return () => {
			clearInterval(interval);
			controller.abort();
		};
	}, [enabled]);

	return state;
}
