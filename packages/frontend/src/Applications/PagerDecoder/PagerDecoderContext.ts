import type {
	ActionMessage,
	ClassicyStore,
} from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";

export interface PagerDecoderFilter {
	provider: string;
	id_type: string;
	channel: string;
	mode: string;
	recipient_id: string;
	message: string;
}

export interface PagerDecoderSettings {
	retentionLines: number;
	filter: PagerDecoderFilter;
}

export const DEFAULT_PAGER_SETTINGS: PagerDecoderSettings = {
	retentionLines: 200,
	filter: {
		provider: "",
		id_type: "",
		channel: "",
		mode: "",
		recipient_id: "",
		message: "",
	},
};

export const classicyPagerDecoderEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const appId = "PagerDecoder.app";
	if (!ds.System.Manager.Applications.apps[appId]) return ds;
	let appData = ds.System.Manager.Applications.apps[appId].data;

	switch (action.type) {
		case "ClassicyAppPagerDecoderInitSettings": {
			if (!appData) appData = {};
			if (!("settings" in appData)) {
				appData.settings = action.settings;
			}
			break;
		}
		case "ClassicyAppPagerDecoderUpdateSettings": {
			if (!appData) appData = {};
			appData.settings = {
				...(appData.settings ?? DEFAULT_PAGER_SETTINGS),
				...(action.settings as Partial<PagerDecoderSettings>),
			};
			break;
		}
	}

	ds.System.Manager.Applications.apps[appId].data = { ...appData };
	return ds;
};

const pagerFilterSchema = z.object({
	provider: z.string().describe("Provider filter substring; \"\" = any."),
	id_type: z.string().describe("Capcode id-type filter; \"\" = any."),
	channel: z.string().describe("Channel filter; \"\" = any."),
	mode: z.string().describe("Transmission-mode filter; \"\" = any."),
	recipient_id: z.string().describe("Recipient id filter; \"\" = any."),
	message: z.string().describe("Message-text filter substring; \"\" = any."),
});

export const PagerDecoderDataSchema = z.looseObject({
	settings: z
		.looseObject({
			retentionLines: z.number().describe("How many decoded lines to keep on screen."),
			filter: pagerFilterSchema.describe("Column filters applied to the decoded stream."),
		})
		.partial()
		.optional()
		.describe("The Settings window's persisted preferences."),
});

export type PagerDecoderData = z.infer<typeof PagerDecoderDataSchema>;

registerApp({
	id: "PagerDecoder.app",
	description: "Decoded pager traffic from September 11, 2001, streaming to the virtual clock.",
	prefix: "ClassicyAppPagerDecoder",
	handler: classicyPagerDecoderEventHandler,
	actions: {
		ClassicyAppPagerDecoderInitSettings: {
			description: "Seed the settings object, only if none exists yet.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Initial PagerDecoderSettings object."),
			}),
		},
		ClassicyAppPagerDecoderUpdateSettings: {
			description: "Merge a partial settings object over the stored one.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Partial PagerDecoderSettings to merge."),
			}),
		},
	},
	state: PagerDecoderDataSchema,
});
