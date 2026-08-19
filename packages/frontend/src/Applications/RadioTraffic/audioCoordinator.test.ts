import { act, cleanup, render } from "@testing-library/react";
import { createElement, useEffect, useSyncExternalStore } from "react";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { isAudioBlocked } from "../radio-core/audioBlocked";
import { calcSeekSeconds } from "../radio-core/stationGrouping";
import {
	type ClockSource,
	clockMoved,
	connectClock,
	ensure,
	hasEnded,
	positionMs,
	release,
	releaseAll,
	resetPlayback,
	seekTo,
	setLevel,
	subscribe,
	unfollowClock,
} from "./audioCoordinator";
import { laneFor } from "./cardStatus";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep renders isolated.
afterEach(cleanup);

function item(over: Partial<MediaItem>): MediaItem {
	return {
		id: 0, title: "t", full_title: "t", start_date: "2001-09-11T12:40:00Z",
		url: "u", format: "mp3", approved: 1, mute: 0, volume: 1, jump: 0, trim: 0, ...over,
	};
}
const t = (s: string) => new Date(s).getTime();

const ITEMS: MediaItem[] = [
	item({ id: 1, url: "a.mp3", start_date: "2001-09-11T12:40:00Z", end_date: "2001-09-11T12:50:00Z" }),
	item({ id: 2, url: "b.mp3", start_date: "2001-09-11T12:45:00Z", end_date: "2001-09-11T12:55:00Z" }),
];

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	playSpy = vi
		.spyOn(window.HTMLMediaElement.prototype, "play")
		.mockResolvedValue(undefined);
	pauseSpy = vi
		.spyOn(window.HTMLMediaElement.prototype, "pause")
		.mockImplementation(() => {});
});
afterAll(() => {
	playSpy.mockRestore();
	pauseSpy.mockRestore();
});

/** A stand-in for the app shell's clock wiring, mutable from each test. */
let nowMs = t("2001-09-11T12:47:00Z");
let clockPaused = false;
let catalogue: MediaItem[] = ITEMS;
const source: ClockSource = {
	nowMs: () => nowMs,
	clockPaused: () => clockPaused,
	itemFor: (id) => catalogue.find((i) => i.id === id),
};

let disconnect: (() => void) | null = null;
function connect(): void {
	disconnect = connectClock(source);
}

/** Drain the play() → then → catch microtask chain. */
const settlePlay = () => act(async () => {});

beforeEach(() => {
	nowMs = t("2001-09-11T12:47:00Z");
	clockPaused = false;
	catalogue = ITEMS;
	playSpy.mockClear();
	pauseSpy.mockClear();
	pauseSpy.mockImplementation(() => {});
	playSpy.mockResolvedValue(undefined);
});

afterEach(() => {
	disconnect?.();
	disconnect = null;
	releaseAll();
});

