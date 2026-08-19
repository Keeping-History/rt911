import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
	type ItemMeta,
	type MediaItem,
	type TagDef,
} from "../../Providers/MediaStream/MediaStreamContext";
import { calcSeekSeconds } from "../radio-core/stationGrouping";

// ── Doubles ────────────────────────────────────────────────────────────────
// The virtual clock, driven from the test. `paused` matters: audioCoordinator
// refuses to start anything while the clock is stopped, so the default here is
// a RUNNING clock, and Date.now() is frozen by fake timers so the sub-minute
// correction contributes exactly zero unless a test advances it.
const clock = vi.hoisted(() => ({
	utcMs: Date.parse("2001-09-11T12:47:00.000Z"),
	tzOffset: -4,
	paused: false,
}));

const mockAppData = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const mockDispatch = vi.hoisted(() => vi.fn());

vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
		<div data-window-title={title}>{children}</div>
	),
	ClassicyButton: ({
		children,
		onClickFunc,
	}: {
		children?: React.ReactNode;
		onClickFunc?: () => void;
	}) => (
		<button type="button" onClick={onClickFunc}>
			{children}
		</button>
	),
	ClassicyCheckbox: ({
		id,
		label,
		checked,
		onClickFunc,
	}: {
		id?: string;
		label?: string;
		checked?: boolean;
		onClickFunc?: (checked: boolean) => void;
	}) => (
		<label htmlFor={id}>
			<input
				id={id}
				type="checkbox"
				checked={checked ?? false}
				onChange={() => onClickFunc?.(!checked)}
			/>
			{label}
		</label>
	),
	ClassicyInput: ({ id, labelTitle }: { id?: string; labelTitle?: string }) => (
		<input id={id} aria-label={labelTitle} />
	),
	ClassicyLink: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
	ClassicyTriangle: () => <span />,
	ClassicyIcons: { applications: {} },
	quitMenuItemHelper: () => ({ id: "quit", title: "Quit" }),
	registerApp: () => {},
	getAppManifest: () => undefined,
	registerClassicyIcons: <T,>(icons: T) => icons,
	useClassicyHelpMenu: () => {},
	useQuickTimeSubtitles: () => ({ activeCueText: () => "" }),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: { "RadioTraffic.app": { open: true, data: mockAppData.current } },
					},
				},
			},
		}),
	useAppManagerDispatch: () => mockDispatch,
	// localDate is a DISPLAY value: the true UTC instant shifted by the offset.
	// A shell that compared it directly against start_date would put every card
	// four hours out of its lane, which is the tz bug virtualUtcMs prevents.
	useClassicyDateTime: () => ({
		localDate: new Date(clock.utcMs + clock.tzOffset * 3_600_000),
		tzOffset: clock.tzOffset,
		paused: clock.paused,
	}),
}));

// The vocabulary is an HTTP read (Decision 2); this suite is about the shell.
const VOCABULARY: TagDef[] = [
	{ tag: "tier:primary", namespace: "tier", value: "Primary" },
	{ tag: "tier:secondary", namespace: "tier", value: "Secondary" },
];
vi.mock("./tagVocabulary", () => ({
	reconcileTagVocabulary: () =>
		Promise.resolve({ vocabulary: VOCABULARY, generation: "g1", stale: false }),
}));

// The REAL coordinator — the elements, the reseek and the mute are exactly what
// this suite is asserting. Only the seams are observed: which element belongs
// to which item, what the shell installed as its clock, and every release().
const audio = vi.hoisted(() => ({
	elements: new Map<number, HTMLAudioElement>(),
	released: [] as number[],
	clock: null as import("./audioCoordinator").ClockSource | null,
}));
vi.mock("./audioCoordinator", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./audioCoordinator")>();
	return {
		...actual,
		ensure: (itemId: number, url: string) => {
			const el = actual.ensure(itemId, url);
			audio.elements.set(itemId, el);
			return el;
		},
		release: (itemId: number) => {
			audio.released.push(itemId);
			actual.release(itemId);
		},
		connectClock: (source: import("./audioCoordinator").ClockSource) => {
			audio.clock = source;
			return actual.connectClock(source);
		},
	};
});

import { releaseAll } from "./audioCoordinator";
import { RadioTraffic } from "./RadioTraffic";

