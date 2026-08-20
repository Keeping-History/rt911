// WebVTT → the cue list the Transcript panel renders.
//
// Written here rather than reused because classicy has no cue list to reuse.
// `useQuickTimeSubtitles` fetches and parses a VTT but exposes exactly one
// thing — `activeCueText(seconds)` — and keeps its parsed entries in local
// state (verified against classicy 0.76.1's
// dist/types/.../useQuickTimeSubtitles.d.ts, which declares that single
// member). A panel that wants the whole transcript therefore cannot get it
// from the hook at any price; this is the only route, not a preference.
//
// The grammar accepted is deliberately wider than WebVTT: `,` is taken as a
// decimal separator alongside `.`, and the hour field is optional. That makes
// the same parser read the `.srt` the wire actually carries, so a clip whose
// `.vtt` sibling ever goes missing degrades to the file we know exists rather
// than to a blank panel.

/** One cue, in milliseconds from the top of the clip. */
export interface TranscriptCue {
	fromMs: number;
	toMs: number;
	text: string;
}

/**
 * `HH:MM:SS.mmm`, `MM:SS.mmm`, or either with a comma — null when the token is
 * not a timestamp at all, which is how a stray arrow in cue text is rejected
 * rather than parsed into a cue at time NaN.
 */
function timestampMs(token: string): number | null {
	const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(token.trim());
	if (!match) return null;
	const [, hours, minutes, seconds, fraction] = match;
	// "5" means 500ms, not 5ms — a fraction is a decimal, not a count.
	const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
	return ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + millis;
}

/**
 * Every cue in a VTT (or SRT) body, in file order.
 *
 * Blocks are found by their timing line rather than by counting them, so cue
 * identifiers, NOTE/STYLE/REGION blocks and the WEBVTT header need no special
 * handling: none of them carry a timing arrow, and all fall through. Cue
 * settings after the end timestamp (`align:start line:90%`) are dropped — the
 * panel has no positioning to apply them to.
 */
export function parseTranscriptCues(source: string): TranscriptCue[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const cues: TranscriptCue[] = [];

	for (let i = 0; i < lines.length; i += 1) {
		const arrow = lines[i].indexOf("-->");
		if (arrow === -1) continue;

		const fromMs = timestampMs(lines[i].slice(0, arrow));
		const toMs = timestampMs(lines[i].slice(arrow + 3).trim().split(/\s+/)[0] ?? "");

		// The payload runs to the blank line, whatever the timing line turned out
		// to be — consumed either way so a malformed cue cannot leak its text into
		// the next one.
		const text: string[] = [];
		while (i + 1 < lines.length && lines[i + 1].trim() !== "") {
			i += 1;
			text.push(lines[i].trim());
		}

		if (fromMs === null || toMs === null) continue;
		// Multi-line cues are joined into one line: the panel wraps to the card's
		// width, so the author's line breaks describe a video overlay this is not.
		const body = text.join(" ").trim();
		if (body) cues.push({ fromMs, toMs, text: body });
	}

	return cues;
}

/**
 * Which cue covers a playback position, or -1 for none.
 *
 * The interval is half-open — from <= t < to — so a cue starting at 00:00.000
 * is reachable. classicy's own lookup uses two strict comparisons, which is one
 * of the two reasons the panel showed nothing: a card with no registered audio
 * element reports no position at all, and asking for second 0 matched no cue
 * even when one started there.
 */
export function activeCueIndex(
	cues: readonly TranscriptCue[],
	seconds: number | undefined,
): number {
	if (seconds === undefined || !Number.isFinite(seconds)) return -1;
	const ms = seconds * 1000;
	return cues.findIndex((cue) => cue.fromMs <= ms && ms < cue.toMs);
}
