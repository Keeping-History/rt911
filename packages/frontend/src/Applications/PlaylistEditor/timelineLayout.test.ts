import { describe, expect, it } from "vitest";
import { layoutBars, layoutFlags, timeToFraction } from "./timelineLayout";

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
});
