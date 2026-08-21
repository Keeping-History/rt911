import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Transcript panel fetches and parses the clip's VTT itself (classicy
// exposes no cue list to reuse — see tabs/transcriptCues.ts), so the seam this
// suite stubs is the network, not a hook. The cue below spans 40-45s, which is
// what lets a test read back which position the card handed the panel.
const VTT = "WEBVTT\n\n00:00:40.000 --> 00:00:45.000\nForty-second cue.\n\n00:01:00.000 --> 00:01:05.000\nMinute cue.\n";
vi.stubGlobal(
	"fetch",
	vi.fn(async () => ({ ok: true, status: 200, text: async () => VTT })),
);

// The <audio> elements live in the coordinator, not in the card, and Step 16
// deliberately made positionMs answer for items that are not rendered. Stubbing
// it is how this suite pins what the card DOES with that number — and, for the
// two writes the card makes, that it goes through the coordinator at all rather
// than reaching for an element it does not own.
const audio = vi.hoisted(() => ({
	positionMs: undefined as number | undefined,
	ended: false,
	/** The real subscribe's callbacks, so a test can announce a media event. */
	listeners: new Set<() => void>(),
	seekTo: vi.fn(),
	unfollowClock: vi.fn(),
	resetPlayback: vi.fn(),
}));
vi.mock("./audioCoordinator", () => ({
	positionMs: () => audio.positionMs,
	hasEnded: () => audio.ended,
	subscribe: (_itemId: number, cb: () => void) => {
		audio.listeners.add(cb);
		return () => {
			audio.listeners.delete(cb);
		};
	},
	seekTo: (itemId: number, ms: number) => audio.seekTo(itemId, ms),
	unfollowClock: (itemId: number) => audio.unfollowClock(itemId),
	resetPlayback: (itemId: number) => {
		audio.resetPlayback(itemId);
		// The real one releases the element, which is what makes both of these
		// true again — modelled here so the card is not tested against a
		// coordinator that behaves differently from the one it ships with.
		audio.ended = false;
		audio.positionMs = undefined;
	},
}));

import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import { visibleCardTabs } from "./CardTabBar";
import { makeItem, makeMeta } from "./tabs/cardTabFixtures";
import { TrafficCard } from "./TrafficCard";

afterEach(cleanup);

/** The fixture clip runs 12:46:31 → 12:49:44 UTC: 193 seconds. */
const START_MS = Date.parse("2001-09-11T12:46:31Z");
const DURATION_MS = 193_000;

function renderCard(
	props: {
		item?: MediaItem;
		meta?: ItemMeta;
		lane?: Lane;
		nowMs?: number;
		seeking?: boolean;
		userPlaying?: boolean;
		muted?: boolean;
		paused?: boolean;
		onTogglePause?: () => void;
		onManualSeek?: () => void;
		onToggleMute?: () => void;
		onTabSelect?: () => void;
	} = {},
) {
	return render(
		<TrafficCard
			item={props.item ?? makeItem()}
			meta={props.meta}
			lane={props.lane ?? "live"}
			tzOffsetHours={-4}
			nowMs={props.nowMs ?? START_MS}
			seeking={props.seeking}
			userPlaying={props.userPlaying}
			muted={props.muted}
			paused={props.paused}
			onTogglePause={props.onTogglePause ?? (() => {})}
			onManualSeek={props.onManualSeek}
			onToggleMute={props.onToggleMute}
			onTabSelect={props.onTabSelect}
		/>,
	);
}

function headerText(container: HTMLElement): string {
	return container.querySelector("[data-card-title]")?.textContent ?? "";
}

function badgeText(container: HTMLElement): string | null {
	return container.querySelector("[data-badge]")?.textContent ?? null;
}

/**
 * jsdom lays nothing out, so the waveform's box is all zeroes and there is no
 * fraction for a click to land in. 200px wide at the origin makes clientX read
 * straight off as a percentage.
 */
