import { describe, expect, it } from "vitest";
import {
	layoutBars,
	layoutFlags,
	MAX_ZOOM,
	MIN_ZOOM,
	rulerLabels,
	rulerTicks,
	steppedZoom,
	tickIntervalHours,
	timeToFraction,
} from "./timelineLayout";

const media = (uid: string, entry: object, timelineMeta?: object) =>
	({ uid, entry: { kind: "media", app: "tv", itemId: uid, ...entry }, timelineMeta }) as never;

describe("timeToFraction", () => {
	it("maps the window ends to 0 and 1 and clamps outside", () => {
		expect(timeToFraction("2001-09-09T00:00:00.000Z")).toBe(0);
		expect(timeToFraction("2001-09-19T00:00:00.000Z")).toBe(1);
		expect(timeToFraction("2001-08-01T00:00:00.000Z")).toBe(0);
		expect(timeToFraction("2001-09-14T00:00:00.000Z")).toBeCloseTo(0.5);
	});
});

describe("layoutBars", () => {
	it("renders unbounded edges as full-range fades", () => {
		const [bar] = layoutBars([media("e1", {})]);
		expect(bar).toMatchObject({ startFrac: 0, endFrac: 1, fadeStart: true, fadeEnd: true });
	});
	it("windows and flight actual spans map to fractions", () => {
		const [bar] = layoutBars([
			media("e2", { app: "flights", itemId: "AA11", start: "2001-09-11T00:00:00Z", end: "2001-09-12T00:00:00Z" },
				{ departure: "2001-09-11T11:59:00Z", arrival: null }),
		]);
		expect(bar.group).toBe("flights");
		expect(bar.startFrac).toBeCloseTo(2 / 10);
		expect(bar.endFrac).toBeCloseTo(3 / 10);
		expect(bar.actualStartFrac).toBeCloseTo((2 + 11.983 / 24) / 10, 3);
		expect(bar.actualEndFrac).toBeUndefined();
	});
	it("excludes news from bars", () => {
		expect(layoutBars([media("e3", { app: "news", itemId: "9" })])).toEqual([]);
	});
});

describe("layoutFlags", () => {
	it("plants news flags at publishedAt and staggers near-coincident flags", () => {
		const flags = layoutFlags([
			media("n1", { app: "news", itemId: "1" }, { publishedAt: "2001-09-11T12:00:00Z" }),
			media("n2", { app: "news", itemId: "2" }, { publishedAt: "2001-09-11T12:05:00Z" }),
			{ uid: "j1", entry: { kind: "jump", at: "2001-09-11T13:00:00Z", to: "2001-09-11T10:00:00Z" } } as never,
		]);
		expect(flags).toHaveLength(3);
		expect(flags[0].row).toBe(0);
		expect(flags[1].row).toBe(1);         // < minGap from n1 → bumped a row
		expect(flags.find((f) => f.uid === "j1")?.kindGlyph).toBe("jump");
	});
	it("omits point entries with an empty at", () => {
		expect(layoutFlags([{ uid: "j2", entry: { kind: "jump", at: "", to: "" } } as never])).toEqual([]);
	});
	it("plants at publishedAt (not start) when there is a bare start with no end", () => {
		const [flag] = layoutFlags([
			media(
				"n3",
				{ app: "news", itemId: "3", start: "2001-09-11T09:00:00Z" },
				{ publishedAt: "2001-09-11T12:00:00Z" },
			),
		]);
		expect(flag.atFrac).toBeCloseTo(timeToFraction("2001-09-11T12:00:00Z"));
		expect(flag.extentEndFrac).toBeUndefined();
	});
	it("plants at start (with extent to end) when an explicit start+end window exists, even with publishedAt", () => {
		const [flag] = layoutFlags([
			media(
				"n4",
				{ app: "news", itemId: "4", start: "2001-09-11T09:00:00Z", end: "2001-09-11T10:00:00Z" },
				{ publishedAt: "2001-09-11T12:00:00Z" },
			),
		]);
		expect(flag.atFrac).toBeCloseTo(timeToFraction("2001-09-11T09:00:00Z"));
		expect(flag.extentEndFrac).toBeCloseTo(timeToFraction("2001-09-11T10:00:00Z"));
	});
});

describe("zoom", () => {
	it("steps through the ladder and clamps at both ends instead of running off it", () => {
		expect(steppedZoom(1, 1)).toBe(2);
		expect(steppedZoom(8, 1)).toBe(16);
		expect(steppedZoom(8, -1)).toBe(4);
		expect(steppedZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
		expect(steppedZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
	});

	it("snaps an off-ladder zoom to the nearest level rather than refusing to move", () => {
		expect(steppedZoom(5, 1)).toBe(4);
	});

	it("keeps on-screen tick density roughly constant as zoom grows", () => {
		// Ticks per viewport = (240 / interval) / zoom. It should stay in the same
		// ballpark rather than collapsing to a handful or exploding.
		for (const zoom of [1, 2, 4, 8, 16, 32, 64]) {
			const perViewport = 240 / tickIntervalHours(zoom) / zoom;
			expect(perViewport).toBeGreaterThanOrEqual(15);
			expect(perViewport).toBeLessThanOrEqual(60);
		}
	});

	it("floors the tick interval so deep zoom cannot emit unbounded DOM nodes", () => {
		// The whole span is always rendered, so the total tick count — not the
		// visible count — is what has to stay bounded.
		expect(rulerTicks(MAX_ZOOM).length).toBeLessThanOrEqual(960);
		expect(tickIntervalHours(MAX_ZOOM)).toBe(tickIntervalHours(MAX_ZOOM * 4));
	});

	it("reproduces the original ruler exactly at 1x", () => {
		const ticks = rulerTicks(1);
		expect(ticks).toHaveLength(40);
		expect(ticks[1]).toBeCloseTo(2.5);

		const labels = rulerLabels(1);
		expect(labels).toHaveLength(11);
		expect(labels[0]).toEqual({ leftPct: 0, text: "09-09" });
		expect(labels[2].leftPct).toBeCloseTo(20);
		expect(labels[10].text).toBe("09-19");
	});

	it("subdivides ticks and switches labels to clock times when zoomed in", () => {
		expect(rulerTicks(4).length).toBeGreaterThan(rulerTicks(1).length);

		const labels = rulerLabels(8);
		// Midnight keeps its date so a zoomed viewport is never ambiguous about
		// which day it is showing; the labels between read as clock times.
		expect(labels[0].text).toBe("09-09");
		const between = labels.slice(1, 12).map((l) => l.text);
		expect(between.some((t) => /^\d\d:\d\d$/.test(t))).toBe(true);
		expect(labels.every((l) => l.leftPct >= 0 && l.leftPct <= 100)).toBe(true);
	});
});
