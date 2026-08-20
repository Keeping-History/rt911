import { describe, expect, it } from "vitest";
import {
	DEFAULT_README_SETTINGS,
	readmeSetSettings,
	readReadmeSettings,
} from "./readmeSettings";

describe("readReadmeSettings", () => {
	it("falls back to defaults for absent data", () => {
		expect(readReadmeSettings(undefined)).toEqual(DEFAULT_README_SETTINGS);
		expect(readReadmeSettings({})).toEqual({ hiddenTagIds: [] });
	});

	it("reads a valid hiddenTagIds array", () => {
		expect(readReadmeSettings({ settings: { hiddenTagIds: [1, 2] } })).toEqual({
			hiddenTagIds: [1, 2],
		});
	});

	it("rejects a non-array or non-integer hiddenTagIds", () => {
		expect(readReadmeSettings({ settings: { hiddenTagIds: "x" } })).toEqual({ hiddenTagIds: [] });
		expect(readReadmeSettings({ settings: { hiddenTagIds: [1, "2", 3.5] } })).toEqual({ hiddenTagIds: [] });
	});
});

describe("readmeSetSettings", () => {
	it("builds the persist action", () => {
		expect(readmeSetSettings({ hiddenTagIds: [7] })).toEqual({
			type: "ClassicyAppReadmeSetSettings",
			settings: { hiddenTagIds: [7] },
		});
	});
});
