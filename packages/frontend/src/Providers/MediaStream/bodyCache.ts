/**
 * Session-lifetime cache of on-demand item bodies — Usenet articles and news
 * articles both use it. Bodies are immutable
 * historical data, so once fetched they are never invalidated. A frame either
 * carries a body (success) or a message (failure); the two maps are kept mutually
 * exclusive per id so the UI can show body / loading / error unambiguously.
 */
export interface BodyState {
	bodies: Record<number, string>;
	errors: Record<number, string>;
}

export const emptyBodyState: BodyState = { bodies: {}, errors: {} };

/** A usenet_body or news_body reply: {id, body} on success or {id, message} on failure. */
export interface BodyFrame {
	id: number;
	body?: string;
	message?: string;
}

/** Fold one usenet_body or news_body frame into the cache, returning a new state. */
export function applyBodyFrame(
	state: BodyState,
	frame: BodyFrame,
): BodyState {
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
