// Account-deletion seam. Both routes live on the profile-api Directus
// extension because neither action is possible with user credentials: the
// Teacher policy grants no delete on directus_users, and chat_messages is not
// a Directus-managed collection. Spec: plans/2026-07-28-account-special-tab-design.md
import { AuthRequiredError, ForbiddenError } from "./authApi";
import { DIRECTUS_URL } from "../../lib/endpoints";

/** Per-collection row counts the server actually removed, plus what it could not. */
export interface DeletionResult {
	deleted: Record<string, number>;
	failed: string[];
}

/**
 * Every localStorage key holding user settings.
 *
 * `classicyDesktopState` is the big one: the Classicy store persists window
 * positions AND every app's settings (Feedback, RadioScanner, README,
 * TimeMachine, TV selections) into that single key.
 */
export const SETTINGS_KEYS = [
	"classicyDesktopState",
	"rt911AlertsEnabled",
	"media-chrome-pref-muted",
	"media-chrome-pref-volume",
	"media-chrome-pref-subtitles-lang",
] as const;

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

async function post(path: string, fallback: string, fetchFn: typeof fetch): Promise<DeletionResult> {
	const res = await fetchFn(`${DIRECTUS_URL}${path}`, {
		method: "POST",
		credentials: "include",
	});
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, fallback));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, fallback));
	if (!res.ok) throw new Error(await serverMessage(res, fallback));
	const body = (await res.json()) as { data: DeletionResult };
	return body.data;
}

/** Erase the user's content and blank their profile. The account survives. */
export async function deleteMyData(fetchFn: typeof fetch = fetch): Promise<DeletionResult> {
	return post("/profile/delete-data", "Could not delete your data.", fetchFn);
}

/** Erase everything above, then remove the account itself. Irreversible. */
export async function deleteMyAccount(fetchFn: typeof fetch = fetch): Promise<DeletionResult> {
	return post("/profile/delete-account", "Could not delete your account.", fetchFn);
}

/** Drop every persisted setting. Must be followed by reloadDesktop() — see below. */
export function clearLocalSettings(storage: Storage = window.localStorage): void {
	for (const key of SETTINGS_KEYS) storage.removeItem(key);
}

/**
 * Hard reload, and it is load-bearing rather than cosmetic.
 *
 * The live ClassicyStore holds the same settings in memory and writes them
 * straight back to localStorage on its next dispatch, so clearing the keys
 * without reloading is a no-op. The reload also discards the in-memory
 * FilesystemSync tree, which would otherwise re-push itself to a `filesystem`
 * link the server just nulled.
 */
export function reloadDesktop(): void {
	window.location.reload();
}
