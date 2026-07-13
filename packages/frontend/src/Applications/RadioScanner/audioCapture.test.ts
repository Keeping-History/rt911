import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAudioElement, setAudioSilenced } from "./audioCapture";

class FakeGain {
	gain = { value: 1 };
	connect = vi.fn();
	disconnect = vi.fn();
}
class FakeSource {
	connect = vi.fn();
}
class FakeAudioContext {
	destination = { kind: "destination" };
	createMediaElementSource = vi.fn(() => new FakeSource());
	createGain = vi.fn(() => new FakeGain());
	resume = vi.fn().mockResolvedValue(undefined);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const el = () => document.createElement("audio");

describe("captureAudioElement", () => {
	it("builds the permanent source → gain → destination chain", () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const a = el();
		const entry = captureAudioElement(a);
		expect(entry).not.toBeNull();
		expect(entry?.ctx.createMediaElementSource).toHaveBeenCalledWith(a);
		expect(entry?.source.connect).toHaveBeenCalledWith(entry?.gain);
		expect(entry?.gain.connect).toHaveBeenCalledWith(entry?.ctx.destination);
	});

	it("returns the same entry on repeat capture (source may be created once)", () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const a = el();
		const first = captureAudioElement(a);
		const second = captureAudioElement(a);
		expect(second).toBe(first);
		expect(first?.ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
	});

	it("returns null when the AudioContext cannot be built", () => {
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					throw new Error("nope");
				}
			},
		);
		expect(captureAudioElement(el())).toBeNull();
	});
});

describe("setAudioSilenced", () => {
	it("drives the gain of an already-captured element", () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const a = el();
		const entry = captureAudioElement(a);
		setAudioSilenced(a, true);
		expect(entry?.gain.gain.value).toBe(0);
		setAudioSilenced(a, false);
		expect(entry?.gain.gain.value).toBe(1);
	});

	it("is remembered by a later capture (silenced before primary)", () => {
		vi.stubGlobal("AudioContext", FakeAudioContext);
		const a = el();
		setAudioSilenced(a, true);
		const entry = captureAudioElement(a);
		expect(entry?.gain.gain.value).toBe(0);
	});

	it("is safe on an element that never gets captured", () => {
		expect(() => setAudioSilenced(el(), true)).not.toThrow();
	});
});
