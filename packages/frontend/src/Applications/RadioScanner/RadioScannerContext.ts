import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import type { RadioScannerSettings } from "./radioScannerSettings";

const appId = "RadioScanner.app";

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
