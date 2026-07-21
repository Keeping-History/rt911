// Pure Directus REST helpers for the per-user filesystem blob. No module state:
// identity rides the httpOnly session cookie (credentials:"include"), the same
// stance as authApi.ts. The tree is stored as a single JSON file in directus_files
// (Wasabi-backed) and pointed to by the `filesystem` m2o field on directus_users.
import { isValidFileSystemEntry } from "classicy";
import type { ClassicyFileSystemEntry } from "classicy";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";

const FILE_FIELD = "filesystem";

/** The current user's linked filesystem file id, or null if unlinked/unauthenticated. */
export async function fetchFilesystemFileId(fetchFn: typeof fetch = fetch): Promise<string | null> {
	const r = await fetchFn(`${DIRECTUS_URL}/users/me?fields=${FILE_FIELD}`, { credentials: "include" });
	if (!r.ok) return null;
	const body = (await r.json()) as { data?: { filesystem?: string | null } };
	return body.data?.filesystem ?? null;
}

/** Download + validate the tree at a Directus file id. Null if missing/unparseable/invalid. */
export async function downloadTree(
	fileId: string,
	fetchFn: typeof fetch = fetch,
): Promise<ClassicyFileSystemEntry | null> {
	const r = await fetchFn(`${DIRECTUS_URL}/assets/${fileId}`, { credentials: "include" });
	if (!r.ok) return null;
	try {
		const parsed = JSON.parse(await r.text()) as ClassicyFileSystemEntry;
		return isValidFileSystemEntry(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Persist the tree for the current user. Overwrites `knownFileId` in place when
 * given (same Wasabi object); otherwise discovers an existing link, else creates
 * a new file and links it via PATCH /users/me. Returns the file id used.
 * Throws if a request fails so the caller can retry (and not advance dedupe state).
 */
export async function pushTree(
	tree: ClassicyFileSystemEntry,
	knownFileId: string | null,
	fetchFn: typeof fetch = fetch,
): Promise<string> {
	const blob = new Blob([JSON.stringify(tree)], { type: "application/json" });
	const form = new FormData();
	form.append("file", blob, "filesystem.json");

	const id = knownFileId ?? (await fetchFilesystemFileId(fetchFn));
	if (id) {
		// PATCH /files/{id} with multipart replaces the stored bytes in place.
		const r = await fetchFn(`${DIRECTUS_URL}/files/${id}`, {
			method: "PATCH",
			credentials: "include",
			body: form,
		});
		if (!r.ok) throw new Error(`filesystem overwrite failed: ${r.status}`);
		return id;
	}

	const created = await fetchFn(`${DIRECTUS_URL}/files`, { method: "POST", credentials: "include", body: form });
	if (!created.ok) throw new Error(`filesystem create failed: ${created.status}`);
	const newId = ((await created.json()) as { data: { id: string } }).data.id;
	const linked = await fetchFn(`${DIRECTUS_URL}/users/me`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ [FILE_FIELD]: newId }),
	});
	if (!linked.ok) throw new Error(`filesystem link failed: ${linked.status}`);
	return newId;
}
