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

/** Thrown with a human-usable reason so the Control window can show it. */
export class RoomCommandError extends Error {}

const REASONS: Record<number, string> = {
	401: "Sign in to control this playlist.",
	403: "Only the person who created this playlist can control it.",
	429: "Too many commands — wait a moment.",
};

/**
 * Lock or unlock one control surface for everyone following `room`.
 *
 * `on` is absolute, never "flip it": the streamer holds no lock state, so the
 * caller owns the toggle and sends the value it wants.
 */
export async function sendRoomLock(
	room: string,
	target: RoomLockTarget,
	on: boolean,
	fetchFn: typeof fetch = fetch,
): Promise<void> {
	let res: Response;
	try {
		res = await fetchFn(`${ROOM_BASE}/room`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ room, action: "lock", target, on }),
		});
	} catch {
		throw new RoomCommandError("Could not reach the server.");
	}
	if (!res.ok) {
		throw new RoomCommandError(REASONS[res.status] ?? `Command failed (${res.status}).`);
	}
}
