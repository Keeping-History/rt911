import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHttpBase, STREAM_URL } from "../../lib/endpoints";
import {
	fetchTagVocabulary,
	loadTagVocabulary,
	reconcileTagVocabulary,
	resetTagVocabularyCache,
} from "./tagVocabulary";

const TAGS = [
	{ tag: "facility:zbw", namespace: "facility", value: "ZBW", color: "#8b0000" },
	{ tag: "topic:hijack", namespace: "topic", value: "Hijack" },
];

function jsonResponse(data: unknown, ok = true, status = 200): Response {
	return { ok, status, json: async () => data } as Response;
}

/** A fetch that answers /mp3/tags with `generation` and the standard vocabulary. */
function okFetch(generation = "gen-1") {
	return vi.fn<typeof fetch>(async () => jsonResponse({ generation, vocabulary: TAGS }));
}

function throwingFetch() {
	return vi.fn<typeof fetch>(async () => {
		throw new Error("offline");
	});
}

afterEach(() => {
	resetTagVocabularyCache();
	vi.unstubAllGlobals();
});

describe("fetchTagVocabulary", () => {
	it("returns the vocabulary and its generation from a good response", async () => {
		const f = okFetch("gen-1");
		expect(await fetchTagVocabulary(null, f)).toEqual({
			vocabulary: TAGS,
			generation: "gen-1",
			stale: false,
		});
	});

	// The whole route exists so the sidebar can paint from the browser's own
	// HTTP cache. It is reachable only because it is a SIMPLE cross-origin GET:
	// the streamer's Traefik preflight allows Content-Type and nothing else, so
	// one request header here turns every call into a failed preflight.
	it("sends no request headers, keeping the GET simple for CORS", async () => {
		const f = okFetch();
		await fetchTagVocabulary(null, f);
		expect(f.mock.calls[0]).toHaveLength(1);
	});

	it("reads the streamer's HTTP base, derived from the stream URL", async () => {
		const f = okFetch();
		await fetchTagVocabulary(null, f);
		expect(f.mock.calls[0][0]).toBe(`${chatHttpBase(STREAM_URL)}/mp3/tags`);
	});

	// Decision 5: tag filtering IS the navigation in Radio Traffic, so an empty
	// tree is closer to feature loss than to a cosmetic gap. Every failure below
	// therefore keeps the copy already on screen rather than blanking it.
	const cached = { vocabulary: TAGS, generation: "gen-1" };

	it("returns the cached copy marked stale on a non-ok response", async () => {
		const f = vi.fn<typeof fetch>(async () => jsonResponse({}, false, 503));
		expect(await fetchTagVocabulary(cached, f)).toEqual({
			vocabulary: TAGS,
			generation: "gen-1",
			stale: true,
		});
	});

	it("returns the cached copy marked stale when the request throws", async () => {
		expect(
			await fetchTagVocabulary(cached, throwingFetch()),
		).toEqual({ vocabulary: TAGS, generation: "gen-1", stale: true });
	});

	it("returns the cached copy marked stale when the body is not JSON", async () => {
		const f = vi.fn<typeof fetch>(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new Error("unexpected token");
					},
				}) as unknown as Response,
		);
		expect(await fetchTagVocabulary(cached, f)).toEqual({
			vocabulary: TAGS,
			generation: "gen-1",
			stale: true,
		});
	});

	// A 200 whose body has no vocabulary array is a malformed answer, not a
	// corpus with no tags. Accepting it as success would replace a working tree
	// with an empty one — the exact outcome Decision 5 rules out.
	it("returns the cached copy marked stale when the vocabulary field is missing", async () => {
		const f = vi.fn<typeof fetch>(async () => jsonResponse({ generation: "gen-2" }));
		expect(await fetchTagVocabulary(cached, f)).toEqual({
			vocabulary: TAGS,
			generation: "gen-1",
			stale: true,
		});
	});

	// The distinction the guard above must not swallow: the server genuinely
	// answering with no tags is a success, and is allowed to be empty.
	it("accepts an empty vocabulary array as a real answer", async () => {
		const f = vi.fn<typeof fetch>(async () => jsonResponse({ generation: "gen-2", vocabulary: [] }));
		expect(await fetchTagVocabulary(cached, f)).toEqual({
			vocabulary: [],
			generation: "gen-2",
			stale: false,
		});
	});

	it("returns an empty vocabulary only when there is no cache at all", async () => {
		expect(
			await fetchTagVocabulary(null, throwingFetch()),
		).toEqual({ vocabulary: [], generation: null, stale: true });
	});

	it("never rejects, whatever the fetch does", async () => {
		const f = vi.fn<typeof fetch>(() => Promise.reject(new Error("DNS")));
		await expect(
			fetchTagVocabulary(null, f),
		).resolves.toBeDefined();
	});
});

