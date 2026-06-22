/**
 * Session-lifetime cache of on-demand Usenet article bodies. Bodies are immutable
 * historical data, so once fetched they are never invalidated. A frame either
 * carries a body (success) or a message (failure); the two maps are kept mutually
 * exclusive per id so the UI can show body / loading / error unambiguously.
 */
export interface UsenetBodyState {
	bodies: Record<number, string>;
	errors: Record<number, string>;
}

export const emptyUsenetBodyState: UsenetBodyState = { bodies: {}, errors: {} };

/** The server's usenet_body reply: {id, body} on success or {id, message} on failure. */
export interface UsenetBodyFrame {
	id: number;
	body?: string;
	message?: string;
}

/** Fold one usenet_body frame into the cache, returning a new state. */
export function applyUsenetBodyFrame(
	state: UsenetBodyState,
	frame: UsenetBodyFrame,
): UsenetBodyState {
	const bodies = { ...state.bodies };
	const errors = { ...state.errors };
	if (frame.message) {
		errors[frame.id] = frame.message;
		delete bodies[frame.id];
	} else {
		bodies[frame.id] = frame.body ?? "";
		delete errors[frame.id];
	}
	return { bodies, errors };
}
