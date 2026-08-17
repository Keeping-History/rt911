import { useEffect, useRef } from "react";

/**
 * A static amplitude envelope drawn from precomputed peaks.
 *
 * Deliberately not an extension of RadioScanner's WaveformVisualizer: that one
 * captures live audio from an HTMLAudioElement and renders what is playing. A
 * timeline entry is not playing, and there is no shared logic between reading
 * an AnalyserNode and drawing a fixed array.
 *
 * `peaks` is `mp3_items.peaks`: an array of `[min, max]` pairs scaled to
 * -128..127 (matching the compute-peaks pipeline's int8 range).
 */
export function PeaksWaveform({
	peaks,
	height,
}: {
	peaks: number[][];
	height: number;
}) {
	const ref = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;

		const draw = () => {
			const ctx = canvas.getContext("2d");
			// jsdom (unit tests) has no canvas 2D context; nothing to draw there.
			if (!ctx) return;
			// The bitmap has to be sized from layout every time. The slot this
			// canvas fills is a TIME SPAN of the track, so its CSS width ranges
			// from a couple of pixels to hundreds and changes on every zoom step;
			// leaving the bitmap at the 300px default just hands CSS the job of
			// squashing or upscaling one fixed drawing into whatever box it got.
			const width = Math.round(canvas.clientWidth);
			if (width < 1) return;
			// Assigning either dimension resets the bitmap (and its context
			// state), so both are set before anything is drawn.
			if (canvas.width !== width) canvas.width = width;
			if (canvas.height !== height) canvas.height = height;
			ctx.clearRect(0, 0, width, height);
			// NOT "currentColor": that is a CSS keyword, not a color a canvas
			// context can parse, so per spec the assignment is dropped silently
			// and fillStyle stays #000000 — invisible on a dark lane. Resolve the
			// inherited color to a real value first.
			ctx.fillStyle = getComputedStyle(canvas).color || "#000000";
			const mid = height / 2;
			const step = width / peaks.length;
			peaks.forEach(([lo, hi], i) => {
				const top = mid - (hi / 128) * mid;
				const bottom = mid - (lo / 128) * mid;
				ctx.fillRect(i * step, top, Math.max(step, 1), Math.max(bottom - top, 1));
			});
		};

		draw();
		// Redrawing on resize is not optional here: the slot's width follows the
		// zoom level, and without this the envelope would keep whatever bitmap
		// resolution it was first laid out at.
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(draw);
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [peaks, height]);

	if (peaks.length === 0) return null;
	// The height attribute is set here as well as in the effect so the element
	// has a sane intrinsic aspect before it has ever been laid out.
	return <canvas ref={ref} height={height} className="playlistTimelineWaveform" />;
}