// ── Fixtures ───────────────────────────────────────────────────────────────
const NOW_MS = Date.parse("2001-09-11T12:47:00.000Z");

function item(id: number, start: string, end: string): MediaItem {
	return {
		id,
		title: `clip ${id}`,
		full_title: `clip ${id}`,
		source: "ATC",
		start_date: start,
		end_date: end,
		url: `https://files.example/${id}.mp3`,
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
	};
}

/** Three LIVE, two UPCOMING, two PREVIOUS at 12:47:00Z — one of each tier. */
const LIVE = [
	item(1, "2001-09-11T12:46:00.000Z", "2001-09-11T12:50:00.000Z"),
	item(2, "2001-09-11T12:46:30.000Z", "2001-09-11T12:49:00.000Z"),
	item(3, "2001-09-11T12:46:45.000Z", "2001-09-11T12:48:00.000Z"),
];
const UPCOMING = [
	item(4, "2001-09-11T12:55:00.000Z", "2001-09-11T12:56:00.000Z"),
	item(6, "2001-09-11T12:56:00.000Z", "2001-09-11T12:57:00.000Z"),
];
const HISTORY = [
	item(5, "2001-09-11T12:30:00.000Z", "2001-09-11T12:35:00.000Z"),
	item(7, "2001-09-11T12:20:00.000Z", "2001-09-11T12:25:00.000Z"),
];

const tier = (value: string): ItemMeta => ({
	tags: [{ tag: `tier:${value}`, namespace: "tier", value }],
});

/** One primary card in every lane, so a tier filter narrows rather than wipes. */
const META: Record<number, ItemMeta> = {
	1: tier("primary"),
	2: tier("secondary"),
	3: tier("secondary"),
	4: tier("secondary"),
	5: tier("secondary"),
	6: tier("primary"),
	7: tier("primary"),
};

const streamCalls = vi.hoisted(() => ({
	subscribe: [] as string[],
	unsubscribe: [] as string[],
}));

function renderApp(over: Partial<MediaStreamContextValue> = {}) {
	const ctx: Partial<MediaStreamContextValue> = {
		mp3Items: LIVE,
		mp3History: HISTORY,
		mp3Meta: META,
		mp3MetaGeneration: "g1",
		seekInFlight: false,
		subscribeMp3: (id: string) => streamCalls.subscribe.push(id),
		unsubscribeMp3: (id: string) => streamCalls.unsubscribe.push(id),
		getUpcomingMp3Items: () => UPCOMING,
		...over,
	};
	return render(
		<MediaStreamContext.Provider value={ctx as MediaStreamContextValue}>
			<RadioTraffic />
		</MediaStreamContext.Provider>,
	);
}

/** Render and drain the vocabulary promise plus the coordinator's play() chain. */
async function renderSettled(over: Partial<MediaStreamContextValue> = {}) {
	const result = renderApp(over);
	await act(async () => {});
	return result;
}

/** The card ids showing in one lane, top to bottom. */
function laneIds(lane: string): number[] {
	const section = document.querySelector(`section[data-lane="${lane}"]`);
	return Array.from(section?.querySelectorAll("article[data-item]") ?? []).map((el) =>
		Number(el.getAttribute("data-item")),
	);
}

const cardOf = (id: number) => document.querySelector(`article[data-item="${id}"]`);
const badgeOf = (id: number) => cardOf(id)?.querySelector("[data-badge]")?.textContent;

/** The last state the app persisted. */
function lastPersisted(): Record<string, unknown> | undefined {
	const calls = mockDispatch.mock.calls.filter(
		([action]) => action?.type === "ClassicyAppRadioTrafficSetState",
	);
	return calls.at(-1)?.[0];
}

let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
let canvasSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	// Each card draws a PeaksWaveform. jsdom implements no 2D context and logs a
	// "Not implemented" jsdomError for every call, which is stderr noise this
	// suite would otherwise emit once per card per test. PeaksWaveform already
	// treats a null context as "nothing to draw here" — that is the documented
	// jsdom path, so answering null is the environment being honest, not a stub
	// standing in for behaviour under test.
	canvasSpy = vi
		.spyOn(window.HTMLCanvasElement.prototype, "getContext")
		.mockReturnValue(null);
	playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	pauseSpy = vi
		.spyOn(window.HTMLMediaElement.prototype, "pause")
		.mockImplementation(() => {});
});
afterAll(() => {
	canvasSpy.mockRestore();
	playSpy.mockRestore();
	pauseSpy.mockRestore();
});

