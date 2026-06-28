import Tracker from "@openreplay/tracker";

let tracker: Tracker | null = null;

export function initTracker(): void {
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
