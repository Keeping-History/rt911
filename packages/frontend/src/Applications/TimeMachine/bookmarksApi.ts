// Create/update/delete a signed-in user's own personal Time Machine bookmarks.
// Pure functions with an injectable fetch (mirrors profileApi.ts / stackApi.ts):
// credentials:"include" sends the Directus session cookie; the collection's
// own-rows policy (user_created = $CURRENT_USER) enforces isolation server-side.
import { AuthRequiredError, ForbiddenError } from "../../Providers/Auth/authApi";
import { DIRECTUS_URL } from "../../Providers/Playlist/loadPlaylist";

export interface PersonalBookmark {
  id: number;
  title: string;
  category: string;
  start_date: string;
}
export interface PersonalBookmarkInput {
  title: string;
  category: string;
  start_date: string;
}

const COLLECTION = `${DIRECTUS_URL}/items/tm_bookmarks_personal`;

interface DirectusErrorBody { errors?: Array<{ message?: unknown }>; }

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

export async function createPersonalBookmark(
  input: PersonalBookmarkInput,
  fetchFn: typeof fetch = fetch,
): Promise<PersonalBookmark> {
  const res = await fetchFn(COLLECTION, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await reject(res, "Could not save your bookmark.");
  const body = (await res.json()) as { data: PersonalBookmark };
  return body.data;
}

export async function updatePersonalBookmark(
  id: number,
  patch: Partial<PersonalBookmarkInput>,
  fetchFn: typeof fetch = fetch,
): Promise<PersonalBookmark> {
  const res = await fetchFn(`${COLLECTION}/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) await reject(res, "Could not update your bookmark.");
  const body = (await res.json()) as { data: PersonalBookmark };
  return body.data;
}

export async function deletePersonalBookmark(
  id: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`${COLLECTION}/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) await reject(res, "Could not delete your bookmark.");
}
