// Radio Traffic's persisted state: the reducer, the manifest, and the
// sanitizer every read of that state goes through.
//
// Four things survive a reload — the checked tag filters, the active tool, the
// two collapsible lanes' fold state, and the manual lane order — plus per-item
// mute (see mutedItems below). All five come back out of localStorage via
// Classicy's store, which makes them UNTRUSTED input: a hand-edited or stale
// value could be anything. This module is the only place they are read, and
// sanitizeRadioTrafficState is the only way to read them, so there is exactly
// one place a bad value can be turned into a good one.
//
// The `tool` field is the sharp one. Radio Traffic is modal — a card click
// means whatever the active tool says it means — and applyToolClick switches on
// exactly four values. A persisted "banana" would leave the app in a mode with
// no handler: every card click a silent no-op, the palette showing nothing
// selected, and no way to notice why.

import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
import { sanitizeItemIds } from "../radio-core/radioPlayback";
import type { Lane } from "./cardStatus";
import { LANES, type LaneOrder } from "./laneOrder";
import { type Tool, TOOLS } from "./toolMode";

const appId = "RadioTraffic.app";

/** Solo. The tool the app boots in and the fallback for an unreadable one. */
export const DEFAULT_TOOL: Tool = "arrow";

/**
 * The waveform's ink, when the listener has taken it off the theme.
 *
 * The tuner's `colorBright` — the pre-theme hardcoded green every radio
 * waveform in this repo used to be drawn in. A custom colour that opened on
 * something arbitrary would read as a bug the first time anyone unticked the
 * box.
 */
export const DEFAULT_WAVEFORM_COLOR = 0x00d25a;

/**
 * The slice of persisted state the Settings window edits.
 *
 * Split out so the window is typed to exactly what it changes: it can neither
 * read nor write a tag filter, a lane order or a mute by mistake, and adding a
 * field to {@link RadioTrafficState} does not silently widen its reach.
 */
export interface RadioTrafficSettings {
	/**
	 * true = the waveform follows the theme's ink (`--color-system-06`, set on
	 * `.rtCardWaveform`), so a theme change re-colours every card live. This is
	 * the default, and it is what the app did before the setting existed.
	 */
	useThemeWaveformColor: boolean;
	/** Custom waveform ink, packed 0xRRGGBB — ClassicyColorPicker native. */
	waveformColor: number;
	/**
	 * true = play the source recording instead of the noise-reduced render.
	 *
	 * Defaults false: the enhanced copy is easier to listen to, but the original
	 * stays one tick away because this is a primary-source archive. This app is
	 * where the choice belongs — comm traffic is what the enhancement pass runs
	 * over — so it moved here from the radio-core settings window the Tuner
	 * renders, where it sat in front of broadcast stations it does not describe.
	 */
	playOriginalAudio: boolean;
}

export const DEFAULT_RADIO_TRAFFIC_SETTINGS: RadioTrafficSettings = {
	useThemeWaveformColor: true,
	waveformColor: DEFAULT_WAVEFORM_COLOR,
	playOriginalAudio: false,
};

/** Everything Radio Traffic persists, after sanitizing. */
export interface RadioTrafficState extends RadioTrafficSettings {
	/** Checked tag strings, e.g. `facility:zbw`. */
	checked: string[];
	tool: Tool;
	/** Per-lane fold state. LIVE's is stored but ignored — it has no control. */
	collapsed: Record<Lane, boolean>;
	laneOrder: LaneOrder;
	/**
	 * Per-card mute, persisted rather than reset.
	 *
	 * Decision 1 gives each player its own mute state, and the tuner persisted
	 * the same list (`RadioScanner.tsx`'s `mutedItems`). Dropping it would make
	 * "mute this card" the one instruction in the app that silently expires on
	 * reload. Solo is deliberately NOT persisted: it is a temporary override
	 * whose target reconcileSolo picks fresh from whatever is actually live at
	 * boot, and a restored one would point at a clip from another hour.
	 */
	mutedItems: number[];
}

