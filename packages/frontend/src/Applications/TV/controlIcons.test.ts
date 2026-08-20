/**
 * The TV control bar is now icon-only, so a missing icon is a blank button.
 *
 * This is not hypothetical: classicy dropped `ClassicyIcons.applications.epg` on
 * a routine version bump, which is why the EPG artwork now lives in this repo.
 * A key that disappears the same way resolves to `undefined`, React renders
 * `<img src="undefined">`, and the result is a broken image with no error
 * anywhere — the buttons carry no text to fall back on.
 *
 * `tsc` does not catch it either: the icon objects are typed loosely enough that
 * a missing leaf reads as `any`/`string` at the call site.
 */
import { ClassicyIcons } from "classicy";
import { describe, expect, it } from "vitest";
import multiviewIcon from "./multiview.png";
import "./epgIcons"; // side effect: registers ClassicyIcons.applications.epg
import type { EpgIconNamespace } from "./epgIcons";

// Read through the registry, exactly as TV.tsx does — a key that was never
// registered (or got dropped) fails here the same way it would on screen.
const epgIconSet = (ClassicyIcons.applications as unknown as { epg: EpgIconNamespace })
	.epg;

const icons: [string, unknown][] = [
	["play", ClassicyIcons.system.quicktime.playButton],
	["pause", ClassicyIcons.system.quicktime.pauseButton],
	["unmuted (soundOn)", ClassicyIcons.controlPanels.soundManager.soundOn],
	["muted (soundMute)", ClassicyIcons.controlPanels.soundManager.soundMute],
	["closed captions", epgIconSet.cc],
	["multiview", multiviewIcon],
];

describe("TV control-bar icons", () => {
	it.each(icons)("%s resolves to a usable src", (_name, src) => {
		expect(typeof src).toBe("string");
		expect(src as string).not.toBe("");
		// "undefined"/"null" as a literal string is what a vanished key looks
		// like once React has stringified it into the src attribute.
		expect(src as string).not.toMatch(/^(undefined|null)$/);
	});

	it("uses two distinct icons for play and pause", () => {
		// A single shared glyph would leave the button showing the same thing in
		// both states, which is the failure this pair exists to avoid.
		expect(ClassicyIcons.system.quicktime.playButton)
			.not.toBe(ClassicyIcons.system.quicktime.pauseButton);
	});

	it("uses two distinct icons for muted and unmuted", () => {
		expect(ClassicyIcons.controlPanels.soundManager.soundOn)
			.not.toBe(ClassicyIcons.controlPanels.soundManager.soundMute);
	});
});
