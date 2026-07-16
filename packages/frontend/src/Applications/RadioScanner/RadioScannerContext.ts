import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import type { RadioScannerSettings } from "./radioScannerSettings";

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

registerAppEventHandler("ClassicyAppRadioScanner", classicyRadioScannerEventHandler);
