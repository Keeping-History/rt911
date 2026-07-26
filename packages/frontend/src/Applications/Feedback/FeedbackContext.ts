import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import { FEEDBACK_APP_ID } from "./useFeedback";

// Persists the reporter's GitHub handle into the app's data slice. classicy
// routes any action whose type starts with "ClassicyAppFeedback" here
// (registered below), and the resulting store is localStorage-backed.
export const classicyFeedbackEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[FEEDBACK_APP_ID];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppFeedbackSetGithub":
			// Always writes the key, including for "" — see readStoredGithub on why
			// "cleared" has to be distinguishable from "never entered".
			app.data = { ...appData, github: action.github as string };
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppFeedback", classicyFeedbackEventHandler);