describe("audioCoordinator registry", () => {
	// The whole reason this module exists: a card is a view over the registry,
	// so a card leaving the tree (filter toggle, lane migration, drag reorder)
	// must not take the playing element with it.
	describe("element lifetime is independent of card lifetime", () => {
		/** A stand-in TrafficCard: asks for its element, owns nothing. */
		function Card({ id, url }: { id: number; url: string }) {
			useEffect(() => {
				ensure(id, url);
			}, [id, url]);
			return null;
		}

		it("keeps the element registered after the card that asked for it unmounts", () => {
			connect();
			const view = render(createElement(Card, { id: 1, url: "a.mp3" }));
			const el = ensure(1, "a.mp3");
			expect(el.getAttribute("src")).toBe("a.mp3");

			view.unmount();

			expect(ensure(1, "a.mp3")).toBe(el);
		});

		it("reads currentTime for a card that is not rendered", () => {
			connect();
			const view = render(createElement(Card, { id: 1, url: "a.mp3" }));
			const el = ensure(1, "a.mp3");
			// timeupdate is what a real browser fires as the position moves; the
			// coordinator samples on that, so the test has to move the clock the
			// same way rather than writing currentTime and hoping.
			el.currentTime = 12;
			el.dispatchEvent(new Event("timeupdate"));
			expect(positionMs(1)).toBe(12_000);

			view.unmount();

			// The badge still has a position to read, and it is the live one: the
			// detached element kept advancing while nothing rendered it.
			expect(positionMs(1)).toBe(12_000);
			el.currentTime = 30;
			el.dispatchEvent(new Event("timeupdate"));
			expect(positionMs(1)).toBe(30_000);
		});

		it("returns the same snapshot between notifications even as the element advances", () => {
			// The useSyncExternalStore contract: getSnapshot must be stable
			// between notifications. Reading el.currentTime live breaks it —
			// the position advances in real time, so two reads inside one render
			// pass differ, React concludes the store changed again, and
			// re-renders without end. That surfaced as "getSnapshot should be
			// cached to avoid an infinite loop" and then "Maximum update depth
			// exceeded" in TrafficCard, but only once a click caused the first
			// render: with nothing re-rendering, the loop had no way to start.
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 5;
			el.dispatchEvent(new Event("timeupdate"));

			const first = positionMs(1);
			// The element keeps moving, as it does during playback...
			el.currentTime = 5.25;
			el.currentTime = 5.5;
			// ...but with no notification, every reader must still see one value.
			expect(positionMs(1)).toBe(first);
			expect(positionMs(1)).toBe(first);

			// And it does move, once the element says so.
			el.dispatchEvent(new Event("timeupdate"));
			expect(positionMs(1)).toBe(5_500);
		});

		it("keeps playing an unmounted card's element rather than pausing it", () => {
			connect();
			const view = render(createElement(Card, { id: 1, url: "a.mp3" }));
			pauseSpy.mockClear();
			view.unmount();
			expect(pauseSpy).not.toHaveBeenCalled();
		});

		it("reports no position for an id that was never registered", () => {
			expect(positionMs(99)).toBeUndefined();
		});
	});

	describe("ensure", () => {
		it("is idempotent — the same id yields the same element", () => {
			connect();
			const first = ensure(1, "a.mp3");
			const second = ensure(1, "a.mp3");
			expect(second).toBe(first);
		});

		it("gives distinct ids distinct elements", () => {
			connect();
			expect(ensure(1, "a.mp3")).not.toBe(ensure(2, "b.mp3"));
		});

		// createMediaElementSource() may be called only once per element and the
		// capture is permanent (audioCapture.ts), so a source swap — the original
		// recording vs the enhanced render — must reuse the element, not replace it.
		it("swaps the source in place when the url changes, keeping the element", () => {
			connect();
			const first = ensure(1, "a.mp3");
			const second = ensure(1, "a-enhanced.mp3");
			expect(second).toBe(first);
			expect(second.getAttribute("src")).toBe("a-enhanced.mp3");
		});

		it("starts an element muted so the autoplay policy permits play()", () => {
			connect();
			expect(ensure(1, "a.mp3").muted).toBe(true);
		});

		it("unmutes only once play() has resolved", async () => {
			connect();
			const el = ensure(1, "a.mp3");
			await settlePlay();
			expect(el.muted).toBe(false);
		});

		it("does not start playback while the clock is paused", () => {
			clockPaused = true;
			connect();
			ensure(1, "a.mp3");
			expect(playSpy).not.toHaveBeenCalled();
		});
	});

	// The mix seam. Who is audible is decided by toolMode's solo/mute model; the
	// coordinator only applies the answer. It has to be a coordinator function
	// rather than `el.muted = …` at the call site because `muted` is already load
	// bearing here: an element starts muted so the autoplay policy permits a
	// gesture-less play(), and a card writing to it directly would either unmute
	// before the gate opens (the play() is then refused) or have its choice
	// overwritten the moment tryPlay resolves.
	describe("setLevel", () => {
		it("silences a playing element without pausing it", async () => {
			connect();
			const el = ensure(1, "a.mp3");
			await settlePlay();
			pauseSpy.mockClear();

			setLevel(1, false);

			expect(el.muted).toBe(true);
			// Silent, not stopped: the clip keeps its clock position, so unmuting it
			// later drops the listener back into the live mix, not to a stale offset.
			expect(pauseSpy).not.toHaveBeenCalled();
		});

		it("brings a silenced element back", async () => {
			connect();
			const el = ensure(1, "a.mp3");
			await settlePlay();
			setLevel(1, false);

			setLevel(1, true);

			expect(el.muted).toBe(false);
		});

		it("never unmutes before the autoplay gate has opened", () => {
			connect();
			const el = ensure(1, "a.mp3");

			setLevel(1, false);
			setLevel(1, true);

			// play() has not resolved yet. Unmuting now is exactly what gets the
			// gesture-less play() refused, which is the bug this seam exists to avoid.
			expect(el.muted).toBe(true);
		});

		it("holds a level set before play() resolved", async () => {
			connect();
			const el = ensure(1, "a.mp3");
			setLevel(1, false);

			await settlePlay();

			// tryPlay unmutes on success — but only up to the requested level.
			expect(el.muted).toBe(true);
		});

		it("tells the card its level changed", async () => {
			connect();
			ensure(1, "a.mp3");
			await settlePlay();
			const cb = vi.fn();
			// Unsubscribed on the way out: a subscription IS a card on screen as
			// far as the coordinator is concerned — it is what says an item still
			// needs a clock-following playhead — so one left behind here shows up
			// as a stray position in a later test.
			const unsubscribe = subscribe(1, cb);

			setLevel(1, false);

			expect(cb).toHaveBeenCalled();
			unsubscribe();
		});

		it("is a no-op for an id that is not registered", () => {
			expect(() => setLevel(99, false)).not.toThrow();
		});
	});

	describe("release", () => {
		// Removing an <audio> element from the DOM does not stop browser playback
		// (StationPlayer.tsx's ref-callback comment). The coordinator's elements are
		// never in the DOM at all, so dropping the entry without pausing would leak
		// audio with no handle left to stop it.
		it("pauses the element before it drops the registry entry", () => {
			connect();
			ensure(1, "a.mp3");
			let registeredWhenPaused: boolean | undefined;
			pauseSpy.mockImplementation(() => {
				registeredWhenPaused = positionMs(1) !== undefined;
			});

			release(1);

			expect(pauseSpy).toHaveBeenCalledTimes(1);
			expect(registeredWhenPaused).toBe(true);
			expect(positionMs(1)).toBeUndefined();
		});

		it("gives a released id a fresh element on the next ensure", () => {
			connect();
			const first = ensure(1, "a.mp3");
			release(1);
			expect(ensure(1, "a.mp3")).not.toBe(first);
		});

		it("ignores an id that is not registered", () => {
			expect(() => release(99)).not.toThrow();
			expect(pauseSpy).not.toHaveBeenCalled();
		});

		it("releaseAll pauses and drops every element", () => {
			connect();
			ensure(1, "a.mp3");
			ensure(2, "b.mp3");
			pauseSpy.mockClear();
			releaseAll();
			expect(pauseSpy).toHaveBeenCalledTimes(2);
			expect(positionMs(1)).toBeUndefined();
			expect(positionMs(2)).toBeUndefined();
		});
	});

	describe("subscribe", () => {
		it("notifies on register, on media events and on release", () => {
			connect();
			const cb = vi.fn();
			const unsubscribe = subscribe(1, cb);

			const el = ensure(1, "a.mp3");
			expect(cb).toHaveBeenCalled();

			cb.mockClear();
			el.dispatchEvent(new Event("timeupdate"));
			expect(cb).toHaveBeenCalledTimes(1);

			cb.mockClear();
			release(1);
			expect(cb).toHaveBeenCalledTimes(1);

			unsubscribe();
			ensure(1, "a.mp3");
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it("notifies only the subscribers of the id that changed", () => {
			connect();
			const one = vi.fn();
			const two = vi.fn();
			const unsubOne = subscribe(1, one);
			const unsubTwo = subscribe(2, two);
			ensure(1, "a.mp3");
			expect(one).toHaveBeenCalled();
			expect(two).not.toHaveBeenCalled();
			unsubOne();
			unsubTwo();
		});

		// The card badge reads the position through useSyncExternalStore, so the
		// pair must satisfy its contract: a stable subscribe and a snapshot that
		// only changes when the underlying value does.
		it("drives useSyncExternalStore for a card badge", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 5;
			// A browser fires timeupdate whenever the position moves, including
			// on a write. jsdom does not, so the test supplies it — otherwise it
			// is asserting that the snapshot tracks a change nothing announced,
			// which is the opposite of the contract this test exists to pin.
			el.dispatchEvent(new Event("timeupdate"));

			function Badge() {
				const ms = useSyncExternalStore(
					(cb) => subscribe(1, cb),
					() => positionMs(1),
				);
				return createElement("span", null, String(ms));
			}
			const view = render(createElement(Badge));
			expect(view.container.textContent).toBe("5000");

			el.currentTime = 9;
			act(() => {
				el.dispatchEvent(new Event("timeupdate"));
			});
			expect(view.container.textContent).toBe("9000");
		});
	});
});

describe("audioCoordinator clock sync", () => {
	// StationPlayer reseeks on a large jump only, so ordinary per-second advance
	// never fights the element's own playback.
	describe("clock jump reseek", () => {
		it("reseeks every registered element on a jump over 5s", () => {
			connect();
			const one = ensure(1, "a.mp3");
			const two = ensure(2, "b.mp3");
			one.currentTime = 0;
			two.currentTime = 0;

			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(one.currentTime).toBe(calcSeekSeconds(ITEMS[0], nowMs));
			expect(two.currentTime).toBe(calcSeekSeconds(ITEMS[1], nowMs));
		});

		it("reseeks an element whose card is not rendered", () => {
			connect();
			const view = render(
				createElement(function Card() {
					useEffect(() => {
						ensure(1, "a.mp3");
					}, []);
					return null;
				}),
			);
			const el = ensure(1, "a.mp3");
			el.currentTime = 0;
			view.unmount();

			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(el.currentTime).toBe(calcSeekSeconds(ITEMS[0], nowMs));
		});

		it("leaves elements alone on an ordinary tick", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 100;

			nowMs = t("2001-09-11T12:47:02Z");
			clockMoved();

			expect(el.currentTime).toBe(100);
		});

		it("reseeks on a backward jump too", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 420;

			nowMs = t("2001-09-11T12:41:00Z");
			clockMoved();

			expect(el.currentTime).toBe(calcSeekSeconds(ITEMS[0], nowMs));
		});

		// An element the shell does not want following the clock — a listener
		// playing a back-catalogue clip from its own start — is identified by the
		// clock source declining to name its item.
		it("leaves an element the clock source does not claim alone", () => {
			catalogue = [ITEMS[1]];
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 3;

			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(el.currentTime).toBe(3);
		});
	});

	describe("drift health check", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("corrects drift over 30s across the whole registry every 15s", () => {
			connect();
			const one = ensure(1, "a.mp3");
			const two = ensure(2, "b.mp3");
			one.currentTime = 0; // 420s behind
			two.currentTime = 0; // 120s behind

			vi.advanceTimersByTime(15_000);

			expect(one.currentTime).toBe(calcSeekSeconds(ITEMS[0], nowMs));
			expect(two.currentTime).toBe(calcSeekSeconds(ITEMS[1], nowMs));
		});

		it("iterates the registry, not a rendered card list", () => {
			connect();
			const view = render(
				createElement(function Card() {
					useEffect(() => {
						ensure(1, "a.mp3");
					}, []);
					return null;
				}),
			);
			const el = ensure(1, "a.mp3");
			el.currentTime = 0;
			view.unmount();

			vi.advanceTimersByTime(15_000);

			expect(el.currentTime).toBe(calcSeekSeconds(ITEMS[0], nowMs));
		});

		it("tolerates drift within 30s rather than jerking the audio", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 410; // expected 420 — 10s behind

			vi.advanceTimersByTime(15_000);

			expect(el.currentTime).toBe(410);
		});

		it("restarts a paused element", () => {
			connect();
			ensure(1, "a.mp3");
			playSpy.mockClear();

			vi.advanceTimersByTime(15_000);

			expect(playSpy).toHaveBeenCalled();
		});

		it("does nothing while the clock is paused", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 0;
			clockPaused = true;
			playSpy.mockClear(); // ensure() already started it, before the pause

			vi.advanceTimersByTime(15_000);

			expect(el.currentTime).toBe(0);
			expect(playSpy).not.toHaveBeenCalled();
		});

		it("stops once the clock is disconnected", () => {
			connect();
			const el = ensure(1, "a.mp3");
			el.currentTime = 0;
			disconnect?.();
			disconnect = null;

			vi.advanceTimersByTime(60_000);

			expect(el.currentTime).toBe(0);
		});
	});
});

