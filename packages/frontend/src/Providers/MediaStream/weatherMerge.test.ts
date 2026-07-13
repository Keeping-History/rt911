import { describe, expect, it } from "vitest";
import type { WeatherObservation } from "./MediaStreamContext";
import { mergeLatestPerStation } from "./weatherMerge";

const obs = (
	station_id: string,
	start_date: string,
	overrides: Partial<WeatherObservation> = {},
): WeatherObservation => ({
	id: overrides.id ?? 1,
	station_id,
	start_date,
	...overrides,
});

describe("mergeLatestPerStation", () => {
	it("keeps the incoming observation when it is newer than the current one", () => {
		const current = { KLGA: obs("KLGA", "2001-09-11T08:00:00Z", { id: 1, temp_c: 20 }) };
		const incoming = [obs("KLGA", "2001-09-11T09:00:00Z", { id: 2, temp_c: 22 })];
		const next = mergeLatestPerStation(current, incoming);
		expect(next.KLGA).toEqual(incoming[0]);
	});

	it("ignores an incoming observation older than the current one", () => {
		const current = { KLGA: obs("KLGA", "2001-09-11T09:00:00Z", { id: 2, temp_c: 22 }) };
		const incoming = [obs("KLGA", "2001-09-11T08:00:00Z", { id: 1, temp_c: 20 })];
		const next = mergeLatestPerStation(current, incoming);
		expect(next.KLGA).toEqual(current.KLGA);
	});

	it("lets the incoming observation win on a tie", () => {
		const current = { KLGA: obs("KLGA", "2001-09-11T08:51:00Z", { id: 1, temp_c: 20 }) };
		const incoming = [obs("KLGA", "2001-09-11T08:51:00Z", { id: 2, temp_c: 21 })];
		const next = mergeLatestPerStation(current, incoming);
		expect(next.KLGA).toEqual(incoming[0]);
	});

	it("returns the same reference when nothing changes (render-thrash guard)", () => {
		const current = { KLGA: obs("KLGA", "2001-09-11T09:00:00Z", { id: 2, temp_c: 22 }) };
		const incoming = [obs("KLGA", "2001-09-11T08:00:00Z", { id: 1, temp_c: 20 })];
		const next = mergeLatestPerStation(current, incoming);
		expect(next).toBe(current);
	});

	it("merges a multi-station batch independently per station", () => {
		const current = {
			KLGA: obs("KLGA", "2001-09-11T08:00:00Z", { id: 1, temp_c: 20 }),
			KJFK: obs("KJFK", "2001-09-11T08:30:00Z", { id: 3, temp_c: 21 }),
		};
		const incoming = [
			obs("KLGA", "2001-09-11T09:00:00Z", { id: 2, temp_c: 22 }), // newer → wins
			obs("KJFK", "2001-09-11T08:00:00Z", { id: 4, temp_c: 19 }), // older → ignored
			obs("KEWR", "2001-09-11T08:15:00Z", { id: 5, temp_c: 18 }), // new station
		];
		const next = mergeLatestPerStation(current, incoming);
		expect(next.KLGA.id).toBe(2);
		expect(next.KJFK).toEqual(current.KJFK);
		expect(next.KEWR.id).toBe(5);
	});
});