beforeEach(() => {
	// Frozen wall clock: getNowMs() adds the REAL ms elapsed since the virtual
	// clock last published, so a test that does not advance Date.now() sees the
	// anchor exactly, and one that does sees precisely what it advanced by.
	vi.useFakeTimers({ shouldAdvanceTime: false });
	vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
	clock.utcMs = NOW_MS;
	clock.tzOffset = -4;
	clock.paused = false;
	mockAppData.current = {};
	mockDispatch.mockClear();
	audio.elements.clear();
	audio.released.length = 0;
	audio.clock = null;
	streamCalls.subscribe.length = 0;
	streamCalls.unsubscribe.length = 0;
});

afterEach(() => {
	cleanup();
	releaseAll();
	vi.useRealTimers();
});

describe("RadioTraffic — the mp3 subscription", () => {
	it("subscribes on mount and unsubscribes on unmount", async () => {
		const { unmount } = await renderSettled();
		expect(streamCalls.subscribe).toEqual(["RadioTraffic.app"]);
		expect(streamCalls.unsubscribe).toEqual([]);
		unmount();
		expect(streamCalls.unsubscribe).toEqual(["RadioTraffic.app"]);
	});
});

describe("RadioTraffic — lanes", () => {
	it("distributes cards into LIVE, UPCOMING and PREVIOUS", async () => {
		await renderSettled();
		expect(laneIds("live")).toEqual([1, 2, 3]);
		expect(laneIds("upcoming")).toEqual([4, 6]);
		// Newest first: the clip that just ended is the one a listener reaches for.
		expect(laneIds("previous")).toEqual([5, 7]);
	});

	// A shell comparing the ticking `localDate` against start_date would place
	// every card four hours out of its lane. Same offset the tuner runs at.
	it("reads the clock through virtualUtcMs, not the display date", async () => {
		clock.tzOffset = -4;
		await renderSettled();
		expect(laneIds("live")).toEqual([1, 2, 3]);
	});
});

describe("RadioTraffic — tag filtering", () => {
	it("removes non-matching cards from every lane", async () => {
		await renderSettled();
		expect(laneIds("live")).toHaveLength(3);

		fireEvent.click(screen.getByLabelText("Primary"));

		expect(laneIds("live")).toEqual([1]);
		expect(laneIds("upcoming")).toEqual([6]);
		expect(laneIds("previous")).toEqual([7]);
	});

	// Criterion 4. A filter toggle unmounts the card, but the <audio> lives in
	// the coordinator and keeps running on the clock — so re-checking must show
	// the position the clip actually reached, not a fresh element at zero.
	it("resumes a filtered-away clip at its clock offset rather than restarting", async () => {
		await renderSettled();

		// Where the clock says clip 2 should be: 12:47:00 − 12:46:30 = 30s.
		const onTheClock = calcSeekSeconds(LIVE[1], NOW_MS);
		expect(onTheClock).toBe(30);
		const el = audio.elements.get(2);
		expect(el).toBeDefined();
		(el as HTMLAudioElement).currentTime = onTheClock;

		// Hide it: only tier:primary survives, and clip 2 is secondary.
		fireEvent.click(screen.getByLabelText("Primary"));
		expect(cardOf(2)).toBeNull();
		// The element must survive the card. Releasing it here is what would
		// force a restart from zero on the way back.
		expect(audio.released).not.toContain(2);
		expect((el as HTMLAudioElement).currentTime).toBe(onTheClock);

		fireEvent.click(screen.getByLabelText("Primary"));
		expect(cardOf(2)).not.toBeNull();
		// Derived from the element's real position: at the clock, so "In sync".
		// A restarted element would sit 30s behind and read "-30s".
		expect(audio.elements.get(2)).toBe(el);
		expect(badgeOf(2)).toBe("In sync");
	});

	// Criterion 4's other half, and Story 017's reconcileSolo: effectiveMutedIds
	// mutes everything except the solo target, so a solo pointing at a hidden
	// card would silence the whole grid with nothing left on screen to click.
	it("hands the solo on when the soloed card is filtered away", async () => {
		await renderSettled();
		// Clip 1 is the auto-solo target (earliest start) and the only primary
		// live card, so filtering to `secondary` removes it from the mix.
		expect(audio.elements.get(1)?.muted).toBe(false);

		fireEvent.click(screen.getByLabelText("Secondary"));
		await act(async () => {});

		expect(laneIds("live")).toEqual([2, 3]);
		const audible = [2, 3].filter((id) => audio.elements.get(id)?.muted === false);
		expect(audible).toEqual([2]);
	});
});