describe("audioCoordinator autoplay handling", () => {
	// One player could afford three document-level capture listeners; ten cards
	// each doing it is thirty listeners firing on every interaction.
	it("registers the gesture-retry listeners once for the whole app", async () => {
		vi.resetModules();
		const addSpy = vi.spyOn(document, "addEventListener");
		const fresh = await import("./audioCoordinator");
		const registrations = () =>
			addSpy.mock.calls
				.map((call) => call[0])
				.filter((type) =>
					["click", "keydown", "pointerdown"].includes(type as string),
				);
		expect(registrations()).toEqual(["click", "keydown", "pointerdown"]);

		fresh.connectClock(source);
		for (let i = 0; i < 10; i++) fresh.ensure(i, `clip-${i}.mp3`);
		expect(registrations()).toEqual(["click", "keydown", "pointerdown"]);

		fresh.releaseAll();
		addSpy.mockRestore();
	});

	describe("audioBlocked signal", () => {
		it("marks blocked when play() is refused and clears on the retry gesture", async () => {
			connect();
			playSpy.mockRejectedValue(
				new DOMException("autoplay blocked", "NotAllowedError"),
			);
			ensure(1, "a.mp3");
			await settlePlay();
			expect(isAudioBlocked()).toBe(true);

			playSpy.mockResolvedValue(undefined);
			document.dispatchEvent(new Event("click"));
			await settlePlay();
			expect(isAudioBlocked()).toBe(false);
		});

		it("clears the token when the element is released while still blocked", async () => {
			connect();
			playSpy.mockRejectedValue(
				new DOMException("autoplay blocked", "NotAllowedError"),
			);
			ensure(1, "a.mp3");
			await settlePlay();
			expect(isAudioBlocked()).toBe(true);

			release(1);
			expect(isAudioBlocked()).toBe(false);
		});

		// Safari lets a muted play() RESOLVE and then punishes the gesture-less
		// unmute with a silent pause — no rejection anywhere.
		it("marks blocked on a pause it did not initiate", () => {
			connect();
			const el = ensure(1, "a.mp3");
			expect(isAudioBlocked()).toBe(false);
			el.dispatchEvent(new Event("pause"));
			expect(isAudioBlocked()).toBe(true);
			release(1);
			expect(isAudioBlocked()).toBe(false);
		});

		it("ignores the pause that release itself performs", () => {
			connect();
			// jsdom's pause() fires no event, so replay the browser's ordering by
			// hand: release removes the listener before pausing, so a pause event
			// delivered afterwards must not be read as an autoplay refusal.
			const el = ensure(1, "a.mp3");
			release(1);
			el.dispatchEvent(new Event("pause"));
			expect(isAudioBlocked()).toBe(false);
		});

		it("ignores the pause caused by the clock pausing", () => {
			connect();
			const el = ensure(1, "a.mp3");
			clockPaused = true;
			el.dispatchEvent(new Event("pause"));
			expect(isAudioBlocked()).toBe(false);
		});

		it("does not retry on a gesture while the clock is paused", () => {
			connect();
			ensure(1, "a.mp3");
			clockPaused = true;
			playSpy.mockClear();
			document.dispatchEvent(new Event("click"));
			expect(playSpy).not.toHaveBeenCalled();
		});

		it("leaves an already-playing element alone on a gesture", () => {
			connect();
			ensure(1, "a.mp3");
			const pausedSpy = vi
				.spyOn(window.HTMLMediaElement.prototype, "paused", "get")
				.mockReturnValue(false);
			playSpy.mockClear();
			document.dispatchEvent(new Event("click"));
			expect(playSpy).not.toHaveBeenCalled();
			pausedSpy.mockRestore();
		});

		// A listener who paused a back-catalogue clip must not have it restarted by
		// their next click anywhere in the desktop.
		it("does not retry an element the clock source does not claim", () => {
			catalogue = [];
			connect();
			ensure(1, "a.mp3");
			playSpy.mockClear();
			document.dispatchEvent(new Event("click"));
			expect(playSpy).not.toHaveBeenCalled();
		});

		// The overlay bug. "The clock does not claim this element" is a reason not
		// to RESTART it; it is not a reason to leave it holding the token that is
		// keeping "click anywhere to start audio" on screen, because nothing else
		// will ever clear that token and the listener has no other move to make.
		//
		// Two ordinary elements land here: a listener-started PREVIOUS clip, for
		// which the shell's itemFor returns undefined on purpose, and a LIVE card
		// whose item arrived via the history snapshot or the reveal buffer instead
		// of the live mp3 set.
		it("retries a BLOCKED element the clock source does not claim", async () => {
			catalogue = [];
			connect();
			playSpy.mockRejectedValue(
				new DOMException("autoplay blocked", "NotAllowedError"),
			);
			ensure(1, "a.mp3");
			await settlePlay();
			expect(isAudioBlocked()).toBe(true);

			playSpy.mockResolvedValue(undefined);
			document.dispatchEvent(new Event("click"));
			await settlePlay();
			expect(isAudioBlocked()).toBe(false);
		});

		// The Safari shape of the same thing: the muted play() resolved, so the
		// element was never "refused", and then the gesture-less unmute got it
		// paused. The token is real either way.
		it("retries after a pause it did not initiate, even unclaimed", async () => {
			catalogue = [];
			connect();
			const el = ensure(1, "a.mp3");
			await settlePlay();
			el.dispatchEvent(new Event("pause"));
			expect(isAudioBlocked()).toBe(true);

			playSpy.mockClear();
			document.dispatchEvent(new Event("click"));
			await settlePlay();
			expect(playSpy).toHaveBeenCalled();
			expect(isAudioBlocked()).toBe(false);
		});

		// Every blocked element has to clear, not just the first: the overlay is
		// "any token present", so one card left behind keeps it on screen over a
		// grid that is otherwise playing.
		it("clears every blocked element's token on one gesture", async () => {
			connect();
			playSpy.mockRejectedValue(
				new DOMException("autoplay blocked", "NotAllowedError"),
			);
			ensure(1, "a.mp3");
			ensure(2, "b.mp3");
			await settlePlay();
			expect(isAudioBlocked()).toBe(true);

			playSpy.mockResolvedValue(undefined);
			document.dispatchEvent(new Event("click"));
			await settlePlay();
			expect(isAudioBlocked()).toBe(false);
		});

		// A refusal that survives the gesture must leave the overlay up rather
		// than flickering it away — the listener's click genuinely did not work.
		it("keeps the overlay up when the retry is refused again", async () => {
			connect();
			playSpy.mockRejectedValue(
				new DOMException("autoplay blocked", "NotAllowedError"),
			);
			ensure(1, "a.mp3");
			await settlePlay();

			document.dispatchEvent(new Event("click"));
			await settlePlay();
			expect(isAudioBlocked()).toBe(true);
		});
	});
});

