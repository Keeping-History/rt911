// Loop-mode playback clock, shared by FlightTracker (replay-trail replay) and
// Weather (radar loop). Deliberately NOT the Classicy virtual clock: the
// desktop clock keeps running live while a loop replays the trailing window
// (only TimeMachine may mutate the real clock). Anchor pattern: a virtual
// instant plus the wall time it was set.

export interface LoopClock {
	anchorVirtual: number; // playhead (UTC ms) at the moment of anchoring
	anchorWall: number; // performance.now() at the moment of anchoring
	speed: number; // playback multiplier (each app narrows to its own union)
	scrubbing: boolean; // slider held: playhead frozen at anchorVirtual
	paused: boolean; // play/pause toggle: playhead frozen at anchorVirtual
}

// Playhead at wall time `wall`, wrapped into the sliding window [startMs, endMs).
// The window's edges move every call (it always ends at the live clock), so the
// wrap is computed fresh rather than stored.
export function playheadAt(
	clock: LoopClock,
	wall: number,
	startMs: number,
	endMs: number,
): number {
	const raw =
		clock.scrubbing || clock.paused
			? clock.anchorVirtual
			: clock.anchorVirtual + (wall - clock.anchorWall) * clock.speed;
	const span = endMs - startMs;
	if (span <= 0) return startMs;
	const offset = (((raw - startMs) % span) + span) % span;
	return startMs + offset;
}

// "9:02:41 AM" in the display timezone. tzOffsetHours matches the value
// useClassicyDateTime exposes; shifting the UTC instant and formatting as UTC
// is the same trick the display clock itself uses.
export function formatPlayhead(
	playheadMs: number,
	tzOffsetHours: number,
): string {
	return new Date(playheadMs + tzOffsetHours * 3_600_000).toLocaleTimeString(
		"en-US",
		{
			timeZone: "UTC",
			hour: "numeric",
			minute: "2-digit",
			second: "2-digit",
		},
	);
}
