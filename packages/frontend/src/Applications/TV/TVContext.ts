import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

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
				selectedPlayers: action.selectedPlayers,
				mutedGridPlayers: action.mutedGridPlayers,
				gridPlayerVolumes: action.gridPlayerVolumes,
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
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppTV", classicyTVEventHandler);
