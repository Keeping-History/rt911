import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

export interface CaptionStyle {
	font: string;
	color: number;
	colorOpacity: number;
	bgColor: number;
	bgOpacity: number;
	size: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
	font: "--ui-font",
	color: 16777215, // white
	colorOpacity: 1,
	bgColor: 0, // black
	bgOpacity: 0.8,
	size: 100,
};

export const TV_APP_ID = "TV.app";
const appId = TV_APP_ID;

/**
 * A channel is referenced either by its numeric MediaItem id or by its channel
 * name (the `source` slug, e.g. "WETA"). Remote callers usually only know the
 * name, so both are accepted and resolved inside the TV app.
 */
export type TVChannelRef = number | string;

/**
 * One-shot view command delivered through the store. `seq` is monotonic so the
 * TV component can apply each command exactly once (and apply the latest one on
 * mount, even if it was issued while the app was closed).
 */
export interface TVRemoteCommand {
	seq: number;
	kind: "tune" | "grid" | "exitGrid";
	channel?: TVChannelRef;
	channels?: TVChannelRef[];
}

// --- Cross-app remote-control API ---------------------------------------
// Other apps dispatch these action creators to drive the TV without importing
// any of its internals. Action types share the "ClassicyAppTV" prefix so they
// route to the handler registered below.

/** Tune to a single channel and show it as the only video. */
export const tvTuneChannel = (channel: TVChannelRef): ActionMessage => ({
	type: "ClassicyAppTVTuneChannel",
	channel,
});

/** Show a grid of the given channels (by id or name). */
export const tvSetGridChannels = (channels: TVChannelRef[]): ActionMessage => ({
	type: "ClassicyAppTVSetGrid",
	channels,
});

/** Leave grid view and return to a single active channel. */
export const tvExitGrid = (): ActionMessage => ({ type: "ClassicyAppTVExitGrid" });

/** Set the maximum volume (0..1) applied to any playing video. */
export const tvSetVolumeLimit = (volumeLimit: number): ActionMessage => ({
	type: "ClassicyAppTVSetVolumeLimit",
	volumeLimit,
});

/** Mute or unmute every video at once. */
export const tvSetMuted = (muted: boolean): ActionMessage => ({
	type: "ClassicyAppTVSetMuted",
	muted,
});

/** Freeze every video (the Classicy clock keeps running). */
export const tvPause = (): ActionMessage => ({ type: "ClassicyAppTVPause" });

/** Resume playback at the live Classicy clock time (not where it was paused). */
export const tvResume = (): ActionMessage => ({ type: "ClassicyAppTVPlay" });

/** Alias for {@link tvResume} — there is no separate "from a stop" state. */
export const tvPlay = tvResume;

/** Set whether closed captions are on and their display style. */
export const tvSetCaptionState = (
	captionsOn: boolean,
	captionStyle: CaptionStyle,
): ActionMessage => ({
	type: "ClassicyAppTVSetCaptionState",
	captionsOn,
	captionStyle,
});

/** Persist which channel is the active single-view player. */
export const tvSetActivePlayer = (activePlayer: number): ActionMessage => ({
	type: "ClassicyAppTVSetActivePlayer",
	activePlayer,
});

/**
 * Publish the active channel's `source` slug (data.currentChannel) so external
 * controllers — the playlist engine's locked-focus reconciliation — can see
 * where the TV is tuned without resolving numeric item ids.
 */
export const tvSetCurrentChannel = (source: string): ActionMessage => ({
	type: "ClassicyAppTVSetCurrentChannel",
	source,
});

/**
 * The user's drag-ordered channel slugs for the thumbnail strip. Stored as
 * `item.source` values, not ids: ids belong to the currently-airing item and
 * change on every program rollover. Classicy snapshots app data to
 * localStorage, so this persists per-user with no storage code here.
 */
export const tvSetChannelOrder = (channelOrder: string[]): ActionMessage => ({
	type: "ClassicyAppTVSetChannelOrder",
	channelOrder,
});

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// Next command sequence number = previous + 1 (starts at 1).
const nextSeq = (appData: Record<string, unknown>): number =>
	((appData.command as TVRemoteCommand | undefined)?.seq ?? 0) + 1;

