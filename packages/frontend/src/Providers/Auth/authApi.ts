// Directus session-cookie auth. httpOnly cookies only — never read/write
// localStorage or any client-side store here; every request rides
// credentials:"include" and the browser-held Directus session cookie.
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";

export interface AuthUser {
	id: string;
	email: string | null;
	first_name: string | null;
	last_name: string | null;
}

// Exported for later tasks (AuthProvider, playlistApi) to classify failures
// from *their own* Directus calls — not thrown by this module.
export class AuthRequiredError extends Error {}
export class ForbiddenError extends Error {}

interface DirectusErrorBody {
	errors?: { message?: unknown }[];
}

async function serverMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as DirectusErrorBody;
		const message = body.errors?.[0]?.message;
		return typeof message === "string" ? message : fallback;
	} catch {
		return fallback;
	}
}

// 401 means "not signed in" — anonymous is the expected steady state for most
// visitors, so it resolves to null rather than throwing.
export async function fetchMe(fetchFn: typeof fetch = fetch): Promise<AuthUser | null> {
	const res = await fetchFn(`${DIRECTUS_URL}/users/me?fields=id,email,first_name,last_name`, {
		credentials: "include",
	});
	if (res.status === 401) return null;
	if (!res.ok) throw new Error(await serverMessage(res, "Failed to fetch current user"));
	const body = (await res.json()) as { data: AuthUser };
	return body.data;
}

export async function loginEmail(
	email: string,
	password: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	const res = await fetchFn(`${DIRECTUS_URL}/auth/login`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password, mode: "session" }),
	});
	if (!res.ok) throw new Error(await serverMessage(res, "Sign-in failed"));
}

// Best-effort: the session cookie may already be gone or the server
// unreachable; the caller always treats itself as signed out afterward.
export async function logout(fetchFn: typeof fetch = fetch): Promise<void> {
	try {
		await fetchFn(`${DIRECTUS_URL}/auth/logout`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "session" }),
		});
	} catch {
		// ignored — see comment above
	}
}

export function providerLoginUrl(
	provider: "google" | "facebook" | "apple",
	redirectTo: string,
): string {
	return `${DIRECTUS_URL}/auth/login/${provider}?redirect=${encodeURIComponent(redirectTo)}`;
}
