import { useEffect, useState } from "react";

export interface ReadmeTag {
	id:    number;
	name:  string;
	color: string | null;
}

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
	// Manual ordering (smallest first); null = unsorted, falls to the date tail.
	sort:         number | null;
	// Featured articles are pinned above everything else and flagged with a star.
	featured:     boolean;
	// Author-assigned tags (M2M). Drives the pill badges and the tag filter.
	tags:         ReadmeTag[];
}

// Display order: featured first (pinned), then the manual `sort` ascending
// (unsorted articles last), then newest-first by date. Equal `sort` values fall
// back to newest-first too. Pure + exported so it is unit-testable on its own.
export function sortArticles(articles: ReadmeArticle[]): ReadmeArticle[] {
	return [...articles].sort((a, b) => {
		if (a.featured !== b.featured) return a.featured ? -1 : 1;
		if (a.sort !== b.sort) {
			if (a.sort == null) return 1;   // unsorted sinks below sorted
			if (b.sort == null) return -1;
			return a.sort - b.sort;         // smallest sort first
		}
		return new Date(b.date_created).getTime() - new Date(a.date_created).getTime();
	});
}

// Directus returns M2M rows nested under the junction key; flatten to ReadmeTag[].
interface RawTagJoin {
	readme_tags_id?: Partial<ReadmeTag> | null;
}

export function flattenTags(raw: unknown): ReadmeTag[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((j) => (j as RawTagJoin)?.readme_tags_id)
		.filter(
			(t): t is Partial<ReadmeTag> =>
				!!t && typeof t.id === "number" && typeof t.name === "string",
		)
		.map((t) => ({ id: t.id as number, name: t.name as string, color: t.color ?? null }));
}

// The Settings checkbox universe: every distinct tag across the feed, name-sorted.
export function allTags(articles: ReadmeArticle[]): ReadmeTag[] {
	const byId = new Map<number, ReadmeTag>();
	for (const a of articles) {
		for (const t of a.tags) if (!byId.has(t.id)) byId.set(t.id, t);
	}
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// OR filter: keep an article if it is untagged, or has ≥1 non-hidden tag.
export function visibleArticles(
	articles: ReadmeArticle[],
	hiddenTagIds: number[],
): ReadmeArticle[] {
	if (hiddenTagIds.length === 0) return articles;
	const hidden = new Set(hiddenTagIds);
	return articles.filter(
		(a) => a.tags.length === 0 || a.tags.some((t) => !hidden.has(t.id)),
	);
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
	"&fields=id,headline,author,date_created,date_updated,body,sort,featured," +
	"tags.readme_tags_id.id,tags.readme_tags_id.name,tags.readme_tags_id.color" +
	"&limit=-1";

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

// The raw wire article has `tags` in nested junction shape; normalize to flat.
type RawReadmeArticle = Omit<ReadmeArticle, "tags"> & { tags?: unknown };

function normalizeArticle(raw: RawReadmeArticle): ReadmeArticle {
	return { ...raw, tags: flattenTags(raw.tags) };
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
			const json = (await res.json()) as { data: RawReadmeArticle[] };
			loaded = true;
			setState({
				articles: sortArticles(json.data.map(normalizeArticle)),
				loading: false,
				error: null,
			});
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
