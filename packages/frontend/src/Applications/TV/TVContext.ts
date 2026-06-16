import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

const appId = "TV.app";

export const classicyTVEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	const appData = ds.System.Manager.Applications.apps[appId].data ?? {};

	switch (action.type) {
		case "ClassicyAppTVSetGridState":
			ds.System.Manager.Applications.apps[appId].data = {
				...appData,
				multiSelectMode: action.multiSelectMode,
				selectedPlayers: action.selectedPlayers,
				mutedGridPlayers: action.mutedGridPlayers,
			};
			return ds;
		// Channels the user has turned off in Settings. Stored as a blacklist of
		// `source` slugs so any channel that appears later defaults to enabled.
		case "ClassicyAppTVSetDisabledChannels":
			ds.System.Manager.Applications.apps[appId].data = {
				...appData,
				disabledChannels: action.disabledChannels,
			};
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppTV", classicyTVEventHandler);
