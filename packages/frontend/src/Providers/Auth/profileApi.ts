// Profile-editing API: names/demographics/password via /users/me, email via
// the profile-api extension's verified round-trip (spec:
// plans/2026-07-16-account-profile-design.md). Email is NOT accepted here —
// the server 403s it, and we reject locally so the mistake is loud in dev.
import {
	AuthRequiredError,
	ForbiddenError,
	type AuthUser,
} from "./authApi";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";

export interface ProfilePatch {
	first_name?: string | null;
	last_name?: string | null;
	password?: string;
	city?: string | null;
	state?: string | null;
	country?: string | null;
	school_name?: string | null;
	educator_role?: string | null;
	grade_levels?: string[] | null;
	subjects?: string[] | null;
}

interface DirectusErrorBody {
	errors?: Array<{ message?: unknown }>;
}

async function serverMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as DirectusErrorBody;
		const msg = body.errors?.[0]?.message;
		return typeof msg === "string" ? msg : fallback;
	} catch {
		return fallback;
	}
}

async function reject(res: Response, fallback: string): Promise<never> {
	const msg = await serverMessage(res, fallback);
	if (res.status === 401) throw new AuthRequiredError(msg);
	if (res.status === 403) throw new ForbiddenError(msg);
	throw new Error(msg);
}

export async function updateProfile(
	patch: ProfilePatch,
	fetchFn: typeof fetch = fetch,
): Promise<Partial<AuthUser>> {
	if ("email" in patch) {
		throw new Error("email changes must go through requestEmailChange (verified flow)");
	}
	const res = await fetchFn(`${DIRECTUS_URL}/users/me`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) await reject(res, "Could not save your profile.");
	const body = (await res.json()) as { data: Partial<AuthUser> };
	return body.data;
}

export async function requestEmailChange(
	newEmail: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	const res = await fetchFn(`${DIRECTUS_URL}/profile/email-change`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ newEmail }),
	});
	if (!res.ok) await reject(res, "Could not send the confirmation email.");
}

export async function confirmEmailChange(
	token: string,
	fetchFn: typeof fetch = fetch,
): Promise<string> {
	const res = await fetchFn(`${DIRECTUS_URL}/profile/email-change/confirm`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (!res.ok) await reject(res, "Could not confirm the email change.");
	const body = (await res.json()) as { data: { email: string } };
	return body.data.email;
}
