import { describe, expect, it } from "vitest";
import { ALLOW_ALL, collectCrossings, evaluate, initialFocusEvents } from "./playlistEngine";
import { playlistUtcMs, type PlaylistDefinition } from "./playlistTypes";

const T = (s: string) => playlistUtcMs(`2001-09-11T${s}`);

const def: PlaylistDefinition = {
	version: 1,
	mode: "restrict",
	entries: [
		{
			kind: "media",
			app: "tv",
			itemId: "CNN",
			start: "2001-09-11T12:46:00",
			end: "2001-09-11T13:30:00",
			focus: "locked",
		},
		{ kind: "media", app: "tv", itemId: "ABC" }, // unbounded window, no focus
		{ kind: "media", app: "radio", itemId: "wnyc", focus: "once" }, // no start: initial-focus only
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true }, locked: true },
		{ kind: "file", path: "Documents:Newspapers:x.pdf", at: "2001-09-11T13:00:00" },
		{ kind: "jump", at: "2001-09-11T13:03:00", to: "2001-09-11T13:59:00" },
		{ kind: "browser", url: "https://a.example/", at: "2001-09-11T12:50:00", closeAt: "2001-09-11T12:55:00" },
		{ kind: "browser", url: "https://b.example/", at: "2001-09-11T12:52:00" },
	],
};

describe("evaluate", () => {
	it("null definition allows everything", () => {
		expect(evaluate(null, T("12:00:00"))).toBe(ALLOW_ALL);
		expect(ALLOW_ALL.isItemAvailable("tv", "anything")).toBe(true);
		expect(ALLOW_ALL.disabledApps.size).toBe(0);
	});
	it("windows are half-open [start, end)", () => {
		expect(evaluate(def, T("12:45:59")).isItemAvailable("tv", "CNN")).toBe(false);
		expect(evaluate(def, T("12:46:00")).isItemAvailable("tv", "CNN")).toBe(true);
		expect(evaluate(def, T("13:29:59")).isItemAvailable("tv", "CNN")).toBe(true);
		expect(evaluate(def, T("13:30:00")).isItemAvailable("tv", "CNN")).toBe(false);
	});
	it("itemId match is case-insensitive", () => {
		expect(evaluate(def, T("12:50:00")).isItemAvailable("tv", "cnn")).toBe(true);
	});
	it("restrict mode hides unlisted items; annotate mode allows them", () => {
		expect(evaluate(def, T("12:50:00")).isItemAvailable("tv", "NBC")).toBe(false);
		const annotate = { ...def, mode: "annotate" as const };
		expect(evaluate(annotate, T("12:50:00")).isItemAvailable("tv", "NBC")).toBe(true);
		// listed items stay window-bound even in annotate mode
		expect(evaluate(annotate, T("12:00:00")).isItemAvailable("tv", "CNN")).toBe(false);
	});
	it("collects disabled apps and locked settings", () => {
		const snap = evaluate(def, T("12:00:00"));
		expect(snap.disabledApps.has("TimeMachine.app")).toBe(true);
		expect(snap.lockedSettings.get("TV.app")).toEqual({ captionsOn: true });
	});
	it("locked focus is active only inside its window", () => {
		expect(evaluate(def, T("12:50:00")).lockedFocus.get("tv")).toBe("CNN");
		expect(evaluate(def, T("13:31:00")).lockedFocus.get("tv")).toBeUndefined();
	});
	it("browserShouldBe: latest at wins; closeAt closes", () => {
		expect(evaluate(def, T("12:49:00")).browserShouldBe).toEqual({ open: false });
		expect(evaluate(def, T("12:51:00")).browserShouldBe).toEqual({
			open: true,
			url: "https://a.example/",
		});
		expect(evaluate(def, T("12:53:00")).browserShouldBe).toEqual({
			open: true,
			url: "https://b.example/",
		});
		// a closed at 12:55 but b (no closeAt) persists
		expect(evaluate(def, T("12:56:00")).browserShouldBe).toEqual({
			open: true,
			url: "https://b.example/",
		});
	});
});

describe("collectCrossings", () => {
	it("fires events in (prev, now], sorted by atMs", () => {
		const events = collectCrossings(def, T("12:59:59"), T("13:03:00"));
		expect(events.map((e) => e.kind)).toEqual(["file", "jump"]);
	});
	it("fires nothing on a backward or zero move", () => {
		expect(collectCrossings(def, T("13:10:00"), T("13:00:00"))).toEqual([]);
		expect(collectCrossings(def, T("13:00:00"), T("13:00:00"))).toEqual([]);
	});
	it("media focus crossings use start as at, carrying mode", () => {
		const events = collectCrossings(def, T("12:45:59"), T("12:46:00"));
		expect(events).toEqual([
			{ kind: "focus", atMs: T("12:46:00"), app: "tv", itemId: "CNN", mode: "locked" },
		]);
	});
	it("null definition yields nothing", () => {
		expect(collectCrossings(null, 0, 9e12)).toEqual([]);
	});
});

describe("initialFocusEvents", () => {
	it("returns focus entries whose window contains now (incl. no-start entries)", () => {
		const events = initialFocusEvents(def, T("12:50:00"));
		expect(events.map((e) => (e.kind === "focus" ? e.itemId : ""))).toEqual(["CNN", "wnyc"]);
	});
	it("excludes focus entries outside their window", () => {
		const events = initialFocusEvents(def, T("13:31:00"));
		expect(events.map((e) => (e.kind === "focus" ? e.itemId : ""))).toEqual(["wnyc"]);
	});
});
