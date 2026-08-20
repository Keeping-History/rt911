import Tracker from "@openreplay/tracker";

let tracker: Tracker | null = null;
let identifiedUserId: string | null = null;

export function initTracker(): void {
	identifiedUserId = null;
	const projectKey = import.meta.env.VITE_OPENREPLAY_PROJECT_KEY;
	if (!projectKey) {
		tracker = null;
		return;
	}
	const ingestPoint = import.meta.env.VITE_OPENREPLAY_INGEST_URL;
	tracker = new Tracker({
		projectKey,
		...(ingestPoint ? { ingestPoint } : {}),
	});
	tracker.start();
}

/**
 * Tie the recording to the signed-in user so internal traffic can be told
 * apart from real visitors. OpenReplay keeps only the last injected userID,
 * so a blank string after sign-out marks the rest of the session anonymous.
 * The `userId` metadata key must be declared in the OpenReplay project's
 * Metadata settings to be searchable.
 */
export function identifyUser(
	user: { id: string; email: string | null } | null,
): void {
	if (!tracker) return;
	if (user) {
		if (identifiedUserId === user.id) return;
		identifiedUserId = user.id;
		tracker.setUserID(user.email ?? user.id);
		tracker.setMetadata("userId", user.id);
	} else if (identifiedUserId !== null) {
		identifiedUserId = null;
		tracker.setUserID("");
	}
}

export function trackVirtualTimeSet(
	time: string,
	source: "init" | "seek",
): void {
	tracker?.event("virtual_time_set", { time, source });
}

export function trackChannelChange(from: string, to: string): void {
	tracker?.event("channel_change", { from, to });
}

export function trackAppToggle(
	app: string,
	action: "open" | "close",
): void {
	tracker?.event("app_toggle", { app, action });
}

export function trackPauseResume(
	action: "pause" | "resume",
	virtualTime: string,
): void {
	tracker?.event("pause_resume", { action, virtualTime });
}

export function getSessionURL(withCurrentTime = false): string | undefined {
	return tracker?.getSessionURL({ withCurrentTime });
}

export function getSessionID(): string | null | undefined {
	return tracker?.getSessionID();
}