describe("RadioTraffic — the default mix", () => {
	// Criterion 5. With no solo and nothing muted every live card is audible, so
	// "exactly one" is something the shell has to state, not something it gets.
	it("leaves exactly one LIVE player unmuted", async () => {
		await renderSettled();
		const live = [1, 2, 3].map((id) => audio.elements.get(id));
		expect(live.every(Boolean)).toBe(true);
		expect(live.filter((el) => el?.muted === false)).toHaveLength(1);
		// Earliest start wins, so the top card is the one you hear.
		expect(audio.elements.get(1)?.muted).toBe(false);
	});

	it("restores a persisted per-card mute and skips it when choosing the default", async () => {
		mockAppData.current = { mutedItems: [1] };
		await renderSettled();
		expect(audio.elements.get(1)?.muted).toBe(true);
		// Auto-solo never overrides an explicit mute — it moves to the next card.
		expect(audio.elements.get(2)?.muted).toBe(false);
		// The card says so on its mute button, which is the control the listener
		// uses to undo it — story 023 replaced the word "Muted" with that button.
		expect(cardOf(1)?.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe("true");
	});

	it("registers no element for an UPCOMING card", async () => {
		await renderSettled();
		expect(audio.elements.has(4)).toBe(false);
		expect(audio.elements.has(6)).toBe(false);
	});
});

describe("RadioTraffic — the clock", () => {
	// Criterion 6.
	it("reseeks mounted elements after a jump larger than 5s", async () => {
		const { rerender } = await renderSettled();
		const el = audio.elements.get(1) as HTMLAudioElement;
		el.currentTime = 0;

		clock.utcMs = Date.parse("2001-09-11T12:49:00.000Z");
		await act(async () => {
			rerender(
				<MediaStreamContext.Provider
					value={
						{
							mp3Items: LIVE,
							mp3History: HISTORY,
							mp3Meta: META,
							mp3MetaGeneration: "g1",
							seekInFlight: false,
							subscribeMp3: () => {},
							unsubscribeMp3: () => {},
							getUpcomingMp3Items: () => UPCOMING,
						} as unknown as MediaStreamContextValue
					}
				>
					<RadioTraffic />
				</MediaStreamContext.Provider>,
			);
		});

		expect(el.currentTime).toBe(calcSeekSeconds(LIVE[0], clock.utcMs));
	});

	// Criterion 10: the sub-minute correction. The store only publishes on
	// minute boundaries, so the coordinator's clock has to add the real time
	// elapsed since the last publication — and freeze while the clock is paused.
	it("adds the real ms elapsed since the clock last published", async () => {
		await renderSettled();
		expect(audio.clock).not.toBeNull();
		expect(audio.clock?.nowMs()).toBe(NOW_MS);

		// No re-render: this is precisely the gap the correction covers.
		vi.advanceTimersByTime(500);
		expect(audio.clock?.nowMs()).toBe(NOW_MS + 500);
	});

	it("freezes the clock while the virtual clock is paused", async () => {
		clock.paused = true;
		await renderSettled();
		expect(audio.clock?.nowMs()).toBe(NOW_MS);

		vi.advanceTimersByTime(5_000);
		// A paused virtual clock contributes no elapsed time at all — without
		// this a paused session would drift five seconds every five seconds.
		expect(audio.clock?.nowMs()).toBe(NOW_MS);
	});

	// `itemFor` returning undefined is load bearing: it is how a clip the
	// listener started themselves opts out of the reseek, the health check and
	// the gesture retry, because it plays from its own start and not the clock's.
	it("tells the coordinator which elements follow the clock", async () => {
		await renderSettled();
		expect(audio.clock?.itemFor(1)?.id).toBe(1);
		expect(audio.clock?.itemFor(999)).toBeUndefined();

		// Start the top PREVIOUS clip by hand.
		const transport = cardOf(5)?.querySelector("button[aria-label='Play']");
		expect(transport).not.toBeNull();
		fireEvent.click(transport as Element);
		await act(async () => {});

		expect(audio.elements.has(5)).toBe(true);
		expect(audio.clock?.itemFor(5)).toBeUndefined();
	});
});

describe("RadioTraffic — persisted state", () => {
	// Criterion 7.
	it("persists checked tags, the tool, lane collapse and laneOrder", async () => {
		await renderSettled();

		fireEvent.click(screen.getByLabelText("Primary"));
		fireEvent.click(screen.getByRole("radio", { name: "Move" }));
		const upcoming = document.querySelector(
			"section[data-lane='upcoming'] [data-lane-toggle]",
		);
		fireEvent.click(upcoming as Element);

		const persisted = lastPersisted();
		expect(persisted?.checked).toEqual(["tier:primary"]);
		expect(persisted?.tool).toBe("hand");
		expect(persisted?.collapsed).toMatchObject({ upcoming: true, previous: false });
		expect(persisted?.laneOrder).toEqual({ live: [], upcoming: [], previous: [] });
	});

	// Criterion 9: per-card mute is persisted, not reset.
	it("persists a per-card mute made with the mute tool", async () => {
		await renderSettled();
		fireEvent.click(screen.getByRole("radio", { name: "Mute" }));
		fireEvent.pointerUp(document.querySelector("[data-card-slot='2']") as Element);

		expect(lastPersisted()?.mutedItems).toEqual([2]);
		await act(async () => {});
		expect(audio.elements.get(2)?.muted).toBe(true);
	});

	it("restores checked tags, the tool and lane collapse", async () => {
		mockAppData.current = {
			checked: ["tier:primary"],
			tool: "unmute",
			collapsed: { upcoming: true },
			laneOrder: { live: [], upcoming: [], previous: [] },
			mutedItems: [],
		};
		await renderSettled();

		expect(laneIds("live")).toEqual([1]);
		expect(
			screen.getByRole("radio", { name: "Unmute" }).getAttribute("aria-checked"),
		).toBe("true");
		// Disclosure keeps its children mounted when closed, so expansion is only
		// observable through aria-expanded.
		expect(
			document
				.querySelector("section[data-lane='upcoming'] [data-lane-toggle]")
				?.getAttribute("aria-expanded"),
		).toBe("false");
	});

	// Criterion 8, at the app level: an unknown tool would put every card click
	// through a switch with no matching case — a mode with no handler, and
	// nothing on screen to say so.
	it("boots into the default tool when the persisted one is unknown", async () => {
		mockAppData.current = { tool: "banana" };
		await renderSettled();

		const selected = screen
			.getAllByRole("radio")
			.filter((el) => el.getAttribute("aria-checked") === "true");
		expect(selected).toHaveLength(1);
		expect(selected[0].getAttribute("aria-label")).toBe("Solo");
	});

	it("ignores an unreadable laneOrder rather than rendering from it", async () => {
		mockAppData.current = { laneOrder: { live: [3, "x", 1, 0] } };
		await renderSettled();
		// The bad pin list is dropped whole, so the lane stays chronological.
		expect(laneIds("live")).toEqual([1, 2, 3]);
	});
});

describe("RadioTraffic — the tools", () => {
	it("solos the clicked card under the arrow tool", async () => {
		await renderSettled();
		fireEvent.pointerUp(document.querySelector("[data-card-slot='3']") as Element);
		await act(async () => {});

		expect(audio.elements.get(3)?.muted).toBe(false);
		expect(audio.elements.get(1)?.muted).toBe(true);
		expect(audio.elements.get(2)?.muted).toBe(true);
	});

	it("does not change the mix under the hand tool", async () => {
		await renderSettled();
		fireEvent.click(screen.getByRole("radio", { name: "Move" }));
		fireEvent.pointerUp(document.querySelector("[data-card-slot='3']") as Element);
		await act(async () => {});

		expect(audio.elements.get(1)?.muted).toBe(false);
		expect(audio.elements.get(3)?.muted).toBe(true);
	});
});
