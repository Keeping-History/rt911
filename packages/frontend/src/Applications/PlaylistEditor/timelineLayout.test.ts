import { describe, expect, it } from "vitest";
import {
	dragEdgeIso,
	fractionToMs,
	FULL_BOUNDS,
	layoutBars,
	layoutFlags,
	MAX_ZOOM,
	MIN_ZOOM,
	normalizeZoom,
	rulerLabels,
	rulerTicks,
	steppedZoom,
	tickIntervalHours,
	timelineBounds,
	TIMELINE_END_MS,
	TIMELINE_START_MS,
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

describe("fractionToMs", () => {
	it("round-trips with timeToFraction on the full span", () => {
		for (const iso of [
			"2001-09-09T00:00:00.000Z",
			"2001-09-14T06:30:00.000Z",
			"2001-09-19T00:00:00.000Z",
		]) {
			const ms = new Date(iso).getTime();
			expect(fractionToMs(timeToFraction(iso))).toBeCloseTo(ms, -1);
		}
	});

	it("round-trips against rescaled bounds, not just the full span", () => {
		const b = timelineBounds("2001-09-11T12:00:00Z", "2001-09-11T14:00:00Z");
		const iso = "2001-09-11T13:15:00.000Z";
		const ms = new Date(iso).getTime();
		expect(fractionToMs(timeToFraction(iso, b), b)).toBeCloseTo(ms, -1);
	});

	it("maps the bounds edges to 0 and 1, inverse of timeToFraction", () => {
		expect(fractionToMs(0)).toBe(TIMELINE_START_MS);
		expect(fractionToMs(1)).toBe(TIMELINE_END_MS);
	});
});

describe("dragEdgeIso", () => {
	it("snaps a mid-track fraction to the minute", () => {
		expect(dragEdgeIso("end", 0.5)).toBe("2001-09-14T00:00:00.000Z");
	});

	it("clamps overshoot to the timeline bounds", () => {
		expect(dragEdgeIso("start", -0.3)).toBe(new Date(TIMELINE_START_MS).toISOString());
		expect(dragEdgeIso("end", 1.3)).toBe(new Date(TIMELINE_END_MS).toISOString());
	});

	it("holds an edge one minute short of the opposite bound, so a drag can never invert the window", () => {
		expect(dragEdgeIso("start", 1, FULL_BOUNDS, "2001-09-11T13:00:00Z")).toBe(
			"2001-09-11T12:59:00.000Z",
		);
		expect(dragEdgeIso("end", 0, FULL_BOUNDS, "2001-09-11T13:00:00Z")).toBe(
			"2001-09-11T13:01:00.000Z",
		);
	});

	it("maps fractions against a playlist-window's rescaled bounds", () => {
		const b = timelineBounds("2001-09-11T12:00:00Z", "2001-09-11T14:00:00Z");
		expect(dragEdgeIso("start", 0.5, b)).toBe("2001-09-11T13:00:00.000Z");
	});

	it("stands the timeline bound in for a missing opposite bound", () => {
		// An unbounded end reads as the track's end: dragging start all the way
		// right stops one minute short of 19 Sep, not at some undefined place.
		expect(dragEdgeIso("start", 1, FULL_BOUNDS, undefined)).toBe(
			new Date(TIMELINE_END_MS - 60_000).toISOString(),
		);
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

	it("coerces anything localStorage might hand back into a usable level", () => {
		// The persisted value survives reloads, hand edits, and older schemas, so
		// it can be any shape at all. A bad one must not reach `${zoom * 100}%`.
		expect(normalizeZoom(8)).toBe(8);
		expect(normalizeZoom(undefined)).toBe(MIN_ZOOM);
		expect(normalizeZoom(null)).toBe(MIN_ZOOM);
		expect(normalizeZoom("16")).toBe(MIN_ZOOM);
		expect(normalizeZoom(Number.NaN)).toBe(MIN_ZOOM);
		expect(normalizeZoom(Number.POSITIVE_INFINITY)).toBe(MIN_ZOOM);
		expect(normalizeZoom(0)).toBe(MIN_ZOOM);
		expect(normalizeZoom(-4)).toBe(MIN_ZOOM);
		// Out of range or off-ladder still lands somewhere sensible.
		expect(normalizeZoom(1024)).toBe(MAX_ZOOM);
		expect(normalizeZoom(5)).toBe(4);
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
		expect(labels[0]).toEqual({ leftPct: 0, text: "9/9" });
		expect(labels[2].leftPct).toBeCloseTo(20);
		expect(labels[10].text).toBe("9/19");
	});

	it("subdivides ticks and switches labels to clock times when zoomed in", () => {
		expect(rulerTicks(4).length).toBeGreaterThan(rulerTicks(1).length);

		const labels = rulerLabels(8);
		// Midnight keeps its date so a zoomed viewport is never ambiguous about
		// which day it is showing; the labels between read as clock times.
		expect(labels[0].text).toBe("9/9");
		const between = labels.slice(1, 12).map((l) => l.text);
		expect(between.some((t) => /^\d\d:\d\d$/.test(t))).toBe(true);
		expect(labels.every((l) => l.leftPct >= 0 && l.leftPct <= 100)).toBe(true);
	});
});

describe("timelineBounds", () => {
	it("defaults each missing bound to the full span's edge", () => {
		expect(timelineBounds(undefined, undefined)).toEqual(FULL_BOUNDS);
		expect(timelineBounds("2001-09-11T12:00:00Z", undefined)).toEqual({
			startMs: Date.UTC(2001, 8, 11, 12),
			endMs: TIMELINE_END_MS,
		});
	});
	it("rounds outward to whole hours so ruler ticks stay round", () => {
		const b = timelineBounds("2001-09-11T12:40:00Z", "2001-09-11T14:05:00Z");
		expect(b).toEqual({
			startMs: Date.UTC(2001, 8, 11, 12),
			endMs: Date.UTC(2001, 8, 11, 15),
		});
	});
	it("clamps to the ten-day span and falls back whole on a degenerate window", () => {
		expect(timelineBounds("1999-01-01T00:00:00Z", undefined).startMs).toBe(TIMELINE_START_MS);
		// Inverted (untrusted stored data): full span rather than a zero/negative span.
		expect(timelineBounds("2001-09-11T14:00:00Z", "2001-09-11T12:00:00Z")).toEqual(FULL_BOUNDS);
	});
});

describe("bounded ruler and layout", () => {
	// A two-hour class: 12:00–14:00 on the 11th.
	const b = timelineBounds("2001-09-11T12:00:00Z", "2001-09-11T14:00:00Z");

	it("timeToFraction maps the window edges to 0 and 1", () => {
		expect(timeToFraction("2001-09-11T12:00:00Z", b)).toBe(0);
		expect(timeToFraction("2001-09-11T13:00:00Z", b)).toBe(0.5);
		expect(timeToFraction("2001-09-11T14:00:00Z", b)).toBe(1);
		// Outside the window clamps to the edges, same as the full-span rule.
		expect(timeToFraction("2001-09-10T00:00:00Z", b)).toBe(0);
	});

	it("ticks rescale to the window and stay bounded in count", () => {
		const ticks = rulerTicks(1, b);
		// 2h span at 1×: the 0.25h ladder floor gives 8 end-exclusive ticks.
		expect(ticks).toHaveLength(8);
		expect(ticks[0]).toBe(0);
		expect(ticks[1]).toBeCloseTo(12.5);
		expect(ticks.every((t) => t >= 0 && t < 100)).toBe(true);
	});

	it("labels read as clock times and always close at the end bound", () => {
		const labels = rulerLabels(1, b);
		expect(labels[0].text).toBe("12:00");
		expect(labels[labels.length - 1]).toEqual({ leftPct: 100, text: "14:00" });
	});

	it("gives the closing bound its own label even when the interval does not divide the span", () => {
		// 25h span: 0.5h ticks at 1× → labels every 2h; 25 is not divisible by 2.
		const odd = timelineBounds("2001-09-11T12:00:00Z", "2001-09-12T13:00:00Z");
		const labels = rulerLabels(1, odd);
		expect(labels[labels.length - 1].leftPct).toBe(100);
		// No label past the end, and the second-to-last is strictly before it.
		expect(labels[labels.length - 2].leftPct).toBeLessThan(100);
	});

	it("layoutBars positions media windows as fractions of the bounds", () => {
		const bars = layoutBars(
			[{
				uid: "e1",
				entry: {
					kind: "media", app: "tv", itemId: "CNN",
					start: "2001-09-11T12:30:00Z", end: "2001-09-11T13:30:00Z",
				},
			}],
			b,
		);
		expect(bars[0].startFrac).toBe(0.25);
		expect(bars[0].endFrac).toBe(0.75);
	});
});
