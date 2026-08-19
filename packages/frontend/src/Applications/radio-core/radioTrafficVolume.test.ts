import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__clearRadioTrafficVolumeCache,
	buildRadioTrafficVolume,
} from "./radioTrafficVolume";

const rows = [
	{
		id: 501, title: "AAL11 loses contact", full_title: "American 11 loses contact with ATC",
		source: "ZBW", tags: [
			{ mp3_tags_id: { tag: "aircraft:aal11", namespace: "aircraft", value: "aal11" } },
			{ mp3_tags_id: { tag: "topic:loss-of-contact", namespace: "topic", value: "loss-of-contact" } },
		],
	},
	{
		id: 502, title: "Ground stop issued", full_title: "FAA ground stop, NY Center",
		source: "ZNY", tags: [
			{ mp3_tags_id: { tag: "topic:ground-stop", namespace: "topic", value: "ground-stop" } },
		],
	},
	{
		// A broadcast station's own item — must never appear in the tree.
		id: 900, title: "WCBS hourly news", full_title: "WCBS hourly news",
		source: "WCBS", tags: [
			{ mp3_tags_id: { tag: "topic:news", namespace: "topic", value: "news" } },
		],
	},
];

let calls = 0;
const fetchFn = vi.fn(async (url: string) => {
	calls += 1;
	if (!url.includes("/items/mp3_items")) throw new Error(`unexpected url ${url}`);
	return new Response(JSON.stringify({ data: rows }));
});

beforeEach(() => {
	__clearRadioTrafficVolumeCache();
	calls = 0;
});
afterEach(() => vi.clearAllMocks());

describe("buildRadioTrafficVolume", () => {
	it("lists namespace folders at the root", async () => {
		const entries = await buildRadioTrafficVolume(fetchFn as unknown as typeof fetch).list([]);
		expect(entries.map((e) => e.name)).toEqual(["Aircraft", "Topic"]);
		expect(entries.every((e) => e.kind === "folder")).toBe(true);
	});

	it("lists tag values within a namespace", async () => {
		const volume = buildRadioTrafficVolume(fetchFn as unknown as typeof fetch);
		const values = await volume.list(["Topic"]);
		expect(values.map((e) => e.name)).toEqual(["loss-of-contact", "ground-stop"]);
	});

	it("lists clips carrying a specific tag value, excluding broadcast-station items", async () => {
		const volume = buildRadioTrafficVolume(fetchFn as unknown as typeof fetch);
		const clips = await volume.list(["Topic", "news"]);
		expect(clips).toEqual([]); // the only "topic:news" item (id 900) is WCBS, a broadcast station
	});

	it("puts a clip under every namespace it's tagged in", async () => {
		const volume = buildRadioTrafficVolume(fetchFn as unknown as typeof fetch);
		const aircraft = await volume.list(["Aircraft", "aal11"]);
		const topic = await volume.list(["Topic", "loss-of-contact"]);
		expect(aircraft).toEqual([
			{ id: "radio-traffic-501", name: "American 11 loses contact with ATC", kind: "file", fileType: "radio-traffic", meta: { app: "radio", itemId: 501 } },
		]);
		expect(topic).toEqual([
			{ id: "radio-traffic-501", name: "American 11 loses contact with ATC", kind: "file", fileType: "radio-traffic", meta: { app: "radio", itemId: 501 } },
		]);
	});

	it("fetches once and caches across repeated list() calls, even across separate buildRadioTrafficVolume() calls", async () => {
		await buildRadioTrafficVolume(fetchFn as unknown as typeof fetch).list([]);
		await buildRadioTrafficVolume(fetchFn as unknown as typeof fetch).list(["Topic"]);
		await buildRadioTrafficVolume(fetchFn as unknown as typeof fetch).list(["Aircraft", "aal11"]);
		expect(calls).toBe(1);
	});
});
