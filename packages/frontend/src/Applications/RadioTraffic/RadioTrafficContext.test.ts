import type { ActionMessage, ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyRadioTrafficEventHandler,
	DEFAULT_TOOL,
	DEFAULT_WAVEFORM_COLOR,
	radioTrafficSetState,
	sanitizeRadioTrafficState,
} from "./RadioTrafficContext";
import { TOOLS } from "./toolMode";

/** A store with one Radio Traffic app entry holding `data`. */
function store(data: Record<string, unknown> = {}): ClassicyStore {
	return {
		System: {
			Manager: {
				Applications: { apps: { "RadioTraffic.app": { data } } },
			},
		},
	} as unknown as ClassicyStore;
}

const appData = (ds: ClassicyStore) =>
	ds.System.Manager.Applications.apps["RadioTraffic.app"].data as Record<string, unknown>;

describe("sanitizeRadioTrafficState", () => {
	it("returns the documented defaults for absent state", () => {
		expect(sanitizeRadioTrafficState(undefined)).toEqual({
			checked: [],
			tool: DEFAULT_TOOL,
			collapsed: { live: false, upcoming: false, previous: false },
			laneOrder: { live: [], upcoming: [], previous: [] },
			mutedItems: [],
			useThemeWaveformColor: true,
			waveformColor: DEFAULT_WAVEFORM_COLOR,
		});
	});

	it("round-trips a fully-populated, valid state", () => {
		const stored = {
			checked: ["facility:zbw", "topic:hijacking"],
			tool: "mute",
			collapsed: { live: false, upcoming: true, previous: false },
			laneOrder: { live: [7, 0], upcoming: [], previous: [3, 1] },
			mutedItems: [11, 12],
			useThemeWaveformColor: false,
			waveformColor: 0x0000ff,
		};
		expect(sanitizeRadioTrafficState(stored)).toEqual(stored);
	});

	// The whole reason this function exists: applyToolClick switches on exactly
	// four values, so an unknown tool is a mode with no handler — every card
	// click a silent no-op with nothing on screen to explain it.
	it.each([["banana"], [42], [null], [{}], [undefined]])(
		"falls an unknown tool (%s) back to the default rather than dead-ending",
		(tool) => {
			expect(sanitizeRadioTrafficState({ tool }).tool).toBe(DEFAULT_TOOL);
		},
	);

	it("keeps every one of the four real tools", () => {
		for (const tool of TOOLS) {
			expect(sanitizeRadioTrafficState({ tool }).tool).toBe(tool);
		}
	});

	it("drops non-string checked tags and non-array checked", () => {
		expect(sanitizeRadioTrafficState({ checked: ["a:b", 3, null, "c:d"] }).checked).toEqual([
			"a:b",
			"c:d",
		]);
		expect(sanitizeRadioTrafficState({ checked: "a:b" }).checked).toEqual([]);
	});

	it("treats any non-true lane-collapse value as expanded", () => {
		expect(
			sanitizeRadioTrafficState({
				collapsed: { upcoming: "yes", previous: true, live: 1 },
			}).collapsed,
		).toEqual({ live: false, upcoming: false, previous: true });
	});

	it("keeps a clean pin list and drops a lane whose pins are not all numbers", () => {
		// Filtering the bad entry out would re-pair the flat (id, slot) list and
		// silently turn item 5 into a slot, so the lane is dropped whole.
		const order = sanitizeRadioTrafficState({
			laneOrder: { live: [3, 1, 5, 2], upcoming: [3, "x", 5, 2], previous: "nope" },
		}).laneOrder;
		expect(order.live).toEqual([3, 1, 5, 2]);
		expect(order.upcoming).toEqual([]);
		expect(order.previous).toEqual([]);
	});

	it("keeps only finite muted ids", () => {
		expect(
			sanitizeRadioTrafficState({ mutedItems: [1, "2", Number.NaN, 3] }).mutedItems,
		).toEqual([1, 3]);
	});

	it("falls back field by field, keeping the readable ones", () => {
		const state = sanitizeRadioTrafficState({
			checked: ["facility:zbw"],
			tool: "banana",
			mutedItems: [9],
		});
		expect(state.checked).toEqual(["facility:zbw"]);
		expect(state.mutedItems).toEqual([9]);
		expect(state.tool).toBe(DEFAULT_TOOL);
	});

	describe("the waveform color", () => {
		// Every session persisted before this setting existed stored neither
		// field. Those sessions must come back on the theme — which is what they
		// were already showing — rather than on some stored colour they never
		// picked, so there is nothing to migrate.
		it("treats a state saved before the setting existed as following the theme", () => {
			const state = sanitizeRadioTrafficState({ tool: "mute" });
			expect(state.useThemeWaveformColor).toBe(true);
			expect(state.waveformColor).toBe(DEFAULT_WAVEFORM_COLOR);
		});

		it("takes the waveform off the theme only on an explicit false", () => {
			expect(
				sanitizeRadioTrafficState({ useThemeWaveformColor: false })
					.useThemeWaveformColor,
			).toBe(false);
			for (const junk of [undefined, null, 0, "false", "no"]) {
				expect(
					sanitizeRadioTrafficState({ useThemeWaveformColor: junk })
						.useThemeWaveformColor,
				).toBe(true);
			}
		});

		it("keeps a packed 0xRRGGBB color, including the two ends of the range", () => {
			for (const color of [0x000000, 0x00d25a, 0xffffff]) {
				expect(sanitizeRadioTrafficState({ waveformColor: color }).waveformColor).toBe(
					color,
				);
			}
		});

		// localStorage is untrusted input, and this value is handed to intToHex
		// and then straight into a CSS `color` — a NaN or an out-of-range number
		// would draw every card's envelope in whatever the browser makes of the
		// resulting garbage string.
		it("falls back for anything that is not a color", () => {
			for (const junk of [-1, 0x1000000, 1.5, NaN, "#ff0000", null, {}]) {
				expect(sanitizeRadioTrafficState({ waveformColor: junk }).waveformColor).toBe(
					DEFAULT_WAVEFORM_COLOR,
				);
			}
		});
	});
});

