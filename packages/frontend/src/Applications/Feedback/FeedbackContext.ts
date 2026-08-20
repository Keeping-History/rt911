import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
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

export const FeedbackDataSchema = z.looseObject({
	github: z
		.string()
		.optional()
		.describe("The reporter's GitHub handle; \"\" means explicitly cleared (distinct from never entered)."),
});

export type FeedbackData = z.infer<typeof FeedbackDataSchema>;

registerApp({
	id: FEEDBACK_APP_ID,
	description: "Report a bug or suggestion; filed as a GitHub issue.",
	prefix: "ClassicyAppFeedback",
	handler: classicyFeedbackEventHandler,
	actions: {
		ClassicyAppFeedbackSetGithub: {
			description: "Persist the reporter's GitHub handle (\"\" = cleared).",
			params: z.object({ github: z.string().describe("GitHub handle, or \"\" to clear.") }),
		},
	},
	state: FeedbackDataSchema,
});
