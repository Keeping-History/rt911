import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
import type { RadioScannerSettings } from "../radio-core/radioScannerSettings";

const appId = "RadioScanner.app";

/**
 * One-shot remote tune command delivered through the store (TVContext's
 * pattern): `seq` is monotonic so the component applies each command exactly
 * once, retrying while the station list doesn't contain the slug yet.
 */
export interface RadioRemoteCommand {
	seq: number;
	kind: "tune";
	station: string;
}

/** Tune the scanner to a station by its slug (station key). */
export const radioTuneStation = (station: string): ActionMessage => ({
	type: "ClassicyAppRadioScannerTuneStation",
	station,
});

export const classicyRadioScannerEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppRadioScannerSetState":
			app.data = {
				...appData,
				activeStation: action.activeStation,
				mutedItems: action.mutedItems,
				showWaveform: action.showWaveform,
			};
			return ds;
		case "ClassicyAppRadioScannerTuneStation":
			app.data = {
				...appData,
				command: {
					seq: ((appData.command as RadioRemoteCommand | undefined)?.seq ?? 0) + 1,
					kind: "tune",
					station: action.station as string,
				} satisfies RadioRemoteCommand,
			};
			return ds;
		case "ClassicyAppRadioScannerSetSettings":
			app.data = {
				...appData,
				settings: action.settings as RadioScannerSettings,
			};
			return ds;
		default:
			return ds;
	}
};

export const RadioScannerDataSchema = z.looseObject({
	activeStation: z.string().optional().describe("Slug of the station currently tuned."),
	mutedItems: z.array(z.number()).optional().describe("Ids of media items the user has muted."),
	showWaveform: z.boolean().optional().describe("Whether the waveform visualizer overlay is shown."),
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each tune command applies exactly once."),
			kind: z.literal("tune").describe("Command kind; only \"tune\" exists."),
			station: z.string().describe("Station slug to tune to."),
		})
		.optional()
		.describe("Pending one-shot remote tune command."),
	settings: z
		.looseObject({
			vizMode: z.enum(["Bars", "Spectrum", "Radial", "Wave"]).describe("Waveform display type."),
			useThemeColors: z.boolean().describe("true = follow the desktop theme colors, re-theming live."),
			colorBright: z.number().describe("Custom bright color, packed 0xRRGGBB."),
			colorDim: z.number().describe("Custom dim (gradient end) color, packed 0xRRGGBB."),
			maxVolume: z.number().describe("Volume ceiling for all audio, percent 0..100."),
			captionStyle: z.record(z.string(), z.unknown()).describe("Closed-caption appearance (CaptionStyle)."),
			playOriginalAudio: z.boolean().describe("true = play the source recording instead of the noise-reduced render."),
		})
		.partial()
		.optional()
		.describe("The Settings window's persisted preferences."),
});

export type RadioScannerData = z.infer<typeof RadioScannerDataSchema>;

registerApp({
	id: appId,
	description: "Listen to synchronized 9/11 radio and scanner recordings by station.",
	prefix: "ClassicyAppRadioScanner",
	handler: classicyRadioScannerEventHandler,
	actions: {
		ClassicyAppRadioScannerSetState: {
			description: "Persist the active station, per-station mutes, and waveform visibility.",
			params: z.object({
				activeStation: z.string().describe("Tuned station's slug."),
				mutedItems: z.array(z.number()).describe("Muted media items' ids."),
				showWaveform: z.boolean().describe("Whether the waveform overlay is shown."),
			}),
		},
		ClassicyAppRadioScannerTuneStation: {
			description: "Tune the scanner to a station by slug (one-shot; retries until the station list has it).",
			params: z.object({ station: z.string().describe("Station slug to tune to.") }),
		},
		ClassicyAppRadioScannerSetSettings: {
			description: "Replace the whole persisted settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full RadioScannerSettings object."),
			}),
		},
	},
	state: RadioScannerDataSchema,
});
