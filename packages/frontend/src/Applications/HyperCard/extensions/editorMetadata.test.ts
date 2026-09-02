import { describe, expect, it } from "vitest";
import {
	getHyperCardCommandEditorMeta,
	getHyperCardPartEditorMeta,
	getHyperCardOptionPicker,
} from "classicy";
import { registerHyperCardEditorMetadata } from "./editorMetadata";

describe("registerHyperCardEditorMetadata", () => {
	it("registers editor metadata for all seven directus parts", () => {
		registerHyperCardEditorMetadata();
		for (const type of [
			"directusAudio",
			"directusVideo",
			"directusMultiview",
			"directusNews",
			"directusPager",
			"directusWeatherStation",
			"directusFlightMap",
		]) {
			const meta = getHyperCardPartEditorMeta(type);
			expect(meta, type).toBeDefined();
			expect(meta?.label.length, type).toBeGreaterThan(0);
			expect(meta?.defaultSize?.[0], type).toBeGreaterThan(0);
			expect(meta?.optionsSchema?.length, type).toBeGreaterThan(0);
		}
	});

	it("schema keys match what the part components read", () => {
		registerHyperCardEditorMetadata();
		const keys = (type: string) =>
			getHyperCardPartEditorMeta(type)?.optionsSchema?.map((f) => f.key);
		expect(keys("directusVideo")).toEqual([
			"channelId", "url", "start", "end", "autoPlay", "controls", "loop", "captions", "overlay",
		]);
		expect(keys("directusNews")).toEqual(["itemId", "showImage", "showDate"]);
		expect(keys("directusFlightMap")).toContain("trailMultiplier");
	});

	it("registers the setDateTime command builder fields", () => {
		registerHyperCardEditorMetadata();
		const meta = getHyperCardCommandEditorMeta("setDateTime");
		expect(meta?.fields.map((f) => f.key)).toEqual(["to", "toVar"]);
	});

	it("registers the Radio Traffic clip picker for directusAudio's itemId field", () => {
		registerHyperCardEditorMetadata();
		const field = getHyperCardPartEditorMeta("directusAudio")?.optionsSchema?.find(
			(f) => f.key === "itemId",
		);
		expect(field?.kind).toBe("picker");
		expect(field?.pickerId).toBe("radioTrafficClip");
		expect(getHyperCardOptionPicker("radioTrafficClip")).toBeDefined();
	});

	// Issue #560 — every id/array field that used to be a bare num/text/json
	// input now opens a picker instead, one per Directus-backed embed type.
	it.each([
		["directusVideo", "channelId", "tvClip"],
		["directusMultiview", "videos", "tvMultiviewVideos"],
		["directusNews", "itemId", "newsItem"],
		["directusPager", "itemId", "pagerMessage"],
		["directusWeatherStation", "station", "weatherStation"],
		["directusFlightMap", "flight", "flightMap"],
	])("registers a picker for %s's %s field", (type, key, pickerId) => {
		registerHyperCardEditorMetadata();
		const field = getHyperCardPartEditorMeta(type)?.optionsSchema?.find((f) => f.key === key);
		expect(field?.kind).toBe("picker");
		expect(field?.pickerId).toBe(pickerId);
		expect(getHyperCardOptionPicker(pickerId)).toBeDefined();
	});
});