// A card's playhead is not "where the <audio> element is" — it is "where this
// clip is right now", and most cards have no element at all: an UPCOMING clip
// has not started, a PREVIOUS one is over, and a LIVE one the listener stopped
// has been released. Those cards used to read zero and stay there. Clock-follow
// is what makes them read the truth, and the two ways a listener takes a card
// off it — scrubbing and pausing — are what makes the number theirs again.
describe("audioCoordinator clock-follow", () => {
	/** A rendered card: the coordinator keeps a playhead for what is watched. */
	function watch(itemId: number): () => void {
		return subscribe(itemId, () => {});
	}

	const clockMsInto = (subject: MediaItem) => calcSeekSeconds(subject, nowMs) * 1000;

	it("answers with the clock's position for a card that has no element", () => {
		// The frozen-at-zero bug: positionMs used to speak only for registered
		// elements, so every UPCOMING and PREVIOUS card drew its playhead at 0.
		connect();
		const unwatch = watch(1);
		expect(positionMs(1)).toBe(clockMsInto(ITEMS[0]));
		unwatch();
	});

	it("advances that playhead on an ordinary tick, not only on a jump", () => {
		// A per-second advance is below the reseek threshold and deliberately
		// leaves playing elements alone — but it is the ONLY thing that moves a
		// card with no element of its own.
		connect();
		const unwatch = watch(1);
		nowMs = t("2001-09-11T12:47:02Z");
		clockMoved();
		expect(positionMs(1)).toBe(422_000);
		unwatch();
	});

	it("keeps an untouched item advancing past the end of its clip", () => {
		// ITEMS[0] runs 12:40 → 12:50. Left alone, the card must both keep
		// counting and land in PREVIOUS: the lane and the playhead read the same
		// clock, so they cannot disagree about when a clip is over.
		connect();
		const unwatch = watch(1);
		nowMs = t("2001-09-11T12:51:00Z");
		clockMoved();
		expect(positionMs(1)).toBe(660_000);
		expect(laneFor(ITEMS[0], nowMs)).toBe("previous");
		unwatch();
	});

	it("reports no position for a card nothing is watching", () => {
		// Bounds the cache: the coordinator keeps a clock playhead for the cards
		// on screen and the elements it owns, not for all 814 items.
		connect();
		expect(positionMs(1)).toBeUndefined();
	});

	it("prefers the element's own position once there is one", () => {
		// A playing clip drifts from the clock — that gap IS the drift badge — so
		// the element must win wherever there is one to ask.
		connect();
		const unwatch = watch(1);
		const el = ensure(1, "a.mp3");
		el.currentTime = 3;
		el.dispatchEvent(new Event("timeupdate"));
		expect(positionMs(1)).toBe(3_000);
		unwatch();
	});

	describe("seekTo", () => {
		it("moves the element and refreshes the snapshot in one step", () => {
			// The whole reason cards do not write el.currentTime themselves: the
			// snapshot is cached, so a write that skips the coordinator leaves
			// every reader looking at a position the clip has already left.
			connect();
			const el = ensure(1, "a.mp3");
			const cb = vi.fn();
			const unwatch = subscribe(1, cb);
			cb.mockClear();

			seekTo(1, 90_000);

			expect(el.currentTime).toBe(90);
			expect(positionMs(1)).toBe(90_000);
			expect(cb).toHaveBeenCalled();
			unwatch();
		});

		it("positions a card that has no element at all", () => {
			connect();
			const unwatch = watch(1);
			seekTo(1, 5_000);
			expect(positionMs(1)).toBe(5_000);
			unwatch();
		});

		it("clamps a negative position to the start of the clip", () => {
			connect();
			const el = ensure(1, "a.mp3");
			seekTo(1, -4_000);
			expect(el.currentTime).toBe(0);
		});

		it("ignores a card nothing is watching and nothing owns", () => {
			connect();
			expect(() => seekTo(99, 1_000)).not.toThrow();
			expect(positionMs(99)).toBeUndefined();
		});
	});

	describe("taking a card off clock-follow", () => {
		it("parks a scrubbed card instead of advancing it", () => {
			connect();
			const unwatch = watch(1);

			seekTo(1, 5_000);
			nowMs = t("2001-09-11T12:47:02Z");
			clockMoved();

			expect(positionMs(1)).toBe(5_000);
			unwatch();
		});

		it("freezes a paused card where its element left it", () => {
			connect();
			const unwatch = watch(1);
			const el = ensure(1, "a.mp3");
			el.currentTime = 12;
			el.dispatchEvent(new Event("timeupdate"));

			// What the transport button does, in the order the shell does it: the
			// card declares the pause, then the shell drops the element.
			unfollowClock(1);
			release(1);

			nowMs = t("2001-09-11T12:47:30Z");
			clockMoved();

			expect(positionMs(1)).toBe(12_000);
			unwatch();
		});

		it("is per card — a sibling keeps following the clock", () => {
			connect();
			const unwatchOne = watch(1);
			const unwatchTwo = watch(2);

			seekTo(1, 5_000);
			nowMs = t("2001-09-11T12:47:02Z");
			clockMoved();

			expect(positionMs(1)).toBe(5_000);
			expect(positionMs(2)).toBe(clockMsInto(ITEMS[1]));
			unwatchOne();
			unwatchTwo();
		});

		it("leaves a scrubbed element where the listener put it on a clock jump", () => {
			// The Time Machine scrub reseeks the whole registry. A card the
			// listener has positioned by hand is exactly the one it must not touch.
			connect();
			const el = ensure(1, "a.mp3");
			seekTo(1, 30_000);

			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(el.currentTime).toBe(30);
		});

		it("does not restart a scrubbed element on a stray gesture", () => {
			// A click anywhere on the desktop retries playback the clock claims.
			// It must not undo a listener's own scrub, for the same reason it must
			// not restart a back-catalogue clip they paused.
			connect();
			ensure(1, "a.mp3");
			seekTo(1, 30_000);
			playSpy.mockClear();

			document.dispatchEvent(new Event("click"));

			expect(playSpy).not.toHaveBeenCalled();
		});

		it("puts a card back on clock-follow when its element is registered afresh", () => {
			// Pressing play again is the listener handing the clip back to the
			// clock; ensure() creating an element is that moment.
			connect();
			const unwatch = watch(1);
			seekTo(1, 5_000);

			ensure(1, "a.mp3");
			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(positionMs(1)).toBe(clockMsInto(ITEMS[0]));
			unwatch();
		});

		it("survives the card unmounting and coming back", () => {
			// A tag filter unmounts a card and re-checking it mounts a new one.
			// That is not the listener changing their mind about where they put
			// the playhead — and the element behind a card survives exactly the
			// same round trip, for exactly the same reason.
			connect();
			const unwatch = watch(1);
			seekTo(1, 5_000);

			unwatch();
			const rewatch = watch(1);
			nowMs = t("2001-09-11T12:47:02Z");
			clockMoved();

			expect(positionMs(1)).toBe(5_000);
			rewatch();
		});

		it("does not re-follow merely because ensure() was called again", () => {
			// The shell calls ensure() for every LIVE item on every lane change.
			// If that cleared the opt-out, a scrub would survive about a second.
			connect();
			const el = ensure(1, "a.mp3");
			seekTo(1, 30_000);

			ensure(1, "a.mp3");
			nowMs = t("2001-09-11T12:57:00Z");
			clockMoved();

			expect(el.currentTime).toBe(30);
		});
	});

	// Story 038. A back-catalogue clip the listener started is the one kind of
	// playback that ENDS while its card stays on screen — a LIVE card's clip is
	// over when the clock says so, and the lane takes the card with it. Nothing
	// was watching for that, so the card kept its playing chrome for good.
	//
	// The reset is the inverse of starting: whatever the listener did to this
	// item — start it, scrub it, run it to the end — the card afterwards has to
	// be indistinguishable from one that was never touched, or the next press of
	// play inherits the last one's leftovers.
	describe("hasEnded", () => {
		/** jsdom never reaches the end of a clip, so say so on this element only. */
		function markEnded(el: HTMLAudioElement): void {
			Object.defineProperty(el, "ended", { get: () => true, configurable: true });
		}

		it("reports a finished element", () => {
			connect();
			const el = ensure(1, "a.mp3");
			expect(hasEnded(1)).toBe(false);

			markEnded(el);

			expect(hasEnded(1)).toBe(true);
		});

		it("is false for an item with no element of its own", () => {
			// Most cards on screen are in exactly this state — UPCOMING, PREVIOUS,
			// or LIVE and stopped — and none of them has finished anything.
			connect();
			const unwatch = watch(1);
			expect(hasEnded(1)).toBe(false);
			expect(hasEnded(99)).toBe(false);
			unwatch();
		});

		it("tells the card the moment the clip ends", () => {
			// The card learns through the same subscription it reads its playhead
			// from; without a notification on `ended` it would find out on the next
			// timeupdate, and a finished element sends none.
			connect();
			const cb = vi.fn();
			const unwatch = subscribe(1, cb);
			const el = ensure(1, "a.mp3");
			cb.mockClear();

			markEnded(el);
			el.dispatchEvent(new Event("ended"));

			expect(cb).toHaveBeenCalled();
			unwatch();
		});
	});

	describe("resetPlayback", () => {
		function markEnded(el: HTMLAudioElement): void {
			Object.defineProperty(el, "ended", { get: () => true, configurable: true });
		}

		it("leaves a finished clip exactly where an untouched one sits", () => {
			connect();
			const unwatch = watch(1);
			// What the card reads before the listener ever presses play.
			const untouched = positionMs(1);
			const el = ensure(1, "a.mp3");
			el.currentTime = 42;
			el.dispatchEvent(new Event("timeupdate"));
			markEnded(el);

			resetPlayback(1);

			expect(positionMs(1)).toBe(untouched);
			expect(hasEnded(1)).toBe(false);
			unwatch();
		});

		it("stops the sound rather than leaving a finished element registered", () => {
			connect();
			ensure(1, "a.mp3");
			pauseSpy.mockClear();

			resetPlayback(1);

			expect(pauseSpy).toHaveBeenCalledTimes(1);
		});

		it("hands a scrubbed card back to the clock", () => {
			// The case that makes this more than "release it". A listener who
			// scrubbed the clip took it off clock-follow, and that opt-out outlives
			// both the element and the card on purpose — so a reset that cleared
			// only the element would leave the card frozen on the playhead they
			// parked, for the rest of the session.
			connect();
			const unwatch = watch(1);
			ensure(1, "a.mp3");
			seekTo(1, 5_000);
			expect(positionMs(1)).toBe(5_000);

			resetPlayback(1);
			nowMs = t("2001-09-11T12:47:02Z");
			clockMoved();

			expect(positionMs(1)).toBe(clockMsInto(ITEMS[0]));
			unwatch();
		});

		it("parks nothing at all for a clip the clock does not claim", () => {
			// A back-catalogue item the shell declines to name — it plays from its
			// own start, not the clock's — has no clock position to fall back to.
			// Idle for that card is "no playhead", not "the one it stopped at".
			catalogue = [];
			connect();
			const unwatch = watch(1);
			const el = ensure(1, "a.mp3");
			el.currentTime = 42;
			el.dispatchEvent(new Event("timeupdate"));

			resetPlayback(1);

			expect(positionMs(1)).toBeUndefined();
			unwatch();
		});

		it("lets the same clip be played again, from the top", () => {
			connect();
			const first = ensure(1, "a.mp3");
			first.currentTime = 42;

			resetPlayback(1);
			const second = ensure(1, "a.mp3");

			expect(second).not.toBe(first);
			expect(second.currentTime).toBe(0);
		});

		it("tells the card its state changed", () => {
			connect();
			ensure(1, "a.mp3");
			const cb = vi.fn();
			const unwatch = subscribe(1, cb);
			cb.mockClear();

			resetPlayback(1);

			expect(cb).toHaveBeenCalled();
			unwatch();
		});

		it("ignores an item that was never played", () => {
			connect();
			expect(() => resetPlayback(99)).not.toThrow();
			expect(pauseSpy).not.toHaveBeenCalled();
		});
	});

	describe("the drift health check", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("does not drag a scrubbed element back into sync", () => {
			// 30s of tolerance, and a scrub is usually further than that — without
			// the opt-out the listener's position would survive at most 15s.
			connect();
			const el = ensure(1, "a.mp3");
			seekTo(1, 10_000);

			vi.advanceTimersByTime(15_000);

			expect(el.currentTime).toBe(10);
		});
	});
});
