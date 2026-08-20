import type { ActionMessage } from "classicy";

// Reader preferences for the README app. Ephemeral UI (the open settings window,
// the draft form) is NOT persisted; only the tag filter is — same split as
// radioScannerSettings.ts.
export interface ReadmeSettings {
	/** Tag ids the reader has unchecked (hidden). Empty = show everything. */
	hiddenTagIds: number[];
}

export const DEFAULT_README_SETTINGS: ReadmeSettings = { hiddenTagIds: [] };

/** Persist the whole settings object in one dispatch. */
export const readmeSetSettings = (settings: ReadmeSettings): ActionMessage => ({
	type: "ClassicyAppReadmeSetSettings",
	settings,
});

const isTagIdArray = (v: unknown): v is number[] =>
	Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n));

// Stored state comes from localStorage, so a hand-edited or stale value could be
// anything; fall back to defaults on any invalid field.
export const readReadmeSettings = (
	data: Record<string, unknown> | undefined,
): ReadmeSettings => {
	const stored = (data?.settings as Partial<ReadmeSettings> | undefined) ?? {};
	return {
		hiddenTagIds: isTagIdArray(stored.hiddenTagIds)
			? stored.hiddenTagIds
			: DEFAULT_README_SETTINGS.hiddenTagIds,
	};
};