/** Keep only string entries — a checked tag is always `namespace:value`. */
function sanitizeTags(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Anything outside the four modal tools falls back — see the header. */
function sanitizeTool(value: unknown): Tool {
	return TOOLS.includes(value as Tool) ? (value as Tool) : DEFAULT_TOOL;
}

/** Per lane, only an explicit `true` folds it away. */
function sanitizeCollapsed(value: unknown): Record<Lane, boolean> {
	const stored = (value ?? {}) as Record<string, unknown>;
	const out = {} as Record<Lane, boolean>;
	for (const lane of LANES) out[lane] = stored[lane] === true;
	return out;
}

/**
 * One lane's pins, or nothing.
 *
 * A lane's pins are a FLAT (itemId, slot) pair list, so this is the one place
 * sanitizeItemIds' filter-in-place behaviour would be wrong: dropping a single
 * bad entry re-pairs every pin after it, turning ids into slots. A lane whose
 * stored list contains anything but finite numbers is therefore dropped whole —
 * the honest answer to a half-readable instruction is that there is none.
 */
function sanitizePins(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	const pins = sanitizeItemIds(value);
	return pins.length === value.length ? pins : [];
}

/**
 * Only an explicit `false` takes the waveform off the theme.
 *
 * Absent, `undefined` and garbage all mean "follow the theme", which is both the
 * default and what every session persisted before this setting existed — so the
 * upgrade needs no migration and an unreadable value cannot leave a listener
 * staring at a colour they never picked.
 */
function sanitizeUseThemeWaveformColor(value: unknown): boolean {
	return value !== false;
}

/** A packed 0xRRGGBB integer; anything else is the default green. */
function sanitizeWaveformColor(value: unknown): number {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 0xffffff
		? value
		: DEFAULT_WAVEFORM_COLOR;
}

/**
 * Only an explicit `true` reaches past the noise-reduced render.
 *
 * The mirror of sanitizeUseThemeWaveformColor: absent, `undefined` and garbage
 * all mean the enhanced copy, which is both the default and what every session
 * played before the setting arrived here — so nothing needs migrating, and an
 * unreadable value cannot leave a listener wondering why the tape got noisier.
 */
function sanitizePlayOriginalAudio(value: unknown): boolean {
	return value === true;
}

function sanitizeLaneOrder(value: unknown): LaneOrder {
	const stored = (value ?? {}) as Record<string, unknown>;
	const out = {} as Record<Lane, readonly number[]>;
	for (const lane of LANES) out[lane] = sanitizePins(stored[lane]);
	return out;
}

/**
 * Read persisted state, falling back FIELD BY FIELD.
 *
 * Per-field rather than all-or-nothing on purpose (the rule
 * `radioScannerSettings.ts` states and `radioPlayback.ts`'s sanitizers follow):
 * one unreadable value must not throw away the four that are fine.
 */
export function sanitizeRadioTrafficState(stored: unknown): RadioTrafficState {
	const data = (stored ?? {}) as Record<string, unknown>;
	return {
		checked: sanitizeTags(data.checked),
		tool: sanitizeTool(data.tool),
		collapsed: sanitizeCollapsed(data.collapsed),
		laneOrder: sanitizeLaneOrder(data.laneOrder),
		mutedItems: sanitizeItemIds(data.mutedItems),
		useThemeWaveformColor: sanitizeUseThemeWaveformColor(data.useThemeWaveformColor),
		waveformColor: sanitizeWaveformColor(data.waveformColor),
		playOriginalAudio: sanitizePlayOriginalAudio(data.playOriginalAudio),
	};
}

/** Persist the whole of the above in one dispatch. */
export const radioTrafficSetState = (state: RadioTrafficState): ActionMessage => ({
	type: "ClassicyAppRadioTrafficSetState",
	checked: state.checked,
	tool: state.tool,
	collapsed: state.collapsed,
	laneOrder: state.laneOrder,
	mutedItems: state.mutedItems,
	useThemeWaveformColor: state.useThemeWaveformColor,
	waveformColor: state.waveformColor,
	playOriginalAudio: state.playOriginalAudio,
});

export const classicyRadioTrafficEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppRadioTrafficSetState":
			app.data = {
				...appData,
				checked: action.checked,
				tool: action.tool,
				collapsed: action.collapsed,
				laneOrder: action.laneOrder,
				mutedItems: action.mutedItems,
				useThemeWaveformColor: action.useThemeWaveformColor,
				waveformColor: action.waveformColor,
				playOriginalAudio: action.playOriginalAudio,
			};
			return ds;
		default:
			return ds;
	}
};

const laneFlags = z
	.object({
		live: z.boolean(),
		upcoming: z.boolean(),
		previous: z.boolean(),
	})
	.partial();

const lanePins = z
	.object({
		live: z.array(z.number()),
		upcoming: z.array(z.number()),
		previous: z.array(z.number()),
	})
	.partial();

export const RadioTrafficDataSchema = z.looseObject({
	checked: z
		.array(z.string())
		.optional()
		.describe("Tag filters you have ticked in the sidebar, as namespace:value strings."),
	tool: z
		.enum(["arrow", "mute", "unmute", "hand"])
		.optional()
		.describe("The selected tool: what clicking a card does — solo, mute, unmute or move."),
	collapsed: laneFlags
		.optional()
		.describe("Which lanes you have folded away. The LIVE lane never folds."),
	laneOrder: lanePins
		.optional()
		.describe("Cards you have dragged, as (card, position) pairs per lane."),
	mutedItems: z
		.array(z.number())
		.optional()
		.describe("Cards you have silenced. Each card keeps its own mute setting."),
	useThemeWaveformColor: z
		.boolean()
		.optional()
		.describe("Whether the card waveforms follow the desktop theme's colors."),
	waveformColor: z
		.number()
		.optional()
		.describe("The color the card waveforms are drawn in when not following the theme."),
	playOriginalAudio: z
		.boolean()
		.optional()
		.describe(
			"Whether cards play the original recording instead of the cleaned-up, noise-reduced one.",
		),
});

export type RadioTrafficData = z.infer<typeof RadioTrafficDataSchema>;

registerApp({
	id: appId,
	description:
		"Follow 9/11 air-traffic, military and emergency radio traffic as live, upcoming and past cards you can filter by tag.",
	prefix: "ClassicyAppRadioTraffic",
	handler: classicyRadioTrafficEventHandler,
	actions: {
		ClassicyAppRadioTrafficSetState: {
			description:
				"Persist the tag filters, the selected tool, the folded lanes, the manual card order, the per-card mutes, the waveform color and the original-recording choice.",
			params: z.object({
				checked: z.array(z.string()).describe("Ticked tag filters."),
				tool: z.string().describe("Selected tool: arrow, mute, unmute or hand."),
				collapsed: z.record(z.string(), z.unknown()).describe("Full lane-collapse object."),
				laneOrder: z.record(z.string(), z.unknown()).describe("Full lane-order object."),
				mutedItems: z.array(z.number()).describe("Silenced cards' ids."),
				useThemeWaveformColor: z
					.boolean()
					.describe("Whether the waveforms follow the theme."),
				waveformColor: z.number().describe("Custom waveform color, packed 0xRRGGBB."),
				playOriginalAudio: z
					.boolean()
					.describe("Whether to play the original recording rather than the enhanced one."),
			}),
		},
	},
	state: RadioTrafficDataSchema,
});