function stubWaveformBox() {
	vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
		left: 0,
		width: 200,
		top: 0,
		height: 40,
		right: 200,
		bottom: 40,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
}

beforeEach(() => {
	audio.positionMs = undefined;
	audio.ended = false;
	audio.listeners.clear();
	audio.seekTo.mockClear();
	audio.unfollowClock.mockClear();
	audio.resetPlayback.mockClear();
	// PeaksWaveform's effect calls getContext on the way to bailing out (jsdom
	// lays nothing out, so there is no width to draw into), and jsdom's
	// unimplemented one writes a "Not implemented" line to stderr every time.
	// Same stub PeaksWaveform.test.tsx uses to keep its own output clean.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		{ fillStyle: "", clearRect: () => {}, fillRect: () => {} } as unknown as CanvasRenderingContext2D,
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TrafficCard header", () => {
	it("shows the subject when the item has metadata", () => {
		const { container } = renderCard({ meta: makeMeta() });
		expect(headerText(container)).toBe(makeMeta().subject);
	});

	it("falls back to full_title for an item with no metadata", () => {
		// 59 of the 814 mp3 items are absent from the mp3_meta frame entirely.
		// They are not an error state — they are 7% of the corpus.
		const { container } = renderCard({ meta: undefined });
		expect(headerText(container)).toBe(makeItem().full_title);
	});

	it("falls back to full_title when the subject is present but blank", () => {
		const { container } = renderCard({ meta: makeMeta({ subject: "   " }) });
		expect(headerText(container)).toBe(makeItem().full_title);
	});
});

describe("TrafficCard badge", () => {
	it("counts down on an UPCOMING card", () => {
		const { container } = renderCard({ lane: "upcoming", nowMs: START_MS - 4_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("countdown");
		expect(badgeText(container)).toBe("4s");
	});

	it("reads in sync on a LIVE card whose audio is where the clock says", () => {
		audio.positionMs = 60_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("in-sync");
	});

	it("reports signed drift on a LIVE card whose audio lags", () => {
		audio.positionMs = 54_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("drift");
		expect(badgeText(container)).toBe("-6s");
	});

	it("shows SEEKING on a LIVE card mid-seek, in place of the drift noise", () => {
		audio.positionMs = 0;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000, seeking: true });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("seeking");
	});

	it("shows no badge at all on an idle PREVIOUS card", () => {
		// badgeFor returns null here on purpose: every variant would assert
		// something untrue about a clip that is neither playing nor tracking.
		const { container } = renderCard({ lane: "previous", nowMs: START_MS + DURATION_MS + 5_000 });
		expect(container.querySelector("[data-badge]")).toBeNull();
	});

	it("shows PLAYING on a PREVIOUS card the listener started", () => {
		const { container } = renderCard({
			lane: "previous",
			nowMs: START_MS + DURATION_MS + 5_000,
			userPlaying: true,
		});
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("playing");
	});
});

describe("TrafficCard waveform", () => {
	it("passes the scrubbers 0..1 fractions, not percentages", () => {
		// The load-bearing units bug: PeaksWaveform clamps to 0..1, so a 0..100
		// percentage parks both markers hard against the right edge and the card
		// silently stops reporting position at all.
		audio.positionMs = DURATION_MS / 4;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + DURATION_MS / 2 });
		expect(container.querySelector('[data-scrubber="live"]')?.getAttribute("data-pct")).toBe("0.5");
		expect(container.querySelector('[data-scrubber="current"]')?.getAttribute("data-pct")).toBe(
			"0.25",
		);
	});

	it("puts both scrubbers inside the waveform slot", () => {
		// PeaksWaveform renders a bare fragment and positions its scrubbers
		// absolutely, so the containing block is the card's job. If the slot is
		// not their offset parent the markers land against the card frame and
		// report the wrong instant.
		audio.positionMs = 1_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 1_000 });
		const slot = container.querySelector("[data-card-waveform]");
		expect(slot?.querySelector('[data-scrubber="live"]')).not.toBeNull();
		expect(slot?.querySelector('[data-scrubber="current"]')).not.toBeNull();
		expect(slot?.querySelector("canvas")).not.toBeNull();
	});

	it("draws no live marker on an UPCOMING card", () => {
		// Nothing has played yet, and a marker pinned at 0 would claim otherwise.
		const { container } = renderCard({ lane: "upcoming", nowMs: START_MS - 30_000 });
		expect(container.querySelector('[data-scrubber="live"]')).toBeNull();
	});

	it("lets the waveform take its size from the card, not from a number", () => {
		// Story 034 replaces the card's fixed sizing with a flex/row model. A
		// bitmap authored from a constant in this file would be the one thing
		// that could not follow it, so the height is CSS's to decide and the
		// canvas measures itself — which is also why the markers stretch rather
		// than carrying a pixel height of their own.
		audio.positionMs = 1_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 1_000 });
		expect(container.querySelector("canvas")?.getAttribute("height")).toBeNull();
		expect(
			container.querySelector<HTMLElement>('[data-scrubber="live"]')?.style.height,
		).toBe("100%");
	});
});

