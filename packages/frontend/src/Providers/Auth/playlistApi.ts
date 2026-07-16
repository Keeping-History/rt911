// Future playlist editor's API seam. Every request rides the signed-in
// teacher's Directus session cookie; permissions return a teacher's own rows
// plus everyone's published rows, so listMine filters client-side.
import { parsePlaylist } from "../Playlist/parsePlaylist";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";
import { AuthRequiredError, ForbiddenError } from "./authApi";

export interface PlaylistSummary {
	id: string;
	title: string;
	status: string;
	date_updated: string | null;
	user_created: string | null;
}

export interface PlaylistRecord extends PlaylistSummary {
	definition: unknown;
}

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

// Shared status → error mapping. 401/403 get typed errors so editor UI can
// tell "sign in" from "not yours"; everything else is a plain Error carrying
// the server's message.
async function handle<T>(res: Response, fallback: string): Promise<T> {
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, fallback));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, fallback));
	if (!res.ok) throw new Error(await serverMessage(res, fallback));
	const body = (await res.json()) as { data: T };
	return body.data;
}

function assertValidDefinition(definition: unknown): void {
	if (parsePlaylist(definition).definition === null) {
		throw new Error("playlist definition is invalid");
	}
}

const LIST_FIELDS = "id,title,status,date_updated,user_created";

export async function listMine(
	meId: string,
	fetchFn: typeof fetch = fetch,
): Promise<PlaylistSummary[]> {
	const res = await fetchFn(
		`${DIRECTUS_URL}/items/playlists?fields=${LIST_FIELDS}&sort=-date_updated&limit=200`,
		{ credentials: "include" },
	);
	const rows = await handle<PlaylistSummary[]>(res, "Failed to list playlists");
	return rows.filter((r) => r.user_created === meId);
}

export async function getPlaylist(
	id: string,
	fetchFn: typeof fetch = fetch,
): Promise<PlaylistRecord> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}`, {
		credentials: "include",
	});
	return handle<PlaylistRecord>(res, "Failed to load playlist");
}

export async function createPlaylist(
	title: string,
	definition: unknown,
	fetchFn: typeof fetch = fetch,
): Promise<PlaylistRecord> {
	assertValidDefinition(definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/playlists`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, definition, status: "draft" }),
	});
	return handle<PlaylistRecord>(res, "Failed to create playlist");
}

export async function updatePlaylist(
	id: string,
	patch: { title?: string; definition?: unknown; status?: "draft" | "published" },
	fetchFn: typeof fetch = fetch,
): Promise<PlaylistRecord> {
	if (patch.definition !== undefined) assertValidDefinition(patch.definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	return handle<PlaylistRecord>(res, "Failed to update playlist");
}

export async function deletePlaylist(id: string, fetchFn: typeof fetch = fetch): Promise<void> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, "Failed to delete playlist"));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, "Failed to delete playlist"));
	if (!res.ok) throw new Error(await serverMessage(res, "Failed to delete playlist"));
}

// getPlaylist then createPlaylist — two SEQUENTIAL awaits, never
// Promise.all: parallel same-path requests to api-beta can return mixed
// response bodies (see loadPlaylist.ts / useRouteIndex.ts).
export async function duplicatePlaylist(
	id: string,
	fetchFn: typeof fetch = fetch,
): Promise<PlaylistRecord> {
	const source = await getPlaylist(id, fetchFn);
	return createPlaylist(`Copy of ${source.title}`, source.definition, fetchFn);
}
