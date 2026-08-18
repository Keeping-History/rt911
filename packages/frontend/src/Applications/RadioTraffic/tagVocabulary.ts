/**
 * The mp3 corpus' controlled tag vocabulary, read once over HTTP.
 *
 * It comes from `GET /mp3/tags` rather than down the socket because it is
 * byte-identical for every session: pushing a copy to each client would be pure
 * waste, and the HTTP route lets the filter sidebar paint from the browser's
 * own cache without waiting on the WebSocket at all. The one-shot `mp3_meta`
 * frame carries per-item metadata only — there is deliberately no vocabulary
 * field on it.
 *
 * Modelled on radio-core/stationLogos: one shared in-flight promise so several
 * mounts do not each issue the request, and it never rejects.
 *
 * It departs from stationLogos in one way that matters. A missing station logo
 * degrades to a text call sign — a cosmetic gap. Tag filtering IS the
 * navigation in Radio Traffic, so an empty tree is closer to feature loss, and
 * a failure here falls back to the last-known-good copy flagged `stale` instead
 * of to `[]`. Empty is the answer only when there has never been a good copy to
 * keep. Stale-but-usable beats empty.
 *
 * CORS: `GET /mp3/tags` must stay a SIMPLE cross-origin GET. The streamer's
 * Traefik preflight allows `Content-Type` and nothing else and exposes no
 * response headers, so this must set no request headers (no `If-None-Match`)
 * and cannot read `ETag`. Revalidation is the browser's HTTP cache's job, which
 * is unaffected and is what makes the route cheap to call.
 */
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import { STREAM_HTTP_BASE } from "../../lib/endpoints";

/** A vocabulary that resolved successfully once, kept to fall back on. */
export interface CachedVocabulary {
	vocabulary: TagDef[];
	generation: string | null;
}

/** A vocabulary as a caller sees it: `stale` when it is a fallback copy. */
export interface VocabularyState extends CachedVocabulary {
	stale: boolean;
}

const EMPTY: VocabularyState = { vocabulary: [], generation: null, stale: true };

interface TagsResponse {
	generation?: string;
	vocabulary?: TagDef[];
}

/**
 * Read the vocabulary, falling back to `cached` on any failure. Never rejects.
 *
 * A 200 whose body carries no `vocabulary` array counts as a failure, not as a
 * corpus with no tags: accepting a malformed answer as success would replace a
 * working filter tree with an empty one, which is the outcome the fallback
 * exists to prevent. An explicit `[]` is a real answer and is taken as one.
 */
export async function fetchTagVocabulary(
	cached: CachedVocabulary | null,
	f: typeof fetch = fetch,
): Promise<VocabularyState> {
	try {
		const res = await f(`${STREAM_HTTP_BASE}/mp3/tags`);
		if (!res.ok) throw new Error(String(res.status));
		const body = (await res.json()) as TagsResponse;
		if (!Array.isArray(body.vocabulary)) throw new Error("no vocabulary");
		return {
			vocabulary: body.vocabulary,
			generation: body.generation ?? null,
			stale: false,
		};
	} catch {
		return cached ? { ...cached, stale: true } : EMPTY;
	}
}

// One shared in-flight promise: several mounts must not each issue the request,
// and the resolved vocabulary is reused for the page's life.
let inFlight: Promise<VocabularyState> | null = null;
// The most recent copy that actually came off the wire — what a later failure
// falls back to. Never overwritten by a stale result.
let lastKnownGood: CachedVocabulary | null = null;
// The frame generation a refetch has already been attempted for. This is the
// whole loop guard: the streamer runs N replicas, so the pod answering
// /mp3/tags can legitimately disagree with the pod that sent the frame, and
// refetching until the stamps agree would never terminate.
let refetchedFor: string | null = null;

function remember(state: VocabularyState): VocabularyState {
	if (!state.stale) {
		lastKnownGood = { vocabulary: state.vocabulary, generation: state.generation };
	}
	return state;
}

/** The vocabulary, fetched at most once per page load. Never rejects. */
export function loadTagVocabulary(): Promise<VocabularyState> {
	if (!inFlight) inFlight = fetchTagVocabulary(lastKnownGood).then(remember);
	return inFlight;
}

/**
 * Reconcile the held vocabulary against the generation stamped on the `mp3_meta`
 * frame, refetching **once** if they disagree.
 *
 * A client holding a vocabulary from build N and item tags from N+1 renders tag
 * chips its own filter tree has no checkbox for. One refetch fixes the ordinary
 * case — the vocabulary was read just before a rebuild landed. A second would
 * not fix the case it cannot fix, so it is never attempted.
 */
export function reconcileTagVocabulary(
	generation: string | null,
): Promise<VocabularyState> {
	const current = loadTagVocabulary();
	if (!generation) return current;
	return current.then((state) => {
		if (state.generation === generation) return state;
		if (refetchedFor === generation) return state;
		refetchedFor = generation;
		inFlight = fetchTagVocabulary(lastKnownGood).then(remember);
		return inFlight;
	});
}

/** Reset the shared cache. Tests only — production reads it once per load. */
export function resetTagVocabularyCache(): void {
	inFlight = null;
	lastKnownGood = null;
	refetchedFor = null;
}
