import { describe, expect, it, vi } from "vitest";
import {
	clearAudioBlocked,
	isAudioBlocked,
	markAudioBlocked,
	subscribeAudioBlocked,
} from "./audioBlocked";

describe("audioBlocked store", () => {
	it("is unblocked until something is marked", () => {
		expect(isAudioBlocked()).toBe(false);
	});

	it("tracks distinct tokens and clears when the last one is removed", () => {
		markAudioBlocked("a");
		markAudioBlocked("b");
		expect(isAudioBlocked()).toBe(true);
		clearAudioBlocked("a");
		expect(isAudioBlocked()).toBe(true);
		clearAudioBlocked("b");
		expect(isAudioBlocked()).toBe(false);
	});

	it("notifies subscribers only when the blocked state flips", () => {
		const cb = vi.fn();
		const unsubscribe = subscribeAudioBlocked(cb);
		markAudioBlocked("x");
		expect(cb).toHaveBeenCalledTimes(1);
		markAudioBlocked("y"); // still blocked — no flip
		expect(cb).toHaveBeenCalledTimes(1);
		clearAudioBlocked("y");
		expect(cb).toHaveBeenCalledTimes(1);
		clearAudioBlocked("x"); // last token — flips to unblocked
		expect(cb).toHaveBeenCalledTimes(2);
		unsubscribe();
		markAudioBlocked("z");
		expect(cb).toHaveBeenCalledTimes(2);
		clearAudioBlocked("z");
	});

	it("ignores clearing a token that was never marked", () => {
		const cb = vi.fn();
		const unsubscribe = subscribeAudioBlocked(cb);
		clearAudioBlocked("unknown");
		expect(cb).not.toHaveBeenCalled();
		expect(isAudioBlocked()).toBe(false);
		unsubscribe();
	});
});
