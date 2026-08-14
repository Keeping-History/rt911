// Teacher-side seam for live room control (the receiving end is
// RoomControlBridge; the wire is documented in the backend's
// docs/websocket-protocol.md under "Room control").
//
// A room is a playlist id, and the streamer authorises per playlist: it
// resolves the Directus session cookie to a user and requires that user to be
// the playlist's creator. Hence `credentials: "include"` — without the cookie
// every call is a 401, and the endpoint deliberately has no shared key to fall
// back on.
import { ROOM_BASE } from "../../lib/endpoints";

export type RoomLockTarget = "clock";

/** Thrown with a human-usable reason so the Control menu's window can show it. */
export class RoomCommandError extends Error {}

const REASONS: Record<number, string> = {
	401: "Sign in to control this playlist.",
	403: "Only the person who created this playlist can control it.",
	429: "Too many commands — wait a moment.",
};

/** Shared POST /room shape: every command differs only in its body. */
async function postRoomCommand(
	body: Record<string, unknown>,
	fetchFn: typeof fetch,
): Promise<void> {
	let res: Response;
	try {
		res = await fetchFn(`${ROOM_BASE}/room`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		throw new RoomCommandError("Could not reach the server.");
	}
	if (!res.ok) {
		throw new RoomCommandError(REASONS[res.status] ?? `Command failed (${res.status}).`);
	}
}

/**
 * Lock or unlock one control surface for everyone following `room`.
 *
 * `on` is absolute, never "flip it": the caller owns the toggle and sends the
 * value it wants. (The streamer remembers the last lock per room only to
 * replay it to late joiners — there is no read-back a toggle could consult.)
 */
export async function sendRoomLock(
	room: string,
	target: RoomLockTarget,
	on: boolean,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	await postRoomCommand({ room, action: "lock", target, on }, fetchFn);
}

/**
 * Tell everyone following `room` to re-fetch the published playlist definition
 * and re-evaluate it — the teacher's "Push Update to Class". The definition
 * never rides the wire; students re-read it from Directus themselves.
 */
export async function sendRoomReload(
	room: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	await postRoomCommand({ room, action: "reload" }, fetchFn);
}

/**
 * Move every student's virtual clock to `timeIso` (a UTC RFC3339 instant) —
 * the teacher's "Sync Students to My Clock". Students route it through the
 * sanctioned clock seam, so forced clock mode still outranks it client-side.
 */
export async function sendRoomJump(
	room: string,
	timeIso: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	await postRoomCommand({ room, action: "jump", time: timeIso }, fetchFn);
}

/**
 * Bring one desktop app to the front on every student's desktop. `app` is a
 * Classicy app id (e.g. "TV.app").
 */
export async function sendRoomFocus(
	room: string,
	app: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	await postRoomCommand({ room, action: "focus", app }, fetchFn);
}

/** Show a short note on every student's desktop. */
export async function sendRoomMessage(
	room: string,
	message: string,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	await postRoomCommand({ room, action: "message", message }, fetchFn);
}
