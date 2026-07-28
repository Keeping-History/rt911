// Compose-row policy for a chat window: may the student type right now, and if
// not, what is the one sentence that explains it?
//
// Two independent things can close the composer. The streamer's chat_state
// frames carry the server's view (paused clock, nobody online, blocked, not
// signed in). This module adds the client-only one: the student has rewound the
// virtual clock behind a message this conversation already contains.
//
// That guard exists because the backend spends real effort keeping a buddy from
// referring to events that have not happened yet, and a rewind opens the same
// hole from the other side — type at 9:00 into a conversation whose last line is
// stamped 9:07 and the agent receives a turn sitting before its own previous
// answer. There is no prompt-side fix for a self-contradictory transcript.
import { formatPlayhead } from "../../lib/loopClock";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { BACKWARD_SEEK_THRESHOLD_MS } from "../../Providers/MediaStream/seekDetection";

/**
 * Renders the one-sentence explanation for why compose is (or isn't) usable
 * right now. Pure so the window itself never branches on `reason` inline — it
 * just renders whatever this returns. Unlike BuddyListWindow's statusLineFor,
 * "ok" has no news to report: an empty string means the compose row simply
 * isn't showing a hint.
 */
export function composeHintFor(reason: ChatStateReason): string {
	switch (reason) {
		case "paused":
			return "Start the clock to keep talking.";
		case "outside_window":
			return "Nobody is online right now.";
		case "blocked":
			return "You can't send messages right now.";
		case "not_signed_in":
			return "Sign on to send messages.";
		case "ok":
			return "";
		default: {
			// Exhaustiveness guard: a sixth ChatStateReason added to the wire
			// protocol without a case added here fails this type check instead
			// of silently rendering nothing.
			const unhandled: never = reason;
			return unhandled;
		}
	}
}

/**
 * True when the virtual clock sits before this conversation's newest known
 * message — i.e. the student has travelled back behind their own history.
 *
 * The comparison carries BACKWARD_SEEK_THRESHOLD_MS of slack, and that slack is
 * load-bearing rather than defensive padding. The streamer stamps each reply
 * with whole-second RFC3339 at its own reading of the client's virtual time, so
 * a reply can legitimately land a fraction of a second AHEAD of the client
 * clock; an exact `nowMs < markMs` test would blink the composer disabled for
 * about a second after every buddy reply. Reusing the seek threshold also keeps
 * one definition of "a real backward move": a rewind too small to trigger a seek
 * is too small to close the composer.
 *
 * A conversation with no messages yet (`null`) is never rewound — there is
 * nothing to contradict.
 */
export function isRewound(lastMessageAtMs: number | null, nowMs: number): boolean {
	if (lastMessageAtMs === null) return false;
	return nowMs < lastMessageAtMs - BACKWARD_SEEK_THRESHOLD_MS;
}

export interface ComposeGateInput {
	/** The streamer's own enable flag, from chat_state. */
	serverEnabled: boolean;
	reason: ChatStateReason;
	/** Newest message instant for THIS conversation, true UTC ms, or null. */
	lastMessageAtMs: number | null;
	/** The virtual clock as true UTC ms (virtualUtcMs, never a raw localDate). */
	nowMs: number;
	/** Display-timezone offset, for rendering the resume time. */
	tzOffsetHours: number;
}

export interface ComposeGate {
	enabled: boolean;
	hint: string;
	/**
	 * What the message field itself shows. Normally the hint, mirrored — but the
	 * blocked sentence is 530px wide in the theme's 14px Charcoal against a
	 * ~134px field in a default 260px chat window, so mirroring it there shows
	 * "You've traveled ba" and nothing more. Measured in the running desktop,
	 * not guessed. The full sentence still reads in the hint line below, which
	 * wraps.
	 */
	placeholder: string;
}

/** What an unblocked, unhinted field invites you to do. */
const DEFAULT_PLACEHOLDER = "Type a message";
/** Short enough to fit the field whole; the hint line carries the detail. */
const BLOCKED_PLACEHOLDER = "Can't chat yet";

/**
 * The single answer the compose row renders: one combined `enabled` for the
 * field, Send, and the emoticon controls, plus the sentence to show.
 *
 * Being rewound OUTRANKS every wire reason. A Time Machine rewind usually
 * leaves the clock paused as well, so deferring to the server would show
 * "Start the clock to keep talking." — true, but not the blocker that will
 * still be there once the clock is running.
 */
export function composeGate({
	serverEnabled,
	reason,
	lastMessageAtMs,
	nowMs,
	tzOffsetHours,
}: ComposeGateInput): ComposeGate {
	if (lastMessageAtMs !== null && isRewound(lastMessageAtMs, nowMs)) {
		const resumesAt = formatPlayhead(lastMessageAtMs, tzOffsetHours);
		return {
			enabled: false,
			hint: `You've traveled back before your last message. Chat resumes at ${resumesAt}.`,
			placeholder: BLOCKED_PLACEHOLDER,
		};
	}
	const hint = composeHintFor(reason);
	return { enabled: serverEnabled, hint, placeholder: hint || DEFAULT_PLACEHOLDER };
}
