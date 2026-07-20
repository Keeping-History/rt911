// Serialized Directus REST access. api-beta MIXES the response bodies of
// concurrent browser fetches (verified 2026-07-15), so every REST call in the
// editor and its volume goes through this single global chain.
export const DIRECTUS_URL: string =
	import.meta.env?.VITE_DIRECTUS_URL ?? "https://api-beta.911realtime.org";

let chain: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
	const next = chain.then(job, job);
	chain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function directusGet(
	pathAndQuery: string,
	fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
	return enqueue(async () => {
		const res = await fetchFn(`${DIRECTUS_URL}${pathAndQuery}`);
		if (!res.ok) {
			throw new Error(`directus GET ${pathAndQuery} failed: ${res.status}`);
		}
		const body = (await res.json()) as { data?: unknown[] };
		return body.data ?? [];
	});
}
