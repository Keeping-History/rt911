import { describe, expect, it } from "vitest";
import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";
import { airportCoords, haversineNm } from "./airports";
import {
	formatCoords,
	formatDurationMs,
	groundspeedKts,
	legEstimates,
} from "./flightEta";

const pos = (over: Partial<FlightPosition>): FlightPosition => ({
	id: 1, flight: "AA11", start_date: "2001-09-11T12:30:00Z",
	lat: 40, lon: -74, alt_ft: 29_000, ...over,
});

describe("groundspeedKts", () => {
	it("derives knots from two minute-bucket samples", () => {
		// 0.1° of longitude at 40°N ≈ 4.6 nm in one minute ≈ ~276 kts.
		const prev = pos({ start_date: "2001-09-11T12:29:00Z", lon: -74.1 });
		const cur = pos({ start_date: "2001-09-11T12:30:00Z", lon: -74.0 });
		const kts = groundspeedKts(prev, cur)!;
		expect(kts).toBeGreaterThan(250);
		expect(kts).toBeLessThan(300);
	});

	it("returns null without a prev sample, for tiny gaps, and when stationary", () => {
		const cur = pos({});
		expect(groundspeedKts(null, cur)).toBeNull();
		expect(groundspeedKts(pos({ start_date: "2001-09-11T12:29:50Z", lon: -74.1 }), cur)).toBeNull();
		expect(groundspeedKts(pos({ start_date: "2001-09-11T12:29:00Z" }), cur)).toBeNull();
	});
});

describe("formatCoords", () => {
	it("renders hemisphere letters", () => {
		expect(formatCoords(40.7128, -74.006)).toBe("40.71° N, 74.01° W");
		expect(formatCoords(-33.9, 151.2)).toBe("33.90° S, 151.20° E");
	});
});

describe("formatDurationMs", () => {
	it("renders minutes and hour+minute forms, rounding up sub-minute", () => {
		expect(formatDurationMs(12 * 60_000)).toBe("12 m");
		expect(formatDurationMs(83 * 60_000)).toBe("1 h 23 m");
		expect(formatDurationMs(20_000)).toBe("1 m");
	});
});

describe("legEstimates", () => {
	const NOW = Date.parse("2001-09-11T12:30:00Z");
	// A fix roughly over upstate NY on the BOS→LAX great circle.
	const live = pos({ lat: 42.6, lon: -74.6 });
	const prevMin = pos({ start_date: "2001-09-11T12:29:00Z", lat: 42.62, lon: -74.48 });

	it("computes from-origin elapsed/distance and to-dest distance/eta", () => {
		const est = legEstimates({
			live, prev: prevMin, origin: "BOS", dest: "LAX",
			wheelsOffUtc: "2001-09-11T11:59:00Z", wheelsOnUtc: null, nowMs: NOW,
		});
		expect(est.fromOrigin).not.toBeNull();
		expect(est.fromOrigin!.elapsedMs).toBe(31 * 60_000);
		expect(est.fromOrigin!.distanceNm).toBeCloseTo(
			haversineNm(airportCoords("BOS")!, [-74.6, 42.6]), 5,
		);
		expect(est.toDest).not.toBeNull();
		expect(est.toDest!.distanceNm).toBeGreaterThan(1900);
		expect(est.toDest!.etaMs).not.toBeNull();
		// ~2000 nm at ~300 kts → several hours, sanity-bounded.
		expect(est.toDest!.etaMs!).toBeGreaterThan(3 * 3_600_000);
	});

	it("suppresses to-dest once landed and eta without a usable speed", () => {
		const landed = legEstimates({
			live, prev: prevMin, origin: "BOS", dest: "LAX",
			wheelsOffUtc: "2001-09-11T11:59:00Z",
			wheelsOnUtc: "2001-09-11T12:20:00Z", nowMs: NOW,
		});
		expect(landed.toDest).toBeNull();

		const noSpeed = legEstimates({
			live, prev: null, origin: "BOS", dest: "LAX",
			wheelsOffUtc: "2001-09-11T11:59:00Z", wheelsOnUtc: null, nowMs: NOW,
		});
		expect(noSpeed.toDest!.etaMs).toBeNull();
		expect(noSpeed.toDest!.distanceNm).toBeGreaterThan(0);
	});

	it("needs origin coords and a past wheels-off for the from-origin line", () => {
		const unknownAirport = legEstimates({
			live, prev: prevMin, origin: "ZZZ", dest: null,
			wheelsOffUtc: "2001-09-11T11:59:00Z", wheelsOnUtc: null, nowMs: NOW,
		});
		expect(unknownAirport.fromOrigin).toBeNull();
		const preDeparture = legEstimates({
			live, prev: prevMin, origin: "BOS", dest: null,
			wheelsOffUtc: "2001-09-11T13:00:00Z", wheelsOnUtc: null, nowMs: NOW,
		});
		expect(preDeparture.fromOrigin).toBeNull();
	});
});
