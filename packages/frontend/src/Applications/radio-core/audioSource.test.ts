import { describe, expect, it } from "vitest";
import { resolveAudioUrl } from "./audioSource";

describe("resolveAudioUrl", () => {
	it("plays the enhanced render by default", () => {
		expect(
			resolveAudioUrl({ url: "/o.mp3", enhanced_url: "/e.mp3" }, false),
		).toBe("/e.mp3");
	});

	it("plays the original when the listener asks for it", () => {
		expect(
			resolveAudioUrl({ url: "/o.mp3", enhanced_url: "/e.mp3" }, true),
		).toBe("/o.mp3");
	});

	it("falls back to url when no enhanced render exists yet", () => {
		// enhanced_url is null until the enhancement pass has processed that
		// file. The default path must not produce an undefined src, which would
		// fail silently as a broken audio element.
		expect(resolveAudioUrl({ url: "/o.mp3", enhanced_url: null }, false)).toBe(
			"/o.mp3",
		);
	});

	it("falls back to url when the field is absent entirely", () => {
		expect(resolveAudioUrl({ url: "/o.mp3" }, false)).toBe("/o.mp3");
	});

	it("never returns undefined for either preference", () => {
		for (const preferOriginal of [true, false]) {
			expect(
				resolveAudioUrl({ url: "/o.mp3" }, preferOriginal),
			).toBeTypeOf("string");
		}
	});
});
