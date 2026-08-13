import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

export const TIME_MACHINE_APP_ID = "TimeMachine.app";
const appId = TIME_MACHINE_APP_ID;

// Transport preferences (the Settings window's two sliders). Ephemeral UI
// state (open windows, the H/M/S entry form, the settings draft) is NOT
// persisted; only the user's choices are — same split as weatherSettings.ts.
export interface TimeMachineSettings {
	/** ⇚/⇛ skip distance, minutes. Slider range 1–60. */
	skipMinutes: number;
	/** «/» step distance, seconds. Slider range 1–600. */
	stepSeconds: number;
	/** ‹/› scrub distance, seconds. Slider range 1–60. */
	scrubSeconds: number;
}

export const DEFAULT_TIME_MACHINE_SETTINGS: TimeMachineSettings = {
	skipMinutes: 30,
	stepSeconds: 300, // 5 minutes
	scrubSeconds: 15,
};

/** Persist the whole settings object in one dispatch. */
export const timeMachineSetSettings = (
	settings: TimeMachineSettings,
): ActionMessage => ({
	type: "ClassicyAppTimeMachineSetSettings",
	settings,
});

// Stored state comes from localStorage, so a hand-edited or stale value could
// be anything; anything outside the slider's own range falls back per-field.
const inRange = (v: unknown, min: number, max: number): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Per-field fallback to defaults, so absent/partial/invalid stored state needs no migration. */
export const readTimeMachineSettings = (
	data: Record<string, unknown> | undefined,
): TimeMachineSettings => {
	const stored =
		(data?.settings as Partial<TimeMachineSettings> | undefined) ?? {};
	return {
		skipMinutes: inRange(stored.skipMinutes, 1, 60)
			? stored.skipMinutes
			: DEFAULT_TIME_MACHINE_SETTINGS.skipMinutes,
		stepSeconds: inRange(stored.stepSeconds, 1, 600)
			? stored.stepSeconds
			: DEFAULT_TIME_MACHINE_SETTINGS.stepSeconds,
		scrubSeconds: inRange(stored.scrubSeconds, 1, 60)
			? stored.scrubSeconds
			: DEFAULT_TIME_MACHINE_SETTINGS.scrubSeconds,
	};
};

export const classicyTimeMachineEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	const appData = ds.System.Manager.Applications.apps[appId].data ?? {};
	const apps = ds.System.Manager.Applications.apps;

	switch (action.type) {
		case "ClassicyAppTimeMachineSetSettings":
			apps[appId].data = { ...appData, settings: action.settings };
			return ds;
		default:
			return ds;
	}
};

export const TimeMachineDataSchema = z.looseObject({
	settings: z
		.looseObject({
			skipMinutes: z.number().describe("⇚/⇛ skip distance, minutes (1–60)."),
			stepSeconds: z.number().describe("«/» step distance, seconds (1–600)."),
			scrubSeconds: z.number().describe("‹/› scrub distance, seconds (1–60)."),
		})
		.partial()
		.optional()
		.describe("Transport preferences (the Settings window's sliders); invalid stored values fall back per-field."),
});

export type TimeMachineData = z.infer<typeof TimeMachineDataSchema>;

registerApp({
	id: TIME_MACHINE_APP_ID,
	description: "Travel the virtual clock: jump, skip, step, and scrub through September 11, 2001.",
	prefix: "ClassicyAppTimeMachine",
	handler: classicyTimeMachineEventHandler,
	actions: {
		ClassicyAppTimeMachineSetSettings: {
			description: "Persist the whole transport-settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full TimeMachineSettings object."),
			}),
		},
	},
	state: TimeMachineDataSchema,
});