describe("loadTagVocabulary", () => {
	it("issues one request for the page's life, however many callers ask", async () => {
		const f = okFetch();
		vi.stubGlobal("fetch", f);

		const [a, b] = await Promise.all([loadTagVocabulary(), loadTagVocabulary()]);
		await loadTagVocabulary();

		expect(f).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
		expect(a.vocabulary).toEqual(TAGS);
	});
});

describe("reconcileTagVocabulary", () => {
	it("does not refetch when the frame's generation matches", async () => {
		const f = okFetch("gen-1");
		vi.stubGlobal("fetch", f);

		await loadTagVocabulary();
		await reconcileTagVocabulary("gen-1");

		expect(f).toHaveBeenCalledTimes(1);
	});

	// A client holding vocabulary from build N and item tags from N+1 renders
	// chips its own filter tree has no checkbox for.
	it("refetches once when the frame's generation differs", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ generation: "gen-1", vocabulary: TAGS }))
			.mockResolvedValueOnce(jsonResponse({ generation: "gen-2", vocabulary: [] }));
		vi.stubGlobal("fetch", f);

		await loadTagVocabulary();
		const after = await reconcileTagVocabulary("gen-2");

		expect(f).toHaveBeenCalledTimes(2);
		expect(after).toEqual({ vocabulary: [], generation: "gen-2", stale: false });
	});

	// The loop this guards against: the streamer runs N replicas, so a client
	// can take its vocabulary from a pod that disagrees with the one that sent
	// the frame. Refetching until the stamps agree would then never terminate.
	it("refetches exactly once even when the answer still disagrees", async () => {
		const f = okFetch("gen-1");
		vi.stubGlobal("fetch", f);

		await loadTagVocabulary();
		await reconcileTagVocabulary("gen-2");
		await reconcileTagVocabulary("gen-2");
		await reconcileTagVocabulary("gen-2");

		expect(f).toHaveBeenCalledTimes(2);
	});

	it("does not refetch concurrently for the same mismatched generation", async () => {
		const f = okFetch("gen-1");
		vi.stubGlobal("fetch", f);

		await loadTagVocabulary();
		await Promise.all([reconcileTagVocabulary("gen-2"), reconcileTagVocabulary("gen-2")]);

		expect(f).toHaveBeenCalledTimes(2);
	});

	it("keeps the last-known-good copy when the refetch itself fails", async () => {
		const f = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ generation: "gen-1", vocabulary: TAGS }))
			.mockRejectedValueOnce(new Error("offline"));
		vi.stubGlobal("fetch", f);

		await loadTagVocabulary();
		const after = await reconcileTagVocabulary("gen-2");

		expect(after).toEqual({ vocabulary: TAGS, generation: "gen-1", stale: true });
	});

	// The frame is one-shot, and a session that never gets one (no snapshot
	// built yet) must not be treated as a mismatch against everything.
	it("treats a null generation as nothing to reconcile", async () => {
		const f = okFetch("gen-1");
		vi.stubGlobal("fetch", f);

		await reconcileTagVocabulary(null);

		expect(f).toHaveBeenCalledTimes(1);
	});
});
