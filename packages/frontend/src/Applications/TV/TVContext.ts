import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

const appId = "TV.app";

export const classicyTVEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	if (action.type !== "ClassicyAppTVSetGridState") return ds;

	ds.System.Manager.Applications.apps[appId].data = {
		...(ds.System.Manager.Applications.apps[appId].data ?? {}),
		multiSelectMode: action.multiSelectMode,
		selectedPlayers: action.selectedPlayers,
		mutedGridPlayers: action.mutedGridPlayers,
	};
	return ds;
};

registerAppEventHandler("ClassicyAppTV", classicyTVEventHandler);
