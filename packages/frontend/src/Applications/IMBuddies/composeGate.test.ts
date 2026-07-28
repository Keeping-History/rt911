import { describe, expect, it } from "vitest";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { composeGate, composeHintFor, isRewound } from "./composeGate";

// 2001-09-11T13:07:35Z — the mark. At the product's -4 display offset this is
// 9:07:35 AM, the time the blocked hint must name.
const MARK = Date.parse("2001-09-11T13:07:35Z");
const MIN = 60_000;

function gate(over: Partial<Parameters<typeof composeGate>[0]> = {}) {
	return composeGate({
		serverEnabled: true,
		reason: "ok",
		lastMessageAtMs: MARK,
		nowMs: MARK,
		tzOffsetHours: -4,
		...over,
	});
}

describe("isRewound", () => {
	it("is true once the clock is behind the mark by more than the seek tolerance", () => {
		expect(isRewound(MARK, MARK - 7 * MIN)).toBe(true);
	});

	it("is false at the mark and past it", () => {
		expect(isRewound(MARK, MARK)).toBe(false);
		expect(isRewound(MARK, MARK + MIN)).toBe(false);
	});

	it("tolerates a reply stamped slightly ahead of the client clock", () => {
		// The streamer stamps whole-second RFC3339 at its own reading of the
		// client's virtual time, so a reply can land a fraction of a second
		// ahead. Without the tolerance the composer would blink disabled for a
		// second after every buddy reply.
		expect(isRewound(MARK, MARK - 1_500)).toBe(false);
	});

	it("never blocks a conversation that has no messages yet", () => {
		expect(isRewound(null, MARK - 60 * MIN)).toBe(false);
	});
});

describe("composeGate", () => {
	it("disables the composer and names the resume time when rewound", () => {
		const { enabled, hint } = gate({ nowMs: MARK - 7 * MIN });
		expect(enabled).toBe(false);
		expect(hint).toBe(
			"You've traveled back before your last message. Chat resumes at 9:07:35 AM.",
		);
	});

	it("outranks every wire reason, including the paused clock a rewind leaves behind", () => {
		// A Time Machine rewind usually leaves the clock paused too, so
		// "Start the clock to keep talking." would otherwise mask the real,
		// longer-lived blocker.
		const reasons: ChatStateReason[] = [
			"ok",
			"paused",
			"outside_window",
			"blocked",
			"not_signed_in",
		];
		for (const reason of reasons) {
			const { enabled, hint } = gate({
				reason,
				serverEnabled: false,
				nowMs: MARK - 7 * MIN,
			});
			expect(enabled).toBe(false);
			expect(hint).toMatch(/^You've traveled back/);
		}
	});

	it("defers to the wire reason when not rewound", () => {
		expect(gate({ serverEnabled: false, reason: "paused" })).toEqual({
			enabled: false,
			hint: "Start the clock to keep talking.",
			// Unchanged from before the guard existed: the field mirrors the hint.
			placeholder: "Start the clock to keep talking.",
		});
		expect(gate({ serverEnabled: false, reason: "outside_window" }).hint).toBe(
			"Nobody is online right now.",
		);
	});

	it("is fully enabled with no hint when the server is happy and time is not", () => {
		expect(gate()).toEqual({
			enabled: true,
			hint: "",
			placeholder: "Type a message",
		});
	});

	it("keeps the blocked field's placeholder short enough to read", () => {
		// The blocked sentence measures 530px in the theme's 14px Charcoal
		// against a ~134px field in a default 260px chat window, so mirroring it
		// would show "You've traveled ba" and stop. Measured in the running
		// desktop. The hint line below still carries the whole sentence.
		const { hint, placeholder } = gate({ nowMs: MARK - 7 * MIN });
		expect(placeholder).toBe("Can't chat yet");
		expect(hint).toMatch(/Chat resumes at/);
	});

	it("renders the resume time in the display timezone", () => {
		// Same instant, two offsets: the sentence must follow the desktop clock.
		expect(gate({ nowMs: MARK - 7 * MIN, tzOffsetHours: 0 }).hint).toContain(
			"1:07:35 PM",
		);
		expect(gate({ nowMs: MARK - 7 * MIN, tzOffsetHours: -4 }).hint).toContain(
			"9:07:35 AM",
		);
	});
});

describe("composeHintFor", () => {
	it("gives a different sentence per refusal", () => {
		expect(composeHintFor("paused")).toBe("Start the clock to keep talking.");
		expect(composeHintFor("outside_window")).toBe("Nobody is online right now.");
		expect(composeHintFor("blocked")).toBe("You can't send messages right now.");
		expect(composeHintFor("not_signed_in")).toBe("Sign on to send messages.");
		expect(composeHintFor("ok")).toBe("");
	});
});
