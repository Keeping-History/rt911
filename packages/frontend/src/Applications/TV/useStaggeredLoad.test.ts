import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStaggeredLoad } from "./useStaggeredLoad";

// Minimal controllable IntersectionObserver mock: capture the callback and the
// observed elements so tests can drive intersection events deterministically.
type IOEntry = { target: Element; isIntersecting: boolean };
let lastObserver: {
	cb: (entries: IOEntry[]) => void;
	elements: Set<Element>;
} | null = null;

beforeEach(() => {
	lastObserver = null;
	class MockIO {
		elements = new Set<Element>();
		constructor(cb: (entries: IOEntry[]) => void) {
			// Capture cb and the elements Set reference (not `this`) so tests can
			// drive IO events; the Set is shared by reference so mutations via
			// observe/unobserve are visible through lastObserver.
			lastObserver = { cb, elements: this.elements };
		}
		observe(el: Element) { this.elements.add(el); }
		unobserve(el: Element) { this.elements.delete(el); }
		disconnect() { this.elements.clear(); }
	}
	vi.stubGlobal("IntersectionObserver", MockIO);
});
afterEach(() => vi.unstubAllGlobals());

/** Build a fake element carrying its channel id for assertions. */
const elFor = (id: number) => {
	const el = document.createElement("div");
	(el as unknown as { __id: number }).__id = id;
	return el;
};

describe("useStaggeredLoad", () => {
	it("mounts all channels without staggering at/below the threshold", () => {
		const rootRef = createRef<HTMLElement>();
		const { result } = renderHook(() =>
			useStaggeredLoad({ ids: [1, 2, 3, 4], priorityIds: [], rootRef }),
		);
		for (const id of [1, 2, 3, 4]) {
			expect(result.current.shouldMount(id)).toBe(true);
		}
	});

	it("bounds concurrent loads above the threshold and fills slots on load", () => {
		vi.stubGlobal("navigator", { deviceMemory: 2 } as Navigator); // K = 2
		const rootRef = createRef<HTMLElement>();
		const ids = [1, 2, 3, 4, 5];
		const { result } = renderHook(() =>
			useStaggeredLoad({ ids, priorityIds: [], rootRef }),
		);

		// Register + reveal all five thumbnails.
		act(() => {
			for (const id of ids) result.current.observe(id, elFor(id));
			lastObserver?.cb(
				[...(lastObserver?.elements ?? [])].map((target) => ({
					target,
					isIntersecting: true,
				})),
			);
		});

		const mounted = () => ids.filter((id) => result.current.shouldMount(id));
		expect(mounted().length).toBe(2);

		// First two report ready -> next two should mount.
		act(() => {
			for (const id of mounted()) result.current.markLoaded(id);
		});
		expect(mounted().length).toBe(4);
	});

	it("unmounts thumbnails that scroll out of view", () => {
		vi.stubGlobal("navigator", { deviceMemory: 8 } as Navigator);
		const rootRef = createRef<HTMLElement>();
		const ids = [1, 2, 3, 4, 5];
		const { result } = renderHook(() =>
			useStaggeredLoad({ ids, priorityIds: [], rootRef }),
		);
		const els = new Map(ids.map((id) => [id, elFor(id)]));
		act(() => {
			for (const id of ids) result.current.observe(id, els.get(id) ?? null);
			lastObserver?.cb(ids.map((id) => ({ target: els.get(id)!, isIntersecting: true })));
		});
		expect(result.current.shouldMount(1)).toBe(true);

		act(() => {
			lastObserver?.cb([{ target: els.get(1)!, isIntersecting: false }]);
		});
		expect(result.current.shouldMount(1)).toBe(false);
	});
});