describe("TrafficCard seeking", () => {
	it("seeks through the coordinator when the waveform is clicked", () => {
		// NOT `el.currentTime = …` from here. The coordinator caches the position
		// its subscribers read, so a card writing to the element directly would
		// move the audio and leave every reader — this card's own badge included
		// — looking at the position the clip had already left.
		stubWaveformBox();
		const { container } = renderCard({ lane: "live" });

		fireEvent.pointerDown(container.querySelector("canvas")!, { clientX: 50 });

		expect(audio.seekTo).toHaveBeenCalledWith(makeItem().id, DURATION_MS / 4);
	});

	it("follows a drag across the waveform", () => {
		stubWaveformBox();
		const { container } = renderCard({ lane: "live" });

		fireEvent.pointerDown(container.querySelector("canvas")!, { clientX: 100 });
		fireEvent.pointerMove(window, { clientX: 150 });

		expect(audio.seekTo.mock.calls.map(([, ms]) => ms)).toEqual([
			DURATION_MS / 2,
			(DURATION_MS * 3) / 4,
		]);
	});

	it("keeps a scrub from also firing the lane's active tool", () => {
		// The card sits in a slot whose pointerup applies the tool palette's
		// current tool. Without this, letting go of a scrub under the mute tool
		// would also mute the card.
		stubWaveformBox();
		const onSlotPointerUp = vi.fn();
		const { container } = render(
			<div onPointerUp={onSlotPointerUp}>
				<TrafficCard
					item={makeItem()}
					lane="live"
					tzOffsetHours={-4}
					nowMs={START_MS}
					onTogglePause={() => {}}
				/>
			</div>,
		);

		fireEvent.pointerUp(container.querySelector("canvas")!);

		expect(onSlotPointerUp).not.toHaveBeenCalled();
	});

	it("offers no seek at all for a clip of unknown length", () => {
		// Without a duration there is no map from a fraction of the envelope to
		// an instant in the recording, so a click would have to invent one.
		stubWaveformBox();
		const endless = { ...makeItem(), end_date: undefined, calc_duration: undefined };
		const { container } = renderCard({ item: endless, lane: "live" });

		fireEvent.pointerDown(container.querySelector("canvas")!, { clientX: 50 });

		expect(audio.seekTo).not.toHaveBeenCalled();
	});

	it("reports a scrub to the shell in addition to seeking through the coordinator", () => {
		// RadioTraffic.tsx's Story 045 hold reads this signal, not seekTo — the
		// card has no idea a hold exists, it only reports the touch.
		stubWaveformBox();
		const onManualSeek = vi.fn();
		const { container } = renderCard({ lane: "live", onManualSeek });

		fireEvent.pointerDown(container.querySelector("canvas")!, { clientX: 50 });

		expect(audio.seekTo).toHaveBeenCalled();
		expect(onManualSeek).toHaveBeenCalledTimes(1);
	});

	it("does not report a scrub when the clip has no duration to seek within", () => {
		// Same guard as the seek itself above — no seek happened, so nothing was
		// actually scrubbed for the shell to hold onto.
		stubWaveformBox();
		const onManualSeek = vi.fn();
		const endless = { ...makeItem(), end_date: undefined, calc_duration: undefined };
		renderCard({ item: endless, lane: "live", onManualSeek });
		// PeaksWaveform is never given onSeekPct at all for a durationless clip
		// (TrafficCard.tsx: `durationMs > 0 ? onSeekPct : undefined`), so there is
		// no canvas listener to fire in the first place — nothing to assert beyond
		// onManualSeek staying untouched through render.
		expect(onManualSeek).not.toHaveBeenCalled();
	});
});

