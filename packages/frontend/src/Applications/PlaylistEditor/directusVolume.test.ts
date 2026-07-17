import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__clearDirectusVolumeCache,
	createDirectusVolume,
	MEDIA_FILE_TYPES,
} from "./directusVolume";

const sourcesRows = [
	{ id: 7, slug: "nyt", name: "New York Times" },
	{ id: 9, slug: "wapo", name: "Washington Post" },
];
const groupRows = [{ source: 7 }, { source: 9 }];
const newsRows = [
	{ id: 101, title: "Morning Edition", start_date: "2001-09-11T10:00:00Z" },
];
const flightRows = [
	{ flight: "AA11", origin: "BOS", scheduled_dest: "LAX", wheels_off_utc: "2001-09-11T11:59:00.000Z", wheels_on_utc: null },
];

function fetchFor(url: string): unknown[] {
	if (url.includes("/items/sources")) return sourcesRows;
	if (url.includes("groupBy=source")) return groupRows;
	if (url.includes("/items/news_items")) return newsRows;
	if (url.includes("/items/flight_tracks")) return flightRows;
	throw new Error(`unexpected url ${url}`);
}

let inFlight = 0;
let maxInFlight = 0;
const fetchFn = vi.fn(async (url: string) => {
	inFlight += 1;
	maxInFlight = Math.max(maxInFlight, inFlight);
	await new Promise((r) => setTimeout(r, 2));
	inFlight -= 1;
	return new Response(JSON.stringify({ data: fetchFor(url) }));
});

const volume = () =>
	createDirectusVolume({
		tvSlugs: () => ["ABC", "CNN"],
		radioSlugs: () => ["FDNY-Manhattan"],
		fetchFn: fetchFn as unknown as typeof fetch,
	});

beforeEach(() => {
	__clearDirectusVolumeCache();
	maxInFlight = 0;
});
afterEach(() => vi.clearAllMocks());

describe("createDirectusVolume", () => {
	it("lists the four top folders without fetching", async () => {
		const entries = await volume().list([]);
		expect(entries.map((e: typeof entries[number]) => e.name)).toEqual(["TV Channels", "Radio Stations", "News", "Flights"]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("lists TV channels from the injected slugs with playlist meta", async () => {
		const entries = await volume().list(["TV Channels"]);
		expect(entries[0]).toMatchObject({
			name: "ABC", kind: "file", fileType: MEDIA_FILE_TYPES.tv,
			meta: { app: "tv", itemId: "ABC" },
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("lists News publications from sources + groupBy", async () => {
		const entries = await volume().list(["News"]);
		expect(entries.map((e: typeof entries[number]) => e.name)).toEqual(["New York Times", "Washington Post"]);
		expect(entries[0].kind).toBe("folder");
	});

	it("lists a publication's documents with publishedAt meta", async () => {
		const vol = volume();
		await vol.list(["News"]);
		const entries = await vol.list(["News", "New York Times"]);
		expect(entries[0]).toMatchObject({
			name: "Morning Edition", fileType: MEDIA_FILE_TYPES.news,
			meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" },
		});
	});

	it("lists notable flights with departure/arrival meta", async () => {
		const entries = await volume().list(["Flights", "Notable Flights"]);
		expect(entries[0]).toMatchObject({
			fileType: MEDIA_FILE_TYPES.flight,
			meta: { app: "flights", itemId: "AA11", departure: "2001-09-11T11:59:00.000Z", arrival: null },
		});
	});

	it("lists airline → dates → flights", async () => {
		const vol = volume();
		const airlines = await vol.list(["Flights"]);
		expect(airlines[0].name).toBe("Notable Flights");
		expect(airlines.find((e: typeof airlines[number]) => e.name === "American Airlines")).toBeTruthy();
		const dates = await vol.list(["Flights", "American Airlines"]);
		expect(dates.map((d: typeof dates[number]) => d.name)).toContain("2001-09-11");
		const flights = await vol.list(["Flights", "American Airlines", "2001-09-11"]);
		expect(flights[0].name).toBe("AA11 — BOS→LAX");
	});

	it("never overlaps fetches and caches per-folder results", async () => {
		const vol = volume();
		await Promise.all([vol.list(["News"]), vol.list(["Flights", "Notable Flights"])]);
		expect(maxInFlight).toBe(1);
		const calls = fetchFn.mock.calls.length;
		await vol.list(["News"]);
		expect(fetchFn.mock.calls.length).toBe(calls); // cache hit
	});
});
