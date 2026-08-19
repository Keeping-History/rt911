import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__clearDirectusVolumeCache,
	createDirectusVolume,
	MEDIA_FILE_TYPES,
} from "./directusVolume";

vi.mock("../radio-core/radioTrafficVolume", () => ({
	buildRadioTrafficVolume: () => ({
		id: "radio-traffic-tags", label: "Radio Traffic",
		list: async (path: string[]) =>
			path.length === 0
				? [{ id: "ns-topic", name: "Topic", kind: "folder" as const }]
				: [{
						id: "radio-traffic-501", name: "American 11 loses contact",
						kind: "file" as const, fileType: "radio-traffic",
						meta: { app: "radio", itemId: 501 },
					}],
	}),
}));

const sourcesRows = [
	{ id: 7, slug: "nyt", name: "New York Times" },
	{ id: 9, slug: "wapo", name: "Washington Post" },
];
const groupRows = [{ source: 7 }, { source: 9 }];
const newsRows = [
	{ id: 101, title: "Morning Edition", start_date: "2001-09-11T10:00:00Z" },
];
const flightRow = (flight: string) => ({
	flight, origin: "BOS", scheduled_dest: "LAX",
	wheels_off_utc: "2001-09-11T11:59:00.000Z", wheels_on_utc: null,
});

function fetchFor(url: string): unknown[] {
	if (url.includes("/items/sources")) return sourcesRows;
	if (url.includes("groupBy=source")) return groupRows;
	if (url.includes("/items/news_items")) return newsRows;
	if (url.includes("/items/flight_tracks")) {
		const byCallsign = /filter\[flight\]\[_eq\]=([^&]+)/.exec(url);
		if (byCallsign) return [flightRow(byCallsign[1])];
		return [flightRow("AA11")];
	}
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
		radioSlugs: () => ["WINS", "FDNY-Manhattan"],
		fetchFn: fetchFn as unknown as typeof fetch,
	});

beforeEach(() => {
	__clearDirectusVolumeCache();
	maxInFlight = 0;
});
afterEach(() => vi.clearAllMocks());

describe("createDirectusVolume", () => {
	it("lists the five top folders without fetching", async () => {
		const entries = await volume().list([]);
		expect(entries.map((e: typeof entries[number]) => e.name)).toEqual([
			"TV Channels", "Radio Stations", "Radio Traffic", "News", "Flights",
		]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("splits radio slugs into broadcast stations and traffic by BROADCAST_STATIONS", async () => {
		const stations = await volume().list(["Radio Stations"]);
		expect(stations.map((e: typeof stations[number]) => e.name)).toEqual([
			"Select All", "WINS",
		]);
		expect(stations[1]).toMatchObject({
			fileType: MEDIA_FILE_TYPES.radio, meta: { app: "radio", itemId: "WINS" },
		});
	});

	it("delegates the Radio Traffic folder to buildRadioTrafficVolume, one path segment in", async () => {
		const root = await volume().list(["Radio Traffic"]);
		expect(root).toEqual([{ id: "ns-topic", name: "Topic", kind: "folder" }]);
		const clips = await volume().list(["Radio Traffic", "Topic", "loss-of-contact"]);
		expect(clips).toEqual([{
			id: "radio-traffic-501", name: "American 11 loses contact",
			kind: "file", fileType: "radio-traffic", meta: { app: "radio", itemId: 501 },
		}]);
	});

	it("lists TV channels from the injected slugs with playlist meta", async () => {
		const entries = await volume().list(["TV Channels"]);
		expect(entries[0]).toMatchObject({
			name: "Select All", kind: "file", fileType: MEDIA_FILE_TYPES.tv,
			meta: { selectAllPaths: [["TV Channels"]] },
		});
		expect(entries[1]).toMatchObject({
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
			name: "Select All", fileType: MEDIA_FILE_TYPES.news,
			meta: { selectAllPaths: [["News", "New York Times"]] },
		});
		expect(entries[1]).toMatchObject({
			name: "Morning Edition", fileType: MEDIA_FILE_TYPES.news,
			meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" },
		});
	});

	it("lists notable flights with departure/arrival meta, including observer and presidential aircraft", async () => {
		const entries = await volume().list(["Flights", "Notable Flights"]);
		expect(entries[0]).toMatchObject({
			name: "Select All", fileType: MEDIA_FILE_TYPES.flight,
			meta: { selectAllPaths: [["Flights", "Notable Flights"]] },
		});
		expect(entries[1]).toMatchObject({
			fileType: MEDIA_FILE_TYPES.flight,
			meta: { app: "flights", itemId: "AA11", departure: "2001-09-11T11:59:00.000Z", arrival: null },
		});
		const names = entries.map((e: typeof entries[number]) => e.meta?.itemId);
		expect(names).toContain("GOFER06");
		expect(names).toContain("AF1");
	});

	it("lists airline → dates → flights with Select All at each level", async () => {
		const vol = volume();
		const airlines = await vol.list(["Flights"]);
		expect(airlines[0].name).toBe("Notable Flights");
		expect(airlines.find((e: typeof airlines[number]) => e.name === "American Airlines")).toBeTruthy();
		const dates = await vol.list(["Flights", "American Airlines"]);
		expect(dates[0]).toMatchObject({
			name: "All American Airlines Flights", kind: "file",
			fileType: MEDIA_FILE_TYPES.flight,
		});
		expect((dates[0].meta?.selectAllPaths as string[][]).length).toBe(10);
		expect((dates[0].meta?.selectAllPaths as string[][])[2]).toEqual(
			["Flights", "American Airlines", "2001-09-11"],
		);
		expect(dates.map((d: typeof dates[number]) => d.name)).toContain("2001-09-11");
		const flights = await vol.list(["Flights", "American Airlines", "2001-09-11"]);
		expect(flights[0]).toMatchObject({
			name: "Select All",
			meta: { selectAllPaths: [["Flights", "American Airlines", "2001-09-11"]] },
		});
		expect(flights[1].name).toBe("AA11 — BOS→LAX");
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
