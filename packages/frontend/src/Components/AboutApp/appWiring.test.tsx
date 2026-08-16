import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVENANCE_APP_IDS } from "../../data/provenance";

const APP_FILES: Record<string, string> = {
	"PagerDecoder.app": "PagerDecoder/PagerDecoder.tsx",
	"Browser.app": "Browser/Browser.tsx",
	"FlightTracker.app": "FlightTracker/FlightTracker.tsx",
	"MarketWatch.app": "MarketWatch/MarketWatch.tsx",
	"News.app": "News/News.tsx",
	"Newsgroups.app": "Newsgroups/Newsgroups.tsx",
	"RadioScanner.app": "RadioScanner/RadioScanner.tsx",
	"RadioTuner.app": "RadioTuner/RadioTuner.tsx",
	"TV.app": "TV/TV.tsx",
	"Weather.app": "Weather/Weather.tsx",
};

const read = (rel: string) =>
	readFileSync(join(__dirname, "../../Applications", rel), "utf8");

describe("About wiring", () => {
	it("has a file mapped for every app in the registry", () => {
		expect(Object.keys(APP_FILES).sort()).toEqual([...PROVENANCE_APP_IDS].sort());
	});

	it.each(Object.entries(APP_FILES))("%s calls useAboutApp", (_id, rel) => {
		expect(read(rel)).toMatch(/useAboutApp\(/);
	});

	it.each(Object.entries(APP_FILES))("%s renders the window", (_id, rel) => {
		expect(read(rel)).toMatch(/\{aboutWindow\}/);
	});
});
