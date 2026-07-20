import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { useThumbnailReorder } from "./useThumbnailReorder";

// Minimal PointerEvent stand-in: the hook only reads these fields. The parent
// stands in for the strip, whose children carry data-source + layout boxes.
const pointerEvent = (clientX: number, clientY = 0) =>
	({
		clientX,
		clientY,
		pointerId: 1,
		currentTarget: {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			parentElement: {
				children: [
					{
						dataset: { source: "A" },
						getBoundingClientRect: () => ({ left: 0, right: 100 }),
					},
					{
						dataset: { source: "B" },
						getBoundingClientRect: () => ({ left: 100, right: 200 }),
					},
				],
			},
		},
	}) as unknown as React.PointerEvent<HTMLButtonElement>;

describe("useThumbnailReorder", () => {
	it("does not reorder or suppress a click when movement is below threshold", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(13)));
		act(() => h.onPointerUp(pointerEvent(13)));
		expect(onReorder).not.toHaveBeenCalled();
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("reorders and suppresses the click when movement exceeds threshold", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(onReorder).toHaveBeenCalledWith("A", "B");
		expect(result.current.consumeSuppressedClick()).toBe(true);
	});

	it("clears the suppression flag after a single read", () => {
		const { result } = renderHook(() => useThumbnailReorder(vi.fn()));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(result.current.consumeSuppressedClick()).toBe(true);
		// Second read must be false, or the *next* genuine click gets eaten.
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("exposes dragSource and dropTarget while dragging", () => {
		const { result } = renderHook(() => useThumbnailReorder(vi.fn()));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		expect(result.current.dragSource).toBe("A");
		expect(result.current.dropTarget).toBe("B");
	});

	it("aborts on pointer cancel without reordering or suppressing", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerCancel(pointerEvent(150)));
		expect(onReorder).not.toHaveBeenCalled();
		expect(result.current.dragSource).toBe(null);
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("aborts on Escape while dragging", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() =>
			h.onKeyDown({ key: "Escape" } as unknown as React.KeyboardEvent<HTMLButtonElement>),
		);
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("does not reorder when released over its own tile", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		// Moves far enough to start a drag but stays within tile A's box.
		act(() => h.onPointerMove(pointerEvent(80)));
		act(() => h.onPointerUp(pointerEvent(80)));
		expect(onReorder).not.toHaveBeenCalled();
	});
});
