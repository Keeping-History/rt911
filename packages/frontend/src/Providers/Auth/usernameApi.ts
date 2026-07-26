/**
 * Ask the streamer whether a screen name is free.
 *
 * This cannot be answered from the browser against Directus: reads on
 * directus_users are scoped to $CURRENT_USER, so a lookup returns zero rows for
 * every name — taken or free — and reporting "available" from that would be a
 * confident lie. The streamer holds its own pool and can see the whole table.
 *
 * The answer is ADVISORY. Two people can be told yes about the same name in the
 * same moment; the unique index decides, and the save still handles
 * UsernameTakenError. This only exists to catch the common case early.
 */

// Derived from the WebSocket URL so there is one place to point at an
// environment. The streamer serves both from the same host.
const STREAM_BASE: string = (
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ?? "ws://localhost:8080/stream"
)
	.replace(/^ws/, "http")
	.replace(/\/stream$/, "");

export type UsernameCheck = "available" | "taken" | "unknown";

/**
 * Returns "unknown" for anything other than a clear yes or no — the endpoint
 * being unreachable, rate-limited, or the user signed out. A check that cannot
 * reach the server must not block a save it has no opinion on: the database
 * still has the final word.
 */
export async function checkUsername(
	name: string,
	signal?: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<UsernameCheck> {
	try {
		const res = await fetchFn(
			`${STREAM_BASE}/chat/username-available?name=${encodeURIComponent(name)}`,
			{ credentials: "include", signal },
		);
		if (!res.ok) return "unknown";
		const body = (await res.json()) as { available?: unknown };
		if (typeof body.available !== "boolean") return "unknown";
		return body.available ? "available" : "taken";
	} catch {
		// Aborted, offline, CORS — all of them mean "no opinion", never "taken".
		return "unknown";
	}
}
