import { describe, expect, it } from "vitest";
import { parsePlaylist } from "./parsePlaylist";
import { playlistUtcMs } from "./playlistTypes";

const valid = {
	version: 1,
	mode: "restrict",
	entries: [
		{
			kind: "media",
			app: "tv",
			itemId: "CNN",
			start: "2001-09-11T12:46:00",
			end: "2001-09-11T13:30:00",
			focus: "once",
		},
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true }, locked: true },
		{ kind: "file", path: "Documents:Newspapers:nytimes-2001-09-12.pdf", at: "2001-09-11T13:00:00" },
		{ kind: "jump", at: "2001-09-11T13:03:00", to: "2001-09-11T13:59:00" },
		{ kind: "browser", url: "https://www.cnn.com/", at: "2001-09-11T12:50:00", closeAt: "2001-09-11T12:55:00" },
	],
};

describe("playlistUtcMs", () => {
	it("treats a bare string as UTC (appends Z)", () => {
		expect(playlistUtcMs("2001-09-11T12:46:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("respects an explicit zone", () => {
		expect(playlistUtcMs("2001-09-11T08:46:00-04:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("throws on garbage", () => {
		expect(() => playlistUtcMs("not a date")).toThrow();
	});
});

describe("parsePlaylist", () => {
	it("accepts a fully valid document with no warnings", () => {
		const { definition, warnings } = parsePlaylist(valid);
		expect(definition?.entries).toHaveLength(6);
		expect(definition?.mode).toBe("restrict");
		expect(warnings).toEqual([]);
	});
	it("rejects a structurally invalid document", () => {
		expect(parsePlaylist(null).definition).toBeNull();
		expect(parsePlaylist({ version: 2, mode: "restrict", entries: [] }).definition).toBeNull();
		expect(parsePlaylist({ version: 1, mode: "nope", entries: [] }).definition).toBeNull();
		expect(parsePlaylist({ version: 1, mode: "restrict", entries: "x" }).definition).toBeNull();
	});
	it("drops malformed entries with a warning and keeps the rest", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [
				{ kind: "media", app: "tv", itemId: "CNN", start: "garbage" }, // bad time
				{ kind: "media", app: "fax", itemId: "X" }, // unknown app
				{ kind: "jump", at: "2001-09-11T13:00:00" }, // missing `to`
				valid.entries[1], // fine
			],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toHaveLength(3);
	});
	it("ignores unknown kinds silently (forward compatibility)", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [{ kind: "hologram", zap: true }, valid.entries[1]],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toEqual([]);
	});
	it("skips focus/settings entries targeting a disabled app, with a warning", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [
				{ kind: "app", appId: "TV.app", disabled: true },
				{ kind: "media", app: "tv", itemId: "CNN", focus: "once" },
				{ kind: "settings", appId: "TV.app", values: { captionsOn: true } },
			],
		});
		// media entry survives as a WINDOW (availability) but its focus is stripped;
		// the settings entry is dropped entirely. Disable wins.
		const media = definition?.entries.find((e) => e.kind === "media");
		expect(media && "focus" in media ? media.focus : undefined).toBeUndefined();
		expect(definition?.entries.some((e) => e.kind === "settings")).toBe(false);
		expect(warnings).toHaveLength(2);
	});
	it("warns on a backward jump but keeps it (documented loop mechanism)", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [{ kind: "jump", at: "2001-09-11T13:00:00", to: "2001-09-11T12:00:00" }],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toHaveLength(1);
	});
});
