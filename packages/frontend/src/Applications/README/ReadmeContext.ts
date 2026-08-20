import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
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

export const ReadmeDataSchema = z.looseObject({
	settings: z
		.looseObject({
			hiddenTagIds: z
				.array(z.number())
				.describe("Tag ids the reader has unchecked (hidden). Empty = show everything."),
		})
		.partial()
		.optional()
		.describe("Reader preferences (the tag filter); ephemeral UI is never persisted."),
});

export type ReadmeData = z.infer<typeof ReadmeDataSchema>;

registerApp({
	id: appId,
	description: "Read the project's About/README articles, outside the virtual clock's time gate.",
	prefix: "ClassicyAppReadme",
	handler: classicyReadmeEventHandler,
	actions: {
		ClassicyAppReadmeSetSettings: {
			description: "Persist the whole reader-settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full ReadmeSettings object."),
			}),
		},
	},
	state: ReadmeDataSchema,
});
