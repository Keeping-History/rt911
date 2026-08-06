import { useEffect, useState } from "react";
import { DIRECTUS_URL } from "../lib/endpoints";
import { buildPageTree, type PageNode, type PageSummary } from "./pageTree";

/**
 * Data access for the CMS pages surface.
 *
 * Direct Directus REST, mirroring useReadmeArticles.ts: this is present-day
 * reference content that never touches the streamer or the virtual clock.
 */

export interface PageAuthor {
	name: string;
	email: string | null;
	/** File UUID; render via `${DIRECTUS_URL}/assets/${avatar}`. */
	avatar: string | null;
}

export interface Page extends PageSummary {
	body: string | null;
	date_created: string;
	date_updated: string | null;
	author: PageAuthor | null;
}

const NAV_FIELDS = "id,title,slug,parent,sort";
const PAGE_FIELDS =
	"id,title,slug,parent,sort,body,date_created,date_updated,author.name,author.email,author.avatar";

export const NAV_URL =
	`${DIRECTUS_URL}/items/pages` +
	`?filter[status][_eq]=published&filter[show_in_nav][_eq]=true` +
	`&fields=${NAV_FIELDS}&limit=-1`;

export function pageUrl(slug: string): string {
	return (
		`${DIRECTUS_URL}/items/pages` +
		`?filter[status][_eq]=published&filter[slug][_eq]=${encodeURIComponent(slug)}` +
		`&fields=${PAGE_FIELDS}&limit=1`
	);
}

export interface PagesState {
	nav: PageNode[];
	page: Page | null;
	loading: boolean;
	/** Set only when the slug resolved to nothing — drives the 404 view. */
	notFound: boolean;
	error: string | null;
}

export function usePages(slug: string): PagesState {
	const [state, setState] = useState<PagesState>({
		nav: [],
		page: null,
		loading: true,
		notFound: false,
		error: null,
	});

	useEffect(() => {
		const controller = new AbortController();

		const load = async () => {
			setState((s) => ({ ...s, loading: true, notFound: false, error: null }));
			try {
				const get = async (url: string) => {
					const res = await fetch(url, { signal: controller.signal });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return res.json();
				};

				// Strictly sequential, never Promise.all: concurrent requests to
				// this API have been observed returning mixed response bodies.
				const navJson = (await get(NAV_URL)) as { data: PageSummary[] };
				const pageJson = (await get(pageUrl(slug))) as { data: Page[] };

				if (controller.signal.aborted) return;
				const page = pageJson.data[0] ?? null;
				setState({
					nav: buildPageTree(navJson.data ?? []),
					page,
					loading: false,
					notFound: page === null,
					error: null,
				});
			} catch (err) {
				if (controller.signal.aborted) return;
				setState({
					nav: [],
					page: null,
					loading: false,
					notFound: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		};

		void load();
		return () => controller.abort();
	}, [slug]);

	return state;
}