describe("TrafficCard rewind", () => {
	it("seeks to the start of the recording through the coordinator", () => {
		// NOT `el.currentTime = 0` from here, for the same reason a waveform
		// scrub isn't: the coordinator caches the position every reader —
		// this card's own badge included — is looking at.
		const { getByRole } = renderCard({ lane: "live" });

		fireEvent.click(getByRole("button", { name: "Rewind to start" }));

		expect(audio.seekTo).toHaveBeenCalledWith(makeItem().id, 0);
	});

	it("reports the rewind to the shell in addition to seeking", () => {
		// Same signal a scrub reports (Story 045's hold) — a deliberate rewind
		// is exactly the kind of press that should take a LIVE card off the
		// clock the way dragging the waveform does.
		const onManualSeek = vi.fn();
		const { getByRole } = renderCard({ lane: "live", onManualSeek });

		fireEvent.click(getByRole("button", { name: "Rewind to start" }));

		expect(onManualSeek).toHaveBeenCalledTimes(1);
	});

	it("is offered even when the clip is paused", () => {
		// Rewind resets position, not playback state — it must not require
		// the card to already be playing.
		const { getByRole } = renderCard({ lane: "live", paused: true });

		fireEvent.click(getByRole("button", { name: "Rewind to start" }));

		expect(audio.seekTo).toHaveBeenCalledWith(makeItem().id, 0);
	});

	it("keeps a rewind from also firing the lane's active tool", () => {
		// Same collision the mute button and the waveform already guard
		// against: the card sits in a slot whose pointerup applies the tool
		// palette's current tool.
		const onSlotPointerUp = vi.fn();
		const { getByRole } = render(
			<div onPointerUp={onSlotPointerUp}>
				<TrafficCard
					item={makeItem()}
					lane="live"
					tzOffsetHours={-4}
					nowMs={START_MS}
					onTogglePause={() => {}}
				/>
			</div>,
		);

		fireEvent.pointerUp(getByRole("button", { name: "Rewind to start" }));

		expect(onSlotPointerUp).not.toHaveBeenCalled();
	});
});

// Story 028. A card follows the virtual clock until the listener says
// otherwise; the transport button is one of the two ways they say it.
describe("TrafficCard clock-follow", () => {
	it("takes the card off clock-follow when the transport pauses it", () => {
		const { getByRole } = renderCard({ paused: false });
		fireEvent.click(getByRole("button", { name: "Pause" }));
		expect(audio.unfollowClock).toHaveBeenCalledWith(makeItem().id);
	});

	it("leaves clock-follow alone when the transport resumes it", () => {
		// Pressing play hands the clip back to the clock — the shell registers a
		// fresh element, which is what puts it back on. Unfollowing here would
		// park the playhead of the very card that just started running.
		const { getByRole } = renderCard({ paused: true });
		fireEvent.click(getByRole("button", { name: "Play" }));
		expect(audio.unfollowClock).not.toHaveBeenCalled();
	});

	it("names its own item, so one card's pause cannot park another's", () => {
		const other = { ...makeItem(), id: 4_242 };
		const { getByRole } = renderCard({ item: other, paused: false });
		fireEvent.click(getByRole("button", { name: "Pause" }));
		expect(audio.unfollowClock).toHaveBeenCalledWith(4_242);
	});

	it("resets a PREVIOUS clip instead of parking it", () => {
		// The two lanes stop for opposite reasons. A LIVE card the listener
		// stopped is still running on the clock, so its playhead stays where they
		// left it (story 028). A PREVIOUS clip is a replay they are finished with:
		// parking it would leave the card showing progress it is no longer making,
		// and the next press of play would start from the top anyway.
		const { getByRole } = renderCard({ lane: "previous", userPlaying: true, paused: false });

		fireEvent.click(getByRole("button", { name: "Pause" }));

		expect(audio.resetPlayback).toHaveBeenCalledWith(makeItem().id);
		expect(audio.unfollowClock).not.toHaveBeenCalled();
	});
});

