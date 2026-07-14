import { afterEach, describe, expect, it, vi } from "vitest";
import { isAudioBlocked } from "./audioBlocked";
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

describe("resume on first user gesture", () => {
	class SuspendedAudioContext extends FakeAudioContext {
		state = "suspended";
	}

	it("resumes a context the browser created suspended once the user clicks", () => {
		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		const entry = captureAudioElement(el());
		expect(entry?.ctx.resume).not.toHaveBeenCalled();
		document.dispatchEvent(new Event("click"));
		expect(entry?.ctx.resume).toHaveBeenCalled();
	});

	it("resumes a suspended context on a keydown gesture too", () => {
		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		const entry = captureAudioElement(el());
		document.dispatchEvent(new Event("keydown"));
		expect(entry?.ctx.resume).toHaveBeenCalled();
	});

	it("leaves a running context alone on a gesture", () => {
		vi.stubGlobal(
			"AudioContext",
			class extends FakeAudioContext {
				state = "running";
			},
		);
		const entry = captureAudioElement(el());
		document.dispatchEvent(new Event("click"));
		expect(entry?.ctx.resume).not.toHaveBeenCalled();
	});

	it("stops retrying a context once a resume has succeeded", async () => {
		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		const entry = captureAudioElement(el());
		document.dispatchEvent(new Event("click"));
		await Promise.resolve(); // flush resume().then(...) removal
		document.dispatchEvent(new Event("click"));
		expect(entry?.ctx.resume).toHaveBeenCalledTimes(1);
	});

	it("resumes a suspended context on pointerdown (the mobile wheel suppresses click)", () => {
		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		const entry = captureAudioElement(el());
		expect(entry?.ctx.resume).not.toHaveBeenCalled();
		document.dispatchEvent(new Event("pointerdown"));
		expect(entry?.ctx.resume).toHaveBeenCalled();
	});

	it("reports blocked audio while a context awaits a gesture, clear after", async () => {
		vi.stubGlobal("AudioContext", SuspendedAudioContext);
		expect(isAudioBlocked()).toBe(false);
		const entry = captureAudioElement(el());
		expect(isAudioBlocked()).toBe(true);
		if (entry) (entry.ctx as unknown as { state: string }).state = "running";
		document.dispatchEvent(new Event("click"));
		await Promise.resolve();
		expect(isAudioBlocked()).toBe(false);
	});

	it("tracks a context that only reports suspended AFTER creation (statechange)", () => {
		class StatefulAudioContext extends FakeAudioContext {
			state = "running";
			listeners: Array<() => void> = [];
			addEventListener(_t: string, l: () => void) {
				this.listeners.push(l);
			}
			removeEventListener() {}
			fireStateChange() {
				for (const l of this.listeners) l();
			}
		}
		vi.stubGlobal("AudioContext", StatefulAudioContext);
		const entry = captureAudioElement(el());
		const ctx = entry?.ctx as unknown as InstanceType<typeof StatefulAudioContext>;
		expect(isAudioBlocked()).toBe(false);
		ctx.state = "suspended";
		ctx.fireStateChange();
		expect(isAudioBlocked()).toBe(true);
		ctx.state = "running";
		ctx.fireStateChange();
		expect(isAudioBlocked()).toBe(false);
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
