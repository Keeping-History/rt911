import { describe, expect, it } from "vitest";
import {
	getHyperCardCommandEditorMeta,
	getHyperCardPartEditorMeta,
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
		expect(
			getHyperCardPartEditorMeta("directusMultiview")?.optionsSchema?.find(
				(f) => f.key === "videos",
			)?.kind,
		).toBe("json");
	});

	it("registers the setDateTime command builder fields", () => {
		registerHyperCardEditorMetadata();
		const meta = getHyperCardCommandEditorMeta("setDateTime");
		expect(meta?.fields.map((f) => f.key)).toEqual(["to", "toVar"]);
	});
});
