/**
 * Every backend base URL the browser talks to, in one place.
 *
 * These are read from `import.meta.env` at module load, which means Vite
 * inlines them at BUILD time — a deployed bundle cannot be repointed without a
 * rebuild. The defaults below are the production hosts, so an image built
 * without the VITE_* variables set still reaches production rather than
 * silently falling back to a dead hostname.
 *
 * Adding a variable here is not enough on its own: it also needs an ARG and an
 * ENV line in packages/frontend/Dockerfile and a build-args entry in
 * .github/workflows/build.yml. Docker ignores a build-arg with no matching ARG
 * without failing, so a missing declaration shows up only as production
 * quietly using the default below.
 */

/** Directus REST base, read anonymously for static reference data. No trailing slash. */
export const DIRECTUS_URL: string =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api.911realtime.org";

/** Streamer WebSocket endpoint. */
export const STREAM_URL: string =
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ??
	"wss://stream.911realtime.org/stream";

/** Streamer HTTP base, used by the Feedback app to POST /feedback. */
export const FEEDBACK_URL: string =
	(import.meta.env.VITE_FEEDBACK_URL as string | undefined) ?? "https://stream.911realtime.org";

/**
 * The HTTP origin serving the streamer's REST endpoints, derived from the
 * WebSocket URL so there is exactly one place to point at an environment. The
 * streamer serves both from the same host.
 */
export function chatHttpBase(streamUrl: string): string {
	return streamUrl.replace(/^ws/, "http").replace(/\/stream$/, "");
}

/** Base for the streamer's chat REST endpoints, e.g. /chat/username-available. */
export const CHAT_BASE: string = chatHttpBase(STREAM_URL);
