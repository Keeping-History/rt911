import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeaksWaveform } from "./PeaksWaveform";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// `clientWidth` lives on Element.prototype; the stub below shadows it with
	// an own property on HTMLCanvasElement.prototype, which has to come back off
	// or it leaks into every other file in the run.
	Reflect.deleteProperty(HTMLCanvasElement.prototype, "clientWidth");
});

type Rect = [number, number, number, number];

/**
 * jsdom has no canvas 2D context at all, so the drawing path is unreachable
 * without one. This records just enough of it to assert what got drawn and in
 * what color.
 */
function fakeContext() {
	const rects: Rect[] = [];
	const ctx = {
		fillStyle: "#000000",
		clearRect: vi.fn(),
		fillRect: (...r: Rect) => {
			rects.push(r);
		},
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		ctx as unknown as CanvasRenderingContext2D,
	);
	return { ctx, rects };
}

/** Stand in for layout: jsdom lays nothing out, so clientWidth is always 0. */
function stubClientWidth(width: () => number) {
	Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
		configurable: true,
		get: width,
	});
}

/** A ResizeObserver whose callback the test can fire on demand. */
function controllableResizeObserver() {
	const callbacks: (() => void)[] = [];
	class Stub {
		constructor(cb: () => void) {
			callbacks.push(cb);
		}
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", Stub);
	return () => {
		for (const cb of callbacks) cb();
	};
}

const peaks = Array.from({ length: 8 }, (_, i) => [-(i + 1) * 8, (i + 1) * 8]);

describe("PeaksWaveform", () => {
	it("renders a canvas sized to the requested height", () => {
		const tall = Array.from({ length: 480 }, (_, i) => [-i % 128, i % 128]);
		const { container } = render(<PeaksWaveform peaks={tall} height={40} />);
		const canvas = container.querySelector("canvas");
		expect(canvas).not.toBeNull();
		expect(canvas!.height).toBe(40);
	});

	it("renders nothing when there are no peaks", () => {
		const { container } = render(<PeaksWaveform peaks={[]} height={40} />);
		// No jest-dom in this repo: assert absence directly rather than via
		// toBeEmptyDOMElement.
		expect(container.firstChild).toBeNull();
	});

	it("sizes the bitmap to the laid-out width instead of the 300px default", () => {
		fakeContext();
		stubClientWidth(() => 137);
		const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
		const canvas = container.querySelector("canvas")!;
		expect(canvas.width).toBe(137);
	});

	it("fills with a real color, not the unparseable currentColor keyword", () => {
		const { ctx, rects } = fakeContext();
		stubClientWidth(() => 120);
		render(<PeaksWaveform peaks={peaks} height={40} />);
		// Assigning "currentColor" to a canvas fillStyle is silently ignored, so
		// the old code drew every waveform in the #000000 default.
		expect(ctx.fillStyle).not.toBe("currentColor");
		expect(ctx.fillStyle).toMatch(/^(#|rgb)/);
		expect(rects).toHaveLength(peaks.length);
		// One column per peak pair, spread across the laid-out width.
		expect(rects[0][0]).toBe(0);
		expect(rects[rects.length - 1][0]).toBeCloseTo((120 / peaks.length) * (peaks.length - 1), 6);
	});

	it("resizes and redraws its bitmap when the slot's width changes", () => {
		const { rects } = fakeContext();
		let width = 40;
		stubClientWidth(() => width);
		const fireResize = controllableResizeObserver();

		const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
		const canvas = container.querySelector("canvas")!;
		expect(canvas.width).toBe(40);
		const drawnAtFirstWidth = rects.length;

		// Zooming in widens the slot; without the observer the bitmap would keep
		// its first resolution and CSS would upscale it.
		width = 800;
		act(() => fireResize());
		expect(canvas.width).toBe(800);
		expect(rects.length).toBe(drawnAtFirstWidth * 2);
		expect(rects[rects.length - 1][0]).toBeCloseTo((800 / peaks.length) * (peaks.length - 1), 6);
	});

	it("draws nothing while the slot has no measurable width", () => {
		const { ctx, rects } = fakeContext();
		stubClientWidth(() => 0);
		render(<PeaksWaveform peaks={peaks} height={40} />);
		expect(rects).toHaveLength(0);
		expect(ctx.clearRect).not.toHaveBeenCalled();
	});
});
