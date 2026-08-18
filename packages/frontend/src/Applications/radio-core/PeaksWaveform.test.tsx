import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("no-ops instead of throwing when there is no 2D context", () => {
		// Stubbed explicitly rather than leaning on jsdom's own unimplemented
		// getContext, which reaches the same branch but writes a "Not
		// implemented" line to stderr on the way.
		const getContext = vi
			.spyOn(HTMLCanvasElement.prototype, "getContext")
			.mockReturnValue(null);
		stubClientWidth(() => 120);
		const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
		expect(getContext).toHaveBeenCalledWith("2d");
		const canvas = container.querySelector("canvas")!;
		// Bailed before touching the bitmap: it still has the 300px default
		// rather than having been resized for a draw that cannot happen.
		expect(canvas.width).toBe(300);
	});

	// `mp3_items.peaks` is nullable and the compute-peaks backfill is still
	// running, so a card can mount for an item that has no envelope. The card
	// reserves a fixed slot for the waveform, so collapsing to nothing would
	// reflow the card the moment the envelope arrived.
	const noEnvelope: [string, number[][] | undefined][] = [
		["empty", []],
		["absent", undefined],
	];
	for (const [label, absent] of noEnvelope) {
		it(`draws a flat skeleton across the full width when peaks are ${label}`, () => {
			const { rects } = fakeContext();
			stubClientWidth(() => 120);
			const { container } = render(<PeaksWaveform peaks={absent} height={40} />);
			expect(container.querySelector("canvas")).not.toBeNull();
			// One hairline at the vertical middle, spanning the whole width —
			// not the `width / 0 = Infinity` step the envelope path would take.
			expect(rects).toEqual([[0, 19.5, 120, 1]]);
		});
	}

	describe("scrubbers", () => {
		// These assert DOM, not drawing, but the effect still calls getContext
		// on the way to bailing out — and jsdom's unimplemented one writes to
		// stderr. Stub it so the suite's output stays clean.
		beforeEach(() => {
			fakeContext();
		});

		it("renders none at all when neither position is given", () => {
			// This is exactly what the playlist timeline passes, and the shape
			// its lane has always rendered: a bare canvas and nothing else.
			const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
			expect(container.querySelectorAll("[data-scrubber]")).toHaveLength(0);
			expect(container.childNodes).toHaveLength(1);
			expect(container.firstChild).toBe(container.querySelector("canvas"));
		});

		it("exposes each position on its own div", () => {
			const { container } = render(
				<PeaksWaveform peaks={peaks} height={40} livePct={0.25} currentPct={0.5} />,
			);
			const live = container.querySelector<HTMLElement>('[data-scrubber="live"]')!;
			const current = container.querySelector<HTMLElement>('[data-scrubber="current"]')!;
			expect(live.dataset.pct).toBe("0.25");
			expect(current.dataset.pct).toBe("0.5");
			// A positioned DIV, not a canvas draw: the markers move every clock
			// tick and must not force a repaint of the envelope.
			expect(live.tagName).toBe("DIV");
			expect(current.tagName).toBe("DIV");
			expect(live.className).toContain("peaksScrubber");
			// 0..1 fraction in, percentage out — the same units as radio-core's
			// onSeekPct, not a 0..100 percentage.
			expect(live.style.left).toBe("25%");
			expect(current.style.left).toBe("50%");
			// Tied to the canvas's own pixel height, not to the containing
			// block, which is taller than the waveform on a card.
			expect(live.style.height).toBe("40px");
		});

		it("renders one scrubber when only one position is known", () => {
			const { container } = render(<PeaksWaveform peaks={peaks} height={40} livePct={0.1} />);
			expect(container.querySelectorAll("[data-scrubber]")).toHaveLength(1);
			expect(container.querySelector('[data-scrubber="live"]')).not.toBeNull();
		});

		it("drops a position that is not a finite number", () => {
			// `currentTime / duration` is NaN before the element knows its
			// duration, which is the first frame of every card.
			const { container } = render(
				<PeaksWaveform peaks={peaks} height={40} livePct={Number.NaN} currentPct={0.5} />,
			);
			expect(container.querySelectorAll("[data-scrubber]")).toHaveLength(1);
			expect(container.querySelector('[data-scrubber="current"]')).not.toBeNull();
		});

		it("parks an out-of-range position at the edge rather than outside the box", () => {
			const { container } = render(
				<PeaksWaveform peaks={peaks} height={40} livePct={-0.4} currentPct={3} />,
			);
			expect(container.querySelector<HTMLElement>('[data-scrubber="live"]')!.style.left).toBe(
				"0%",
			);
			expect(container.querySelector<HTMLElement>('[data-scrubber="current"]')!.style.left).toBe(
				"100%",
			);
		});

		it("moves without redrawing the envelope", () => {
			// The whole reason the scrubbers are divs. A card ticks these once a
			// second; if a move repainted the 480-bucket bitmap, every visible
			// card would redraw its envelope every second.
			const { rects } = fakeContext();
			stubClientWidth(() => 120);
			const { container, rerender } = render(
				<PeaksWaveform peaks={peaks} height={40} livePct={0.1} currentPct={0.1} />,
			);
			const drawn = rects.length;
			expect(drawn).toBe(peaks.length);

			rerender(<PeaksWaveform peaks={peaks} height={40} livePct={0.9} currentPct={0.8} />);
			expect(rects.length).toBe(drawn);
			expect(container.querySelector<HTMLElement>('[data-scrubber="live"]')!.style.left).toBe(
				"90%",
			);
		});
	});

	it("is a static draw: no rAF, no AudioContext, no createMediaElementSource", () => {
		// WaveformVisualizer.tsx does all three because it renders live audio.
		// This component draws a whole file from a fixed array; picking any of
		// them up would mean it had started sampling playback instead, and it
		// would then be unable to draw an item that is not playing at all.
		const source = readFileSync(join(__dirname, "PeaksWaveform.tsx"), "utf8");
		for (const banned of ["requestAnimationFrame", "AudioContext", "createMediaElementSource"]) {
			// The header comment names WaveformVisualizer but none of these.
			expect(source).not.toContain(banned);
		}
	});
});
