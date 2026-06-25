import { describe, expect, it } from "vitest";
import { vttUrl } from "./MediaStreamContext";

describe("vttUrl", () => {
	it("converts .srt extension to .vtt", () => {
		expect(vttUrl("https://example.com/captions.srt")).toBe(
			"https://example.com/captions.vtt",
		);
	});

	it("returns undefined for undefined input", () => {
		expect(vttUrl(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(vttUrl("")).toBeUndefined();
	});

	it("is case-insensitive (.SRT uppercased)", () => {
		expect(vttUrl("https://example.com/captions.SRT")).toBe(
			"https://example.com/captions.vtt",
		);
	});

	it("does not modify a URL without .srt extension", () => {
		expect(vttUrl("https://example.com/captions.vtt")).toBe(
			"https://example.com/captions.vtt",
		);
	});
});
