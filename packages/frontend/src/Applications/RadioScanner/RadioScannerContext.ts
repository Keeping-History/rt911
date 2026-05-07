import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

const appId = "RadioScanner.app";

export const classicyRadioScannerEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	if (action.type !== "ClassicyAppRadioScannerSetState") return ds;

	ds.System.Manager.Applications.apps[appId].data = {
		...(ds.System.Manager.Applications.apps[appId].data ?? {}),
		scannerMode: action.scannerMode,
		selectedStations: action.selectedStations,
		mutedStations: action.mutedStations,
	};
	return ds;
};

registerAppEventHandler("ClassicyAppRadioScanner", classicyRadioScannerEventHandler);
