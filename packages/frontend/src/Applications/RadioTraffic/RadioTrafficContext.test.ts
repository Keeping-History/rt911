import type { ActionMessage, ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import {
	classicyRadioTrafficEventHandler,
	DEFAULT_TOOL,
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
		});
	});

	it("round-trips a fully-populated, valid state", () => {
		const stored = {
			checked: ["facility:zbw", "topic:hijacking"],
			tool: "mute",
			collapsed: { live: false, upcoming: true, previous: false },
			laneOrder: { live: [7, 0], upcoming: [], previous: [3, 1] },
			mutedItems: [11, 12],
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
});

describe("classicyRadioTrafficEventHandler", () => {
	it("persists all five fields and leaves unrelated data alone", () => {
		const ds = store({ somethingElse: 1 });
		const next = classicyRadioTrafficEventHandler(
			ds,
			radioTrafficSetState({
				checked: ["topic:hijacking"],
				tool: "hand",
				collapsed: { live: false, upcoming: true, previous: false },
				laneOrder: { live: [1, 0], upcoming: [], previous: [] },
				mutedItems: [4],
			}),
		);
		expect(appData(next)).toEqual({
			somethingElse: 1,
			checked: ["topic:hijacking"],
			tool: "hand",
			collapsed: { live: false, upcoming: true, previous: false },
			laneOrder: { live: [1, 0], upcoming: [], previous: [] },
			mutedItems: [4],
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
			})),
		).toBe(ds);
	});
});
