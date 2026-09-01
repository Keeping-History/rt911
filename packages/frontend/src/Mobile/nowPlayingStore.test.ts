import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNowPlaying, saveNowPlaying } from "./nowPlayingStore";

const KEY = "rt911IpodNowPlaying";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("nowPlayingStore", () => {
	it("round-trips a radio source", () => {
		saveNowPlaying({ kind: "radio", key: "WINS" });
		expect(loadNowPlaying()).toEqual({ kind: "radio", key: "WINS" });
	});

	it("round-trips a TV source", () => {
		saveNowPlaying({ kind: "tv", id: 42 });
		expect(loadNowPlaying()).toEqual({ kind: "tv", id: 42 });
	});

	it("clears the stored source on null", () => {
		saveNowPlaying({ kind: "radio", key: "WINS" });
		saveNowPlaying(null);
		expect(window.localStorage.getItem(KEY)).toBeNull();
		expect(loadNowPlaying()).toBeNull();
	});

	it("loads null when nothing was stored", () => {
		expect(loadNowPlaying()).toBeNull();
	});

	// localStorage survives deploys, so a stored value is untrusted input: any
	// shape mismatch must fall back to "nothing tuned", never crash boot.
	it("rejects corrupt JSON and malformed shapes", () => {
		window.localStorage.setItem(KEY, "{not json");
		expect(loadNowPlaying()).toBeNull();
		window.localStorage.setItem(KEY, JSON.stringify({ kind: "radio" }));
		expect(loadNowPlaying()).toBeNull();
		window.localStorage.setItem(KEY, JSON.stringify({ kind: "tv", id: "42" }));
		expect(loadNowPlaying()).toBeNull();
		window.localStorage.setItem(KEY, JSON.stringify({ kind: "cassette", id: 1 }));
		expect(loadNowPlaying()).toBeNull();
		window.localStorage.setItem(KEY, JSON.stringify("radio"));
		expect(loadNowPlaying()).toBeNull();
	});

	it("degrades to session-only when storage throws (private-mode Safari)", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		expect(loadNowPlaying()).toBeNull();
		expect(() => saveNowPlaying({ kind: "radio", key: "WINS" })).not.toThrow();
	});
});