export const classicyTVEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	const appData = ds.System.Manager.Applications.apps[appId].data ?? {};
	const apps = ds.System.Manager.Applications.apps;

	switch (action.type) {
		case "ClassicyAppTVSetGridState":
			apps[appId].data = {
				...appData,
				multiSelectMode: action.multiSelectMode,
				selectedChannels: action.selectedChannels,
				mutedChannels: action.mutedChannels,
				channelVolumes: action.channelVolumes,
			};
			return ds;
		// Channels the user has turned off in Settings. Stored as a blacklist of
		// `source` slugs so any channel that appears later defaults to enabled.
		case "ClassicyAppTVSetDisabledChannels":
			apps[appId].data = { ...appData, disabledChannels: action.disabledChannels };
			return ds;
		// --- Remote-control commands ---
		case "ClassicyAppTVTuneChannel":
			apps[appId].data = {
				...appData,
				command: {
					seq: nextSeq(appData),
					kind: "tune",
					channel: action.channel as TVChannelRef,
				} satisfies TVRemoteCommand,
			};
			return ds;
		case "ClassicyAppTVSetGrid":
			apps[appId].data = {
				...appData,
				command: {
					seq: nextSeq(appData),
					kind: "grid",
					channels: action.channels as TVChannelRef[],
				} satisfies TVRemoteCommand,
			};
			return ds;
		case "ClassicyAppTVExitGrid":
			apps[appId].data = {
				...appData,
				command: { seq: nextSeq(appData), kind: "exitGrid" } satisfies TVRemoteCommand,
			};
			return ds;
		case "ClassicyAppTVSetVolumeLimit":
			apps[appId].data = {
				...appData,
				volumeLimit: clamp01(action.volumeLimit as number),
			};
			return ds;
		case "ClassicyAppTVSetMuted":
			apps[appId].data = { ...appData, overallMuted: action.muted as boolean };
			return ds;
		case "ClassicyAppTVPause":
			apps[appId].data = { ...appData, tvPaused: true };
			return ds;
		// Play and Resume are the same: unpause and let the component seek to the
		// live clock. Fast-forward / rewind are intentionally unsupported — video
		// position is always derived from the Classicy clock.
		case "ClassicyAppTVPlay":
			apps[appId].data = { ...appData, tvPaused: false };
			return ds;
		case "ClassicyAppTVSetCaptionState":
			apps[appId].data = {
				...appData,
				captionsOn: action.captionsOn as boolean,
				captionStyle: action.captionStyle as CaptionStyle,
			};
			return ds;
		case "ClassicyAppTVSetActivePlayer":
			apps[appId].data = {
				...appData,
				activePlayer: action.activePlayer as number,
			};
			return ds;
		case "ClassicyAppTVSetCurrentChannel":
			apps[appId].data = {
				...appData,
				currentChannel: action.source as string,
			};
			return ds;
		case "ClassicyAppTVSetChannelOrder":
			apps[appId].data = {
				...appData,
				channelOrder: action.channelOrder as string[],
			};
			return ds;
		default:
			return ds;
	}
};

const captionStyleSchema = z.object({
	font: z.string().describe("CSS custom-property name for the caption font family, e.g. \"--ui-font\"."),
	color: z.number().describe("Caption text color, packed 0xRRGGBB."),
	colorOpacity: z.number().describe("Caption text alpha, 0..1."),
	bgColor: z.number().describe("Caption background color, packed 0xRRGGBB."),
	bgOpacity: z.number().describe("Caption background alpha, 0..1."),
	size: z.number().describe("Caption font-size scale, percent (100 = base size)."),
});

const channelRefSchema = z
	.union([z.number(), z.string()])
	.describe("A channel by numeric MediaItem id or by source slug (e.g. \"WETA\").");

