import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import type { ReadmeSettings } from "./readmeSettings";

const appId = "Readme.app";

// Persists the reader's tag-filter settings into the app's data slice. classicy
// routes any action whose type starts with "ClassicyAppReadme" here (registered
// below), and the resulting store is localStorage-backed.
export const classicyReadmeEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppReadmeSetSettings":
			app.data = {
				...appData,
				settings: action.settings as ReadmeSettings,
			};
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppReadme", classicyReadmeEventHandler);
