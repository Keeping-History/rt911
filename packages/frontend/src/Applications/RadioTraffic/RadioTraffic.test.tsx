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
// Story 050: whether the window is open — the gate under test. A plain
// mutable ref, not React state, because the mock's useAppManager isn't a real
// store; a test flips this and calls `rerender` to make it take effect, the
// same technique "the clock" describe block already uses to move the virtual
// clock.
const mockAppOpen = vi.hoisted(() => ({ current: true }));

vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	// The app menu is rendered flat as buttons. The real window puts these behind
	// a menu bar, which is chrome this suite is not about — but "File ▸ Settings…
	// opens the Settings window" is app behaviour, and a mock that swallowed
	// `appMenu` would leave the only route to that window untestable.
	ClassicyWindow: ({
		children,
		title,
		appMenu,
		onCloseFunc,
	}: {
		children?: React.ReactNode;
		title?: string;
		appMenu?: { menuChildren?: { id: string; title: string; onClickFunc?: () => void }[] }[];
		onCloseFunc?: () => void;
	}) => (
		<div data-window-title={title}>
			{onCloseFunc && <button type="button" aria-label="Close" onClick={onCloseFunc} />}
			{(appMenu ?? []).flatMap((menu) =>
				(menu.menuChildren ?? []).map((entry) => (
					<button key={entry.id} type="button" onClick={entry.onClickFunc}>
						{entry.title}
					</button>
				)),
			)}
			{children}
		</div>
	),
	// Rest props pass through (role, aria-selected, ref …) rather than being
	// dropped, because story 030 put CardTabBar's own tabs on this component
	// specifically for that pass-through — the real ClassicyButton sets no role
	// of its own, unlike ClassicyBevelButton above.
	ClassicyButton: ({
		children,
		onClickFunc,
		...rest
	}: {
		children?: React.ReactNode;
		onClickFunc?: React.MouseEventHandler<HTMLButtonElement>;
	} & Record<string, unknown>) => (
		<button {...rest} type="button" onClick={onClickFunc}>
			{children}
		</button>
	),
	// Reproduced rather than omitted because this suite drives several of the
	// controls story 030 moved onto this component — the lane strip's mute-all
	// toggle (story 040) and the tool palette's radio group among them — through
	// the real DOM. `mode` decides the role the same way the real component
	// does (hardcoded, not merely passed through): "radio" gets role="radio" and
	// aria-checked, "toggle"/"push" (the default) get role="button" and
	// aria-pressed, which is how a test finds either kind of control's state or
	// selects it by ARIA role at all.
	ClassicyBevelButton: ({
		children,
		mode = "push",
		on,
		onClickFunc,
		onChangeFunc,
		...rest
	}: {
		children?: React.ReactNode;
		mode?: "push" | "toggle" | "radio" | "popup";
		on?: boolean;
		onClickFunc?: React.MouseEventHandler<HTMLButtonElement>;
		onChangeFunc?: (on: boolean) => void;
	} & Record<string, unknown>) => (
		<button
			{...rest}
			type="button"
			role={mode === "radio" ? "radio" : "button"}
			aria-checked={mode === "radio" ? (on ?? false) : undefined}
			aria-pressed={mode === "toggle" || mode === "push" ? (on ?? false) : undefined}
			onClick={(e) => {
				// A radio only fires a change when the click actually turns it on —
				// clicking the already-active tool reports through onClickFunc alone,
				// same as the real component.
				if (mode === "toggle") onChangeFunc?.(!(on ?? false));
				else if (mode === "radio" && !(on ?? false)) onChangeFunc?.(true);
				onClickFunc?.(e);
			}}
		>
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
	ClassicyBalloonHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	ClassicyControlGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyColorPicker: ({
		labelTitle,
		value,
		onChangeFunc,
	}: {
		labelTitle?: string;
		value?: number;
		onChangeFunc?: (color: number) => void;
	}) => (
		<button
			type="button"
			aria-label={labelTitle}
			data-color={value}
			onClick={() => onChangeFunc?.(0xff0000)}
		/>
	),
	MAC_OS_8_CRAYONS: [],
	// The real packing, not a stand-in: the shell hands this straight to a CSS
	// `color`, so a fake would let a broken conversion pass.
	intToHex: (color: number) => `#${color.toString(16).padStart(6, "0")}`,
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
						apps: {
							"RadioTraffic.app": { open: mockAppOpen.current, data: mockAppData.current },
						},
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

/**
 * The card ids showing in one lane, top to bottom — whichever player form
 * they're rendered in. UPCOMING is permanently minimized, so its cards carry
 * `data-small-player` rather than the full card's `data-item`; a lane the
 * listener folded by hand can be in either form.
 */
function laneIds(lane: string): number[] {
	const section = document.querySelector(`section[data-lane="${lane}"]`);
	return Array.from(section?.querySelectorAll("[data-item], [data-small-player]") ?? []).map(
		(el) => Number(el.getAttribute("data-item") ?? el.getAttribute("data-small-player")),
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
	mockAppOpen.current = true;
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

// Story 050. `RadioTraffic` renders unconditionally in Desktop.tsx — closing
// the window is a `state.System.Manager.Applications.apps[appId].open` flip,
// never an unmount — so these are the transitions that have to do the work
// the old mount-only effects used to do for free.
describe("RadioTraffic — the window lifecycle (story 050)", () => {
	/**
	 * Re-renders with the same shape of context so a `mockAppOpen` flip takes
	 * effect — the same technique the "the clock" describe block above uses to
	 * move the virtual clock via `rerender`, since the mocked `useAppManager`
	 * is a plain function over a mutable ref, not a real reactive store.
	 */
	async function toggleOpen(
		rerender: (ui: React.ReactElement) => void,
		open: boolean,
		over: Partial<MediaStreamContextValue> = {},
	) {
		mockAppOpen.current = open;
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
		await act(async () => {
			rerender(
				<MediaStreamContext.Provider value={ctx as MediaStreamContextValue}>
					<RadioTraffic />
				</MediaStreamContext.Provider>,
			);
		});
	}

	// Criterion 1 and 2, from a cold start: a listener who never opens the app
	// must cost nothing at all.
	it("subscribes nothing and registers no audio while the window starts closed", async () => {
		mockAppOpen.current = false;
		await renderSettled();
		expect(streamCalls.subscribe).toEqual([]);
		expect(audio.elements.size).toBe(0);
	});

	// Criterion 1 and 2, mid-session: an item arriving while the window is
	// closed must not trigger a fetch either — the registration effect has to
	// stay gated on every re-render, not just the one at close time.
	it("registers no new element for a LIVE item that arrives while the window is closed", async () => {
		const { rerender } = await renderSettled();
		await toggleOpen(rerender, false);
		// A sentinel: if the gate ever failed, ensure() would put "1" straight
		// back into this map on the very next render.
		audio.elements.delete(1);

		const arrival = item(9, "2001-09-11T12:46:55.000Z", "2001-09-11T12:52:00.000Z");
		await toggleOpen(rerender, false, { mp3Items: [...LIVE, arrival] });

		expect(audio.elements.has(9)).toBe(false);
		expect(audio.elements.has(1)).toBe(false);
	});

	// Criteria 3, 4 and 5: closing releases every registered element — LIVE
	// and a PREVIOUS clip the listener started by hand alike — and reopening
	// puts the mix back exactly as if the app had stayed open, with the
	// position/badge pipe still live.
	it("closing then reopening releases and re-registers every element, resuming LIVE playback at the clock position", async () => {
		const { rerender } = await renderSettled();
		const before: Record<number, HTMLAudioElement | undefined> = {
			1: audio.elements.get(1),
			2: audio.elements.get(2),
			3: audio.elements.get(3),
		};
		expect(Object.values(before).every(Boolean)).toBe(true);

		// A PREVIOUS clip the listener started by hand before closing — this
		// must not be left playing invisibly either.
		const transport = cardOf(5)?.querySelector("button[aria-label='Play']");
		fireEvent.click(transport as Element);
		await act(async () => {});
		const previousBefore = audio.elements.get(5);
		expect(previousBefore).toBeDefined();

		await toggleOpen(rerender, false);
		expect(streamCalls.unsubscribe).toEqual(["RadioTraffic.app"]);

		await toggleOpen(rerender, true);
		expect(streamCalls.subscribe).toEqual(["RadioTraffic.app", "RadioTraffic.app"]);

		// Every element is a fresh registration, not the one left running
		// through the close — proof the close actually released it rather than
		// leaving it playing invisibly, LIVE and PREVIOUS alike.
		expect(audio.elements.get(1)).not.toBe(before[1]);
		expect(audio.elements.get(2)).not.toBe(before[2]);
		expect(audio.elements.get(3)).not.toBe(before[3]);
		expect(audio.elements.get(5)).not.toBe(previousBefore);

		// The reopened element still reports its position off the same live
		// pipe as before the close — the same "In sync" reading the
		// filter-toggle test above gets for the identical clock offset, so
		// reopening did not leave the badge stuck on a stale or blank reading.
		const onTheClock = calcSeekSeconds(LIVE[1], NOW_MS);
		const el2 = audio.elements.get(2) as HTMLAudioElement;
		el2.currentTime = onTheClock;
		// A raw dispatchEvent, unlike fireEvent, is not itself act()-wrapped —
		// wrap the flush explicitly so the resulting position update commits
		// before the badge is read, the same way a browser's real timeupdate
		// would land inside React's own event handling.
		await act(async () => {
			el2.dispatchEvent(new Event("timeupdate"));
		});
		expect(badgeOf(2)).toBe("In sync");
	});

	// Criterion 6: open/close is a lifecycle change, not a state reset — the
	// persisted filters/tool/lane order/mutes must be untouched by the cycle.
	it("does not touch persisted settings across a close/reopen cycle", async () => {
		const { rerender } = await renderSettled();
		fireEvent.click(screen.getByLabelText("Primary"));
		const beforeClose = lastPersisted();

		await toggleOpen(rerender, false);
		await toggleOpen(rerender, true);

		expect(lastPersisted()).toEqual(beforeClose);
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
		// In a browser the element announces its own position as it advances;
		// jsdom does not, so the test says it. Without this the assertion below
		// would be that a card reports a position nothing ever published.
		(el as HTMLAudioElement).dispatchEvent(new Event("timeupdate"));

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

describe("RadioTraffic — the audible hold (story 045)", () => {
	// A LIVE player that is playing and unmuted must not vanish out of the Live
	// lane the instant the clock says its window is over — only muting or
	// stopping (unselecting) it may hand it to PREVIOUS. One item, alone in the
	// mix, so it is the auto-solo target with nothing else to entangle the
	// assertions with.
	const HOLD_ITEM = item(10, "2001-09-11T12:46:00.000Z", "2001-09-11T12:47:30.000Z");
	const PAST_END = "2001-09-11T12:48:00.000Z"; // 30s after HOLD_ITEM's end_date

	async function rerenderAt(
		rerender: (ui: React.ReactElement) => void,
		iso: string,
		over: Partial<MediaStreamContextValue> = {},
	) {
		clock.utcMs = Date.parse(iso);
		await act(async () => {
			rerender(
				<MediaStreamContext.Provider
					value={
						{
							mp3Items: [HOLD_ITEM],
							mp3History: [],
							mp3Meta: {},
							mp3MetaGeneration: "g1",
							seekInFlight: false,
							subscribeMp3: () => {},
							unsubscribeMp3: () => {},
							getUpcomingMp3Items: () => [],
							...over,
						} as unknown as MediaStreamContextValue
					}
				>
					<RadioTraffic />
				</MediaStreamContext.Provider>,
			);
		});
	}

	async function renderHold() {
		return renderSettled({
			mp3Items: [HOLD_ITEM],
			mp3History: [],
			mp3Meta: {},
			getUpcomingMp3Items: () => [],
		});
	}

	it("keeps a playing, unmuted LIVE player in the Live lane once its clock window ends", async () => {
		const { rerender } = await renderHold();
		expect(laneIds("live")).toEqual([10]);
		// The default mix: nothing muted, nothing stopped — this is the "playing
		// and unmuted" state the criterion is about.
		expect(audio.elements.get(10)?.muted).toBe(false);

		await rerenderAt(rerender, PAST_END);

		expect(laneIds("live")).toEqual([10]);
		expect(laneIds("previous")).toEqual([]);
		// Still actually making sound, not just still on screen — a card held in
		// LIVE with its element released would be a silent lie.
		expect(audio.released).not.toContain(10);
		expect(audio.elements.get(10)?.muted).toBe(false);
	});

	it("releases the hold once the listener mutes the card, and it moves to PREVIOUS", async () => {
		const { rerender } = await renderHold();
		expect(laneIds("live")).toEqual([10]);

		fireEvent.click(screen.getByRole("radio", { name: "Mute" }));
		fireEvent.pointerUp(document.querySelector("[data-card-slot='10']") as Element);
		await act(async () => {});
		expect(audio.elements.get(10)?.muted).toBe(true);
		// Muting alone, before the clock window ends, does not evict it — only
		// the clock moving past the window does, same as an ordinary LIVE card.
		expect(laneIds("live")).toEqual([10]);

		await rerenderAt(rerender, PAST_END);

		expect(laneIds("live")).toEqual([]);
		expect(laneIds("previous")).toEqual([10]);
	});

	it("releases the hold once the listener unselects (stops) the card, and it moves to PREVIOUS", async () => {
		const { rerender } = await renderHold();
		expect(laneIds("live")).toEqual([10]);

		const transport = cardOf(10)?.querySelector("button[aria-label='Pause']");
		expect(transport).not.toBeNull();
		fireEvent.click(transport as Element);
		await act(async () => {});
		// Stopping before the window ends does not evict it either — same rule.
		expect(laneIds("live")).toEqual([10]);

		await rerenderAt(rerender, PAST_END);

		expect(laneIds("live")).toEqual([]);
		expect(laneIds("previous")).toEqual([10]);
	});

	it("moves an already-muted LIVE player to PREVIOUS once its window ends, same as today", async () => {
		mockAppData.current = { mutedItems: [10] };
		const { rerender } = await renderHold();
		expect(laneIds("live")).toEqual([10]);
		expect(audio.elements.get(10)?.muted).toBe(true);

		await rerenderAt(rerender, PAST_END, { mp3Items: [HOLD_ITEM] });

		expect(laneIds("live")).toEqual([]);
		expect(laneIds("previous")).toEqual([10]);
	});

	it("silencing the whole LIVE lane releases the hold too", async () => {
		const { rerender } = await renderHold();
		const laneMute = document.querySelector(
			`section[data-lane="live"] [data-lane-mute]`,
		);
		fireEvent.click(laneMute as Element);
		await act(async () => {});
		expect(laneIds("live")).toEqual([10]);

		await rerenderAt(rerender, PAST_END);

		expect(laneIds("live")).toEqual([]);
		expect(laneIds("previous")).toEqual([10]);
	});
});

describe("RadioTraffic — persisted state", () => {
	// Criterion 7.
	it("persists checked tags, the tool, lane collapse and laneOrder", async () => {
		await renderSettled();

		fireEvent.click(screen.getByLabelText("Primary"));
		fireEvent.click(screen.getByRole("radio", { name: "Move" }));
		// PREVIOUS is the only lane left with a collapse control — UPCOMING is
		// permanently minimized and LIVE never folds.
		const previous = document.querySelector(
			"section[data-lane='previous'] [data-lane-toggle]",
		);
		fireEvent.click(previous as Element);

		const persisted = lastPersisted();
		expect(persisted?.checked).toEqual(["tier:primary"]);
		expect(persisted?.tool).toBe("hand");
		expect(persisted?.collapsed).toMatchObject({ previous: true });
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
			collapsed: { previous: true },
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
				.querySelector("section[data-lane='previous'] [data-lane-toggle]")
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

describe("RadioTraffic — the LIVE lane mute", () => {
	// Story 040. The lane flag and the per-card mutes answer different questions
	// — "silence this lane, including whatever arrives next" against "silence
	// these clips" — and these tests are about the seam between them.

	const laneMute = (lane: string) =>
		document.querySelector(`section[data-lane="${lane}"] [data-lane-mute]`);

	/** Which LIVE elements the listener can actually hear. */
	const audibleLive = () =>
		[1, 2, 3].filter((id) => audio.elements.get(id)?.muted === false);

	it("offers the control on LIVE and on no other lane", async () => {
		// UPCOMING has no audio yet and PREVIOUS plays only what the listener
		// started by hand — neither has a mix a lane mute could silence.
		await renderSettled();
		expect(laneMute("live")).not.toBeNull();
		expect(laneMute("upcoming")).toBeNull();
		expect(laneMute("previous")).toBeNull();
	});

	it("silences every player in the lane on one press", async () => {
		await renderSettled();
		expect(audibleLive()).toEqual([1]);

		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		expect(audibleLive()).toEqual([]);
	});

	it("mutes the lane WITHOUT writing every card into the per-card mutes", async () => {
		// This is what makes it a flag and not a bulk action. A "mute everything
		// here now" implementation would be indistinguishable on this screen and
		// wrong on the next one, and the per-card set is where the difference
		// shows: it stays exactly as the listener left it.
		mockAppData.current = { mutedItems: [2] };
		await renderSettled();
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		expect(lastPersisted()?.liveLaneMuted).toBe(true);
		expect(lastPersisted()?.mutedItems).toEqual([2]);
	});

	it("silences a clip that only reaches the lane AFTER the press", async () => {
		// The complaint the story is about: the lane refills itself as the clock
		// runs, so a one-shot mute goes quiet and then starts talking again a
		// minute later.
		//
		// The setup makes the arrival the clip that WOULD be playing — the three
		// cards already there are individually muted, so with no lane mute the
		// auto-solo would hand the mix straight to the newcomer. Only the lane
		// flag keeps it quiet.
		mockAppData.current = { mutedItems: [1, 2, 3], liveLaneMuted: true };
		const arrival = item(8, "2001-09-11T12:46:50.000Z", "2001-09-11T12:52:00.000Z");
		await renderSettled({ mp3Items: [...LIVE, arrival] });

		expect(laneIds("live")).toContain(8);
		expect(audio.elements.get(8)?.muted).toBe(true);
	});

	it("clears the lane mute and unmutes only the clicked player", async () => {
		await renderSettled();
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		fireEvent.pointerUp(document.querySelector("[data-card-slot='3']") as Element);
		await act(async () => {});

		expect(audibleLive()).toEqual([3]);
		// The flag is gone, materialised into the mutes on the other two — so the
		// control is offering to mute again rather than to unmute.
		expect(laneMute("live")?.getAttribute("aria-pressed")).toBe("false");
		expect(lastPersisted()?.liveLaneMuted).toBe(false);
		expect(lastPersisted()?.mutedItems).toEqual([1, 2]);
	});

	it("brings the whole lane back when the control is pressed again", async () => {
		// Unmuting is not the same handover: nobody named a card, so the mix
		// underneath is simply uncovered.
		await renderSettled();
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		expect(audibleLive()).toEqual([1]);
	});

	it("shows the silence on every live card, not just on the strip", async () => {
		await renderSettled();
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		for (const id of [1, 2, 3]) {
			expect(cardOf(id)?.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe(
				"true",
			);
		}
	});

	it("reflects the lane's state on the control itself", async () => {
		await renderSettled();
		expect(laneMute("live")?.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});

		expect(laneMute("live")?.getAttribute("aria-pressed")).toBe("true");
	});

	it("persists the lane mute", async () => {
		await renderSettled();
		fireEvent.click(laneMute("live") as Element);
		await act(async () => {});
		expect(lastPersisted()?.liveLaneMuted).toBe(true);
	});

	it("opens silent when the last session left the lane muted", async () => {
		// Unlike solo this names no clip, so a reload cannot make it stale — and
		// a listener who silenced the app and came back to it talking would
		// reasonably call that a bug.
		mockAppData.current = { liveLaneMuted: true };
		await renderSettled();
		expect(audibleLive()).toEqual([]);
		expect(laneMute("live")?.getAttribute("aria-pressed")).toBe("true");
	});
});

describe("RadioTraffic — a collapsed lane", () => {
	// Story 027. Collapsing used to empty the lane; it now swaps the full
	// players for the small ones, which is the thing a listener folds a lane to
	// keep.

	const smallPlayersIn = (lane: string) =>
		Array.from(
			document.querySelectorAll(
				`section[data-lane="${lane}"] [data-small-player]`,
			),
		).map((el) => Number(el.getAttribute("data-small-player")));

	/** Full-card ids only, unlike laneIds — the negative half of the swap below. */
	const fullPlayersIn = (lane: string) =>
		Array.from(document.querySelectorAll(`section[data-lane="${lane}"] [data-item]`)).map(
			(el) => Number(el.getAttribute("data-item")),
		);

	it("swaps UPCOMING's full players for small ones", async () => {
		// UPCOMING is permanently minimized (no stored flag needed to fold it),
		// but the fixture sets one anyway to show it changes nothing.
		mockAppData.current = { collapsed: { upcoming: true } };
		await renderSettled();
		expect(smallPlayersIn("upcoming")).toEqual([4, 6]);
		expect(fullPlayersIn("upcoming")).toEqual([]);
	});

	it("keeps the clips' metadata readable while folded", async () => {
		mockAppData.current = { collapsed: { upcoming: true } };
		await renderSettled();
		const small = document.querySelector('[data-small-player="4"]');
		// The tier tag META gives every item, coloured by its namespace.
		expect(small?.querySelector("li")?.textContent).toBe("secondary");
		expect(small?.querySelector('[data-field="start"]')?.textContent).toBe(
			"9/11/2001 8:55 AM ET",
		);
		expect(small?.querySelector('[data-field="duration"]')?.textContent).toBe("60 seconds");
	});

	it("leaves the other lanes on their full players", async () => {
		mockAppData.current = { collapsed: { upcoming: true } };
		await renderSettled();
		expect(laneIds("live")).toEqual([1, 2, 3]);
		expect(smallPlayersIn("live")).toEqual([]);
	});

	it("keeps LIVE on its full players whatever the stored flag says", async () => {
		// LIVE has no control to undo a collapse with, so a stale `true` must not
		// shrink the lane the app exists to show.
		mockAppData.current = { collapsed: { live: true } };
		await renderSettled();
		expect(laneIds("live")).toEqual([1, 2, 3]);
		expect(smallPlayersIn("live")).toEqual([]);
	});
});

describe("RadioTraffic — the station split", () => {
	/** Same shape as `item`, on a continuous broadcaster instead of ATC. */
	function broadcast(id: number, source: string): MediaItem {
		return { ...item(id, "2001-09-11T12:46:00.000Z", "2001-09-11T12:50:00.000Z"), source };
	}

	// The mp3 stream carries both kinds of audio and BROADCAST_STATIONS is the
	// line between them: the Tuner filters TO it, so anything this app does not
	// filter OUT is a station the listener is already hearing in another window,
	// duplicated here as a traffic card.
	it("keeps the tuner's broadcast stations out of every lane", async () => {
		await renderSettled({
			mp3Items: [...LIVE, broadcast(100, "WCBS"), broadcast(101, "WINS")],
		});
		expect(laneIds("live")).toEqual([1, 2, 3]);
		expect(cardOf(100)).toBeNull();
		expect(cardOf(101)).toBeNull();
	});

	// Excluded from the app means excluded from the mix — a card that never
	// renders but whose element the coordinator still registers would be a
	// station playing with nothing on screen to stop it.
	it("never registers audio for a broadcast station", async () => {
		await renderSettled({ mp3Items: [...LIVE, broadcast(100, "WCBS")] });
		expect([...audio.elements.keys()]).not.toContain(100);
	});

	it("filters the history and reveal buffers too, not just the live set", async () => {
		await renderSettled({
			mp3History: [...HISTORY, broadcast(102, "WABC")],
			getUpcomingMp3Items: () => [...UPCOMING, broadcast(103, "WTOP")],
		});
		expect(cardOf(102)).toBeNull();
		expect(cardOf(103)).toBeNull();
	});

	// The comm traffic this app exists for must survive the filter — a test that
	// only checked the exclusions would pass on an empty grid.
	it("keeps comm traffic whose source is not a broadcaster", async () => {
		await renderSettled({ mp3Items: [...LIVE, broadcast(104, "ZBW")] });
		expect(laneIds("live")).toContain(104);
	});
});

describe("RadioTraffic — the waveform color", () => {
	const waveformSlots = () =>
		Array.from(document.querySelectorAll("[data-card-waveform]")) as HTMLElement[];

	it("leaves the waveform on the theme until the listener changes it", async () => {
		await renderSettled();
		// No inline color at all, so `.rtCardWaveform`'s --color-system-06 stands
		// and the app keeps re-theming live.
		expect(waveformSlots().every((el) => el.style.color === "")).toBe(true);
	});

	it("applies a saved color to every card", async () => {
		mockAppData.current = { useThemeWaveformColor: false, waveformColor: 0x00d25a };
		await renderSettled();
		const slots = waveformSlots();
		expect(slots.length).toBeGreaterThan(1);
		expect(slots.every((el) => el.style.color === "rgb(0, 210, 90)")).toBe(true);
	});

	it("re-colors every card when the listener saves a new color", async () => {
		await renderSettled();
		fireEvent.click(screen.getByText("Settings…"));
		fireEvent.click(screen.getByLabelText("Use theme colors"));
		fireEvent.click(screen.getByLabelText("Waveform"));
		fireEvent.click(screen.getByText("Save"));
		await act(async () => {});

		const slots = waveformSlots();
		expect(slots.length).toBeGreaterThan(1);
		expect(slots.every((el) => el.style.color === "rgb(255, 0, 0)")).toBe(true);
	});

	// Persistence is what makes it a setting rather than a session preference.
	it("persists the color through the app's own state", async () => {
		await renderSettled();
		fireEvent.click(screen.getByText("Settings…"));
		fireEvent.click(screen.getByLabelText("Use theme colors"));
		fireEvent.click(screen.getByLabelText("Waveform"));
		fireEvent.click(screen.getByText("Save"));
		await act(async () => {});

		expect(lastPersisted()).toMatchObject({
			useThemeWaveformColor: false,
			waveformColor: 0xff0000,
		});
	});

	it("leaves the cards alone when the listener cancels", async () => {
		await renderSettled();
		fireEvent.click(screen.getByText("Settings…"));
		fireEvent.click(screen.getByLabelText("Use theme colors"));
		fireEvent.click(screen.getByLabelText("Waveform"));
		fireEvent.click(screen.getByText("Cancel"));
		await act(async () => {});

		expect(waveformSlots().every((el) => el.style.color === "")).toBe(true);
		expect(lastPersisted()).toMatchObject({ useThemeWaveformColor: true });
	});
});

// Which COPY of a recording the coordinator is handed. Every mp3 row carries the
// source recording; a row the enhancement pass has reached also carries a
// noise-reduced render, and this setting is which of the two a card plays.
describe("RadioTraffic — the original-recording choice", () => {
	const ORIGINAL = "https://files.example/1.mp3";
	const ENHANCED = "https://files.example/1.enhanced.mp3";

	/** One LIVE clip that exists in both copies, so the choice is observable. */
	const both: MediaItem = {
		...item(1, "2001-09-11T12:46:00.000Z", "2001-09-11T12:50:00.000Z"),
		enhanced_url: ENHANCED,
	};

	const oneLiveClip = {
		mp3Items: [both],
		mp3History: [],
		getUpcomingMp3Items: () => [],
	};

	const srcOf = (id: number) => audio.elements.get(id)?.src;

	const tickOriginal = () => {
		fireEvent.click(screen.getByText("Settings…"));
		fireEvent.click(screen.getByLabelText("Play original recording (more noise)"));
	};

	it("plays the noise-reduced render until the listener says otherwise", async () => {
		await renderSettled(oneLiveClip);
		expect(srcOf(1)).toBe(ENHANCED);
	});

	it("plays the source recording when a previous session chose it", async () => {
		mockAppData.current = { playOriginalAudio: true };
		await renderSettled(oneLiveClip);
		expect(srcOf(1)).toBe(ORIGINAL);
	});

	// The point of the whole setting: it has to take effect on the cards already
	// playing, and it has to do so by re-pointing the element rather than
	// replacing it. audioCapture's createMediaElementSource may be called only
	// once per element and the capture is permanent, so a swap that released and
	// re-created would leave the waveform reading a dead audio graph — silently,
	// and only for listeners who touch this setting.
	it("re-points the SAME element, without a reload or a release", async () => {
		await renderSettled(oneLiveClip);
		const element = audio.elements.get(1);
		expect(element?.src).toBe(ENHANCED);

		tickOriginal();
		fireEvent.click(screen.getByText("Save"));
		await act(async () => {});

		expect(audio.elements.get(1)).toBe(element);
		expect(element?.src).toBe(ORIGINAL);
		expect(audio.released).not.toContain(1);
	});

	it("switches back to the enhanced render just as live", async () => {
		mockAppData.current = { playOriginalAudio: true };
		await renderSettled(oneLiveClip);
		const element = audio.elements.get(1);

		fireEvent.click(screen.getByText("Settings…"));
		fireEvent.click(screen.getByLabelText("Play original recording (more noise)"));
		fireEvent.click(screen.getByText("Save"));
		await act(async () => {});

		expect(audio.elements.get(1)).toBe(element);
		expect(element?.src).toBe(ENHANCED);
	});

	// The draft contract: Cancel is genuinely free, here too.
	it("leaves the audio alone when the listener cancels", async () => {
		await renderSettled(oneLiveClip);
		tickOriginal();
		fireEvent.click(screen.getByText("Cancel"));
		await act(async () => {});

		expect(srcOf(1)).toBe(ENHANCED);
		expect(lastPersisted()).toMatchObject({ playOriginalAudio: false });
	});

	// Persistence is what makes it a setting rather than a session preference.
	it("persists the choice through the app's own state", async () => {
		await renderSettled(oneLiveClip);
		tickOriginal();
		fireEvent.click(screen.getByText("Save"));
		await act(async () => {});

		expect(lastPersisted()).toMatchObject({ playOriginalAudio: true });
	});

	// A row the enhancement pass has not reached has no second copy, and `url` is
	// the safe fallback — the alternative is an undefined src, which fails as a
	// broken element with nothing on screen to say why.
	it("falls back to the source recording for a clip with no enhanced copy", async () => {
		mockAppData.current = { playOriginalAudio: false };
		await renderSettled({ ...oneLiveClip, mp3Items: [{ ...both, enhanced_url: null }] });
		expect(srcOf(1)).toBe(ORIGINAL);
	});
});