describe("classicyRadioTrafficEventHandler", () => {
	it("persists every field and leaves unrelated data alone", () => {
		const ds = store({ somethingElse: 1 });
		const next = classicyRadioTrafficEventHandler(
			ds,
			radioTrafficSetState({
				checked: ["topic:hijacking"],
				tool: "hand",
				collapsed: { live: false, upcoming: true, previous: false },
				laneOrder: { live: [1, 0], upcoming: [], previous: [] },
				mutedItems: [4],
				useThemeWaveformColor: false,
				waveformColor: 0xff6600,
			}),
		);
		expect(appData(next)).toEqual({
			somethingElse: 1,
			checked: ["topic:hijacking"],
			tool: "hand",
			collapsed: { live: false, upcoming: true, previous: false },
			laneOrder: { live: [1, 0], upcoming: [], previous: [] },
			mutedItems: [4],
			useThemeWaveformColor: false,
			waveformColor: 0xff6600,
		});
	});

	it("ignores actions it does not handle", () => {
		const ds = store({ tool: "mute" });
		const next = classicyRadioTrafficEventHandler(ds, {
			type: "SomethingElse",
		} as ActionMessage);
		expect(appData(next)).toEqual({ tool: "mute" });
	});

	// A dispatch that arrives before the app is registered must not throw.
	it("returns the store untouched when the app is not registered", () => {
		const ds = {
			System: { Manager: { Applications: { apps: {} } } },
		} as unknown as ClassicyStore;
		expect(
			classicyRadioTrafficEventHandler(ds, radioTrafficSetState({
				checked: [],
				tool: "arrow",
				collapsed: { live: false, upcoming: false, previous: false },
				laneOrder: { live: [], upcoming: [], previous: [] },
				mutedItems: [],
				useThemeWaveformColor: true,
				waveformColor: DEFAULT_WAVEFORM_COLOR,
			})),
		).toBe(ds);
	});
});