export const TvDataSchema = z.looseObject({
	multiSelectMode: z.boolean().optional().describe("Whether grid view is in multi-select mode."),
	selectedChannels: z.array(z.string()).optional().describe("Source slugs of the channels selected in grid view."),
	mutedChannels: z.array(z.string()).optional().describe("Source slugs of grid channels the user has muted."),
	channelVolumes: z.record(z.string(), z.number()).optional().describe("Per-channel volume (0..1) keyed by source slug."),
	disabledChannels: z.array(z.string()).optional().describe("Source slugs the user turned off in Settings (blacklist: new channels default on)."),
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each one-shot command applies exactly once."),
			kind: z.enum(["tune", "grid", "exitGrid"]).describe("Which remote command to run."),
			channel: channelRefSchema.optional(),
			channels: z.array(channelRefSchema).optional(),
		})
		.optional()
		.describe("Pending one-shot remote-control command (tune / grid / exitGrid)."),
	volumeLimit: z.number().optional().describe("Maximum volume (0..1) applied to any playing video."),
	overallMuted: z.boolean().optional().describe("Whether every video is muted at once."),
	tvPaused: z.boolean().optional().describe("Whether playback is frozen (the virtual clock keeps running)."),
	captionsOn: z.boolean().optional().describe("Whether closed captions are shown."),
	captionStyle: captionStyleSchema.optional().describe("Closed-caption display style."),
	activePlayer: z.number().optional().describe("MediaItem id of the active single-view player."),
	currentChannel: z.string().optional().describe("Source slug of the active channel, published for external controllers (playlist locked-focus)."),
	channelOrder: z.array(z.string()).optional().describe("User's drag-ordered source slugs for the thumbnail strip."),
});

export type TvData = z.infer<typeof TvDataSchema>;

registerApp({
	id: TV_APP_ID,
	description: "Watch the synchronized 9/11 broadcast channels, live to the virtual clock.",
	prefix: "ClassicyAppTV",
	handler: classicyTVEventHandler,
	actions: {
		ClassicyAppTVSetGridState: {
			description: "Persist grid view's selection, mute, and volume state.",
			params: z.object({
				multiSelectMode: z.boolean().describe("Whether multi-select mode is on."),
				selectedChannels: z.array(z.string()).describe("Selected channels' source slugs."),
				mutedChannels: z.array(z.string()).describe("Muted channels' source slugs."),
				channelVolumes: z.record(z.string(), z.number()).describe("Per-channel volume (0..1) keyed by source slug."),
			}),
		},
		ClassicyAppTVSetDisabledChannels: {
			description: "Persist which channels the user turned off in Settings.",
			params: z.object({
				disabledChannels: z.array(z.string()).describe("Disabled channels' source slugs."),
			}),
		},
		ClassicyAppTVTuneChannel: {
			description: "Tune to a single channel and show it as the only video.",
			params: z.object({ channel: channelRefSchema }),
		},
		ClassicyAppTVSetGrid: {
			description: "Show a grid of the given channels.",
			params: z.object({ channels: z.array(channelRefSchema).describe("Channels to show in the grid.") }),
		},
		ClassicyAppTVExitGrid: {
			description: "Leave grid view and return to a single active channel.",
		},
		ClassicyAppTVSetVolumeLimit: {
			description: "Set the maximum volume applied to any playing video.",
			params: z.object({ volumeLimit: z.number().describe("Volume ceiling, 0..1.") }),
		},
		ClassicyAppTVSetMuted: {
			description: "Mute or unmute every video at once.",
			params: z.object({ muted: z.boolean().describe("true = mute all.") }),
		},
		ClassicyAppTVPause: {
			description: "Freeze every video; the virtual clock keeps running.",
		},
		ClassicyAppTVPlay: {
			description: "Resume playback at the live virtual-clock time (not where it paused).",
		},
		ClassicyAppTVSetCaptionState: {
			description: "Set whether closed captions are on and their display style.",
			params: z.object({
				captionsOn: z.boolean().describe("Whether captions are shown."),
				captionStyle: captionStyleSchema,
			}),
		},
		ClassicyAppTVSetActivePlayer: {
			description: "Persist which channel is the active single-view player.",
			params: z.object({ activePlayer: z.number().describe("Active player's MediaItem id.") }),
		},
		ClassicyAppTVSetCurrentChannel: {
			description: "Publish the active channel's source slug for external controllers.",
			params: z.object({ source: z.string().describe("The active channel's source slug.") }),
		},
		ClassicyAppTVSetChannelOrder: {
			description: "Persist the user's drag-ordered channel strip.",
			params: z.object({ channelOrder: z.array(z.string()).describe("Source slugs in display order.") }),
		},
	},
	state: TvDataSchema,
});
