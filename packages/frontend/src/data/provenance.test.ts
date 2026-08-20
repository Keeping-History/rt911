import { describe, expect, it } from "vitest";
import { APP_PROVENANCE, PROVENANCE_APP_IDS } from "./provenance";

const EXPECTED_IDS = [
	"Browser.app",
	"FlightTracker.app",
	"MarketWatch.app",
	"News.app",
	"Newsgroups.app",
	"PagerDecoder.app",
	"RadioTraffic.app",
	"RadioTuner.app",
	"TV.app",
	"Weather.app",
];

const PLACEHOLDER = /\b(TBD|TODO|FIXME|XXX)\b/;

describe("APP_PROVENANCE", () => {
	it("covers exactly the ten in-scope apps", () => {
		expect([...PROVENANCE_APP_IDS].sort()).toEqual(EXPECTED_IDS);
		expect(Object.keys(APP_PROVENANCE).sort()).toEqual(EXPECTED_IDS);
	});

	it.each(EXPECTED_IDS)("%s has a name, blurb and at least one source", (id) => {
		const entry = APP_PROVENANCE[id];
		expect(entry.appName.trim().length).toBeGreaterThan(0);
		expect(entry.blurb.trim().length).toBeGreaterThan(0);
		expect(entry.sources.length).toBeGreaterThan(0);
	});

	it.each(EXPECTED_IDS)("%s sources are complete and https", (id) => {
		for (const s of APP_PROVENANCE[id].sources) {
			expect(s.name.trim().length).toBeGreaterThan(0);
			expect(s.feeds.trim().length).toBeGreaterThan(0);
			expect(new URL(s.url).protocol).toBe("https:");
		}
	});

	// A half-filled entry must be a red test, not a blank section shipped to users.
	it("contains no placeholder markers", () => {
		expect(PLACEHOLDER.test(JSON.stringify(APP_PROVENANCE))).toBe(false);
	});

	it("contains no empty strings", () => {
		const empties: string[] = [];
		const walk = (v: unknown, path: string) => {
			if (typeof v === "string") {
				if (v.trim() === "") empties.push(path);
			} else if (Array.isArray(v)) {
				v.forEach((x, i) => walk(x, `${path}[${i}]`));
			} else if (v && typeof v === "object") {
				for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
			}
		};
		walk(APP_PROVENANCE, "APP_PROVENANCE");
		expect(empties).toEqual([]);
	});

	it("discloses derivation for the reconstructed apps", () => {
		for (const id of [
			"FlightTracker.app",
			"MarketWatch.app",
			"News.app",
			"TV.app",
			"RadioTraffic.app",
			"RadioTuner.app",
			"Browser.app",
		]) {
			expect(APP_PROVENANCE[id].method?.length ?? 0).toBeGreaterThan(0);
		}
	});
});
