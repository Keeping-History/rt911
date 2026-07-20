// HyperCard editor's server-save seam. Every request rides the signed-in
// user's Directus session cookie; the Teacher policy's permissions are
// own-rows-only, so list needs no client-side filter (unlike playlistApi).
import { validateStack } from "classicy";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";
import { AuthRequiredError, ForbiddenError } from "./authApi";

export interface StackSummary {
	id: number;
	name: string;
	date_updated: string | null;
	user_created: string | null;
}

export interface StackRecord extends StackSummary {
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

async function handle<T>(res: Response, fallback: string): Promise<T> {
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, fallback));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, fallback));
	if (!res.ok) throw new Error(await serverMessage(res, fallback));
	const body = (await res.json()) as { data: T };
	return body.data;
}

/** Throws with the first structural error when the definition isn't a valid stack. */
export function assertValidStackDefinition(definition: unknown): void {
	const result = validateStack(definition);
	if ("errors" in result) throw new Error(result.errors[0]);
}

const LIST_FIELDS = "id,name,date_updated,user_created";

export async function listMyStacks(fetchFn: typeof fetch = fetch): Promise<StackSummary[]> {
	const res = await fetchFn(
		`${DIRECTUS_URL}/items/stacks?fields=${LIST_FIELDS}&sort=-date_updated&limit=200`,
		{ credentials: "include" },
	);
	return handle<StackSummary[]>(res, "Failed to list stacks");
}

export async function getStack(id: number, fetchFn: typeof fetch = fetch): Promise<StackRecord> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, { credentials: "include" });
	return handle<StackRecord>(res, "Failed to load stack");
}

export async function createStack(
	name: string,
	definition: unknown,
	fetchFn: typeof fetch = fetch,
): Promise<StackRecord> {
	assertValidStackDefinition(definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, definition }),
	});
	return handle<StackRecord>(res, "Failed to save stack");
}

export async function updateStack(
	id: number,
	patch: { name?: string; definition?: unknown },
	fetchFn: typeof fetch = fetch,
): Promise<StackRecord> {
	if (patch.definition !== undefined) assertValidStackDefinition(patch.definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	return handle<StackRecord>(res, "Failed to update stack");
}

export async function deleteStack(id: number, fetchFn: typeof fetch = fetch): Promise<void> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, "Failed to delete stack"));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, "Failed to delete stack"));
	if (!res.ok) throw new Error(await serverMessage(res, "Failed to delete stack"));
}