// Story 038. A PREVIOUS clip plays only because the listener pressed play, so
// only they — or the end of the recording — can stop it. Reaching the end used
// to be neither: the element finished, nothing was listening, and the card kept
// its Playing badge and its pause affordance indefinitely.
describe("TrafficCard, a PREVIOUS clip that finishes", () => {
	/** Past the fixture clip's end, which is where a PREVIOUS card lives. */
	const PREVIOUS_NOW = START_MS + DURATION_MS + 5_000;

	/**
	 * The shell's half of the contract, as one card's worth of state: RadioTraffic
	 * keeps a `userStarted` set and derives both `userPlaying` and `paused` from
	 * it, so driving a real toggle here is what proves the round trip rather than
	 * only that a callback fired.
	 */
	function Harness({
		lane = "previous" as Lane,
		onToggle,
	}: {
		lane?: Lane;
		onToggle?: () => void;
	}) {
		const [playing, setPlaying] = useState(true);
		return (
			<TrafficCard
				item={makeItem()}
				lane={lane}
				tzOffsetHours={-4}
				nowMs={PREVIOUS_NOW}
				userPlaying={playing}
				paused={!playing}
				onTogglePause={() => {
					onToggle?.();
					setPlaying((p) => !p);
				}}
			/>
		);
	}

	/** What the coordinator announces when the recording runs out. */
	function endTheClip() {
		act(() => {
			audio.ended = true;
			for (const cb of [...audio.listeners]) cb();
		});
	}

	it("returns the card to idle", () => {
		const { container } = render(<Harness />);
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe(
			"playing",
		);

		endTheClip();

		// badgeFor gives an idle PREVIOUS card no badge at all — every variant
		// would assert something untrue about a clip that is not playing.
		expect(container.querySelector("[data-badge]")).toBeNull();
		expect(container.querySelector("[data-audible]")?.getAttribute("data-audible")).toBe(
			"false",
		);
	});

	it("reverts the transport to the play affordance", () => {
		const { getByRole, queryByRole } = render(<Harness />);
		expect(queryByRole("button", { name: "Pause" })).not.toBeNull();

		endTheClip();

		expect(getByRole("button", { name: "Play" })).not.toBeNull();
		expect(queryByRole("button", { name: "Pause" })).toBeNull();
	});

	it("resets the playhead through the coordinator rather than by hand", () => {
		render(<Harness />);

		endTheClip();

		expect(audio.resetPlayback).toHaveBeenCalledWith(makeItem().id);
	});

	it("hands the clip back exactly once, so it cannot restart itself", () => {
		// The hand-back is a TOGGLE — the shell has one `userStarted` set and one
		// way to change it — so a second call would stop the clip and immediately
		// start it playing again, which reads as the card refusing to stop.
		const onToggle = vi.fn();
		render(<Harness onToggle={onToggle} />);

		endTheClip();
		// Whatever else re-renders the card afterwards: the clock ticks once a
		// second and the shell rebuilds every card's props with it.
		act(() => {
			for (const cb of [...audio.listeners]) cb();
		});

		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it("plays the same clip again immediately afterwards", () => {
		const onToggle = vi.fn();
		const { getByRole } = render(<Harness onToggle={onToggle} />);
		endTheClip();

		fireEvent.click(getByRole("button", { name: "Play" }));

		expect(onToggle).toHaveBeenCalledTimes(2);
		expect(getByRole("button", { name: "Pause" })).not.toBeNull();
	});

	it("leaves a card the listener never started alone", () => {
		// An idle PREVIOUS card reads `ended` false in practice, but nothing about
		// the reset may depend on that: the card that did not start playback is
		// not the card that gets to stop it.
		const onTogglePause = vi.fn();
		audio.ended = true;
		renderCard({
			lane: "previous",
			nowMs: PREVIOUS_NOW,
			userPlaying: false,
			paused: true,
			onTogglePause,
		});

		expect(onTogglePause).not.toHaveBeenCalled();
	});

	it("leaves a LIVE card alone, even one still carrying the started flag", () => {
		// Reachable: a backward seek can move a clip the listener started from
		// PREVIOUS back into LIVE, and the shell keeps the flag while the item is
		// still on screen. There, `onTogglePause` means "stop the live card", so
		// firing it on an ended element would silence a clip the clock says is
		// still running.
		const onToggle = vi.fn();
		render(<Harness lane="live" onToggle={onToggle} />);

		endTheClip();

		expect(onToggle).not.toHaveBeenCalled();
		expect(audio.resetPlayback).not.toHaveBeenCalled();
	});
});

describe("TrafficCard tabs", () => {
	it("exposes six tabs and opens Details first", () => {
		const { getAllByRole, container } = renderCard({ meta: makeMeta() });
		expect(getAllByRole("tab")).toHaveLength(6);
		expect(container.querySelector('[data-tab="details"]')).not.toBeNull();
	});

	it("offers Summary as a tab of its own, not as part of Details", () => {
		const { getByRole, container } = renderCard({ meta: makeMeta() });
		expect(container.querySelector('[data-field="subject"]')).toBeNull();
		fireEvent.click(getByRole("tab", { name: "Summary" }));
		expect(container.querySelector('[data-tab="summary"]')).not.toBeNull();
		expect(container.querySelector('[data-field="subject"]')?.textContent).toBe(
			makeMeta().subject,
		);
	});

	it("still offers a Summary tab to an item with no summary, with an explicit empty state", () => {
		// Story 049: hiding the tab when data is empty was indistinguishable from
		// a bug once `subject` came back null on every one of the 814 rows.
		const { getByRole, queryByRole, container } = renderCard({
			meta: makeMeta({ subject: undefined }),
		});
		expect(queryByRole("tab", { name: "Summary" })).not.toBeNull();
		expect(queryByRole("tab", { name: "Details" })).not.toBeNull();
		fireEvent.click(getByRole("tab", { name: "Summary" }));
		expect(container.querySelector('[data-tab="summary"]')?.textContent).toContain(
			"No summary.",
		);
	});

	it("swaps the panel when another tab is picked", () => {
		const { getByRole, container } = renderCard({ meta: makeMeta() });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		expect(container.querySelector('[data-tab="transcript"]')).not.toBeNull();
		expect(container.querySelector('[data-tab="details"]')).toBeNull();
	});

	it("reports a tab switch to the shell, in addition to swapping the panel (issue #538)", () => {
		const onTabSelect = vi.fn();
		const { getByRole, container } = renderCard({ meta: makeMeta(), onTabSelect });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		expect(container.querySelector('[data-tab="transcript"]')).not.toBeNull();
		expect(onTabSelect).toHaveBeenCalledTimes(1);
	});

	it("does not fail when onTabSelect is omitted, as UPCOMING/PREVIOUS cards do today", () => {
		const { getByRole, container } = renderCard({ meta: makeMeta(), lane: "upcoming" });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		expect(container.querySelector('[data-tab="transcript"]')).not.toBeNull();
	});

	it("hands the transcript panel the element's own position", async () => {
		// The cue marked must follow the <audio> element, not the virtual clock:
		// a drifting card would otherwise highlight words it is not saying. 42s
		// falls inside the first fixture cue and outside the second.
		audio.positionMs = 42_000;
		const { getByRole, container, findByText } = renderCard({ meta: makeMeta() });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		await findByText("Forty-second cue.");
		expect(container.querySelector('[data-active="true"]')?.textContent).toBe(
			"Forty-second cue.",
		);
	});
});

describe("TrafficCard control bar", () => {
	it("toggles the pause button", () => {
		const onTogglePause = vi.fn();
		const { getByRole, rerender } = renderCard({ paused: false, onTogglePause });
		fireEvent.click(getByRole("button", { name: "Pause" }));
		expect(onTogglePause).toHaveBeenCalledTimes(1);

		rerender(
			<TrafficCard
				item={makeItem()}
				lane="live"
				tzOffsetHours={-4}
				nowMs={START_MS}
				paused
				onTogglePause={onTogglePause}
			/>,
		);
		fireEvent.click(getByRole("button", { name: "Play" }));
		expect(onTogglePause).toHaveBeenCalledTimes(2);
	});

	it("reports whether the card is in the mix", () => {
		const audible = renderCard({ muted: false });
		expect(
			audible.container.querySelector("[data-muted]")?.getAttribute("data-muted"),
		).toBe("false");
		cleanup();
		const silent = renderCard({ muted: true });
		expect(silent.container.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe("true");
	});
});

// The three lane colours, the grayed-out UPCOMING treatment and the brightness
// lift on an audible card are all CSS, keyed off these attributes. The hexes
// live in trafficCard.module.scss and are Robbie's to check against Figma; what
// these tests pin is that the card hands the stylesheet the right key — which is
// the half that can silently rot.
describe("TrafficCard lane chrome", () => {
	it("marks the header with the lane the card was put in", () => {
		for (const lane of ["live", "upcoming", "previous"] as const) {
			const { container } = renderCard({ lane, nowMs: START_MS });
			expect(container.querySelector("[data-card-header]")?.getAttribute("data-lane")).toBe(lane);
			cleanup();
		}
	});

	it("takes the header's lane from the prop, never from a second opinion", () => {
		// The card also computes a badge from `lane`; if the header ever derived
		// its own lane the two could disagree and the chrome would contradict the
		// container the card is sitting in.
		const { container } = renderCard({ lane: "previous", nowMs: START_MS });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-lane")).toBe("previous");
		expect(container.querySelector("[data-card-header]")?.getAttribute("data-lane")).toBe(
			"previous",
		);
	});
});

describe("TrafficCard audible state", () => {
	const audibleAttr = (container: HTMLElement) =>
		container.querySelector("[data-audible]")?.getAttribute("data-audible");

	it("marks a card that is playing and unmuted", () => {
		const { container } = renderCard({ lane: "live", muted: false, paused: false });
		expect(audibleAttr(container)).toBe("true");
	});

	it("does not mark a muted card, however much it is playing", () => {
		// This is the distinction the design draws with brightness: "in the mix"
		// means audible, not merely running.
		const { container } = renderCard({ lane: "live", muted: true, paused: false });
		expect(audibleAttr(container)).toBe("false");
	});

	it("does not mark a paused card, however unmuted it is", () => {
		const { container } = renderCard({ lane: "live", muted: false, paused: true });
		expect(audibleAttr(container)).toBe("false");
	});

	it("marks a PREVIOUS card the listener started", () => {
		// Both LIVE and PREVIOUS can be playing; only UPCOMING never can.
		const { container } = renderCard({
			lane: "previous",
			nowMs: START_MS + DURATION_MS + 5_000,
			userPlaying: true,
			muted: false,
			paused: false,
		});
		expect(audibleAttr(container)).toBe("true");
	});

	it("never marks an UPCOMING card, whatever it is handed", () => {
		// An UPCOMING clip has no audio yet — the same rule toolMode.isAudible
		// states. A bright UPCOMING card would claim the listener is hearing a
		// clip that has not started.
		const { container } = renderCard({
			lane: "upcoming",
			nowMs: START_MS - 30_000,
			muted: false,
			paused: false,
		});
		expect(audibleAttr(container)).toBe("false");
	});
});

describe("TrafficCard mute button", () => {
	it("offers a mute control rather than the word MUTED", () => {
		const { getByRole, container } = renderCard({ muted: true });
		expect(getByRole("button", { name: "Unmute" })).not.toBeNull();
		expect(container.textContent).not.toMatch(/muted/i);
	});

	it("names itself for the action it performs, not the state it is in", () => {
		const { getByRole } = renderCard({ muted: false });
		expect(getByRole("button", { name: "Mute" })).not.toBeNull();
	});

	it("reports the card's own mute state to assistive tech", () => {
		const { getByRole } = renderCard({ muted: true });
		expect(getByRole("button", { name: "Unmute" }).getAttribute("aria-pressed")).toBe("true");
		cleanup();
		const unmuted = renderCard({ muted: false });
		expect(unmuted.getByRole("button", { name: "Mute" }).getAttribute("aria-pressed")).toBe(
			"false",
		);
	});

	it("toggles this card's mute state and reflects the result", () => {
		// The card is a view over props, so the state lives in a caller — the same
		// contract onTogglePause already has. Driving it through one here is what
		// proves the round trip, rather than only that a callback fired.
		function Harness() {
			const [muted, setMuted] = useState(false);
			return (
				<TrafficCard
					item={makeItem()}
					lane="live"
					tzOffsetHours={-4}
					nowMs={START_MS}
					muted={muted}
					paused={false}
					onTogglePause={() => {}}
					onToggleMute={() => setMuted((m) => !m)}
				/>
			);
		}
		const { getByRole, container } = render(<Harness />);

		fireEvent.click(getByRole("button", { name: "Mute" }));
		expect(container.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe("true");
		expect(container.querySelector("[data-audible]")?.getAttribute("data-audible")).toBe("false");

		fireEvent.click(getByRole("button", { name: "Unmute" }));
		expect(container.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe("false");
		expect(container.querySelector("[data-audible]")?.getAttribute("data-audible")).toBe("true");
	});

	it("keeps its click to itself, so the active tool does not also fire", () => {
		// The card sits in a slot whose pointerup applies the tool palette's
		// current tool (RadioTraffic's renderCard). Without this, one press on the
		// mute button under the mute tool would both toggle and mute — two edits
		// from one click, and the toggle would appear not to work.
		const onSlotPointerUp = vi.fn();
		const onToggleMute = vi.fn();
		const { getByRole } = render(
			<div onPointerUp={onSlotPointerUp}>
				<TrafficCard
					item={makeItem()}
					lane="live"
					tzOffsetHours={-4}
					nowMs={START_MS}
					onTogglePause={() => {}}
					onToggleMute={onToggleMute}
				/>
			</div>,
		);
		fireEvent.pointerUp(getByRole("button", { name: "Mute" }));
		expect(onSlotPointerUp).not.toHaveBeenCalled();
	});
});

describe("TrafficCard, for an item with no metadata", () => {
	it("renders as a real card on every tab", () => {
		const { container, getByRole } = renderCard({ meta: undefined });
		expect(container.querySelector("[data-lane]")).not.toBeNull();
		// Every tab (visibleCardTabs), including Summary: with no metadata at all
		// there is no summary either, and the panel says so rather than the tab
		// disappearing (story 049).
		for (const tab of visibleCardTabs(undefined)) {
			fireEvent.click(getByRole("tab", { name: tab.label }));
			// Not merely "did not throw": a card whose panel paints an empty box
			// is a dead tab, and 7% of the corpus lands here.
			const panel = container.querySelector(`[data-tab="${tab.id}"]`);
			expect(panel?.textContent?.trim().length).toBeGreaterThan(0);
		}
	});

	it("still marks the lane it sits in", () => {
		const { container } = renderCard({ meta: undefined, lane: "previous" });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-lane")).toBe("previous");
	});
});
