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
		const ctx = canvas.getContext("2d");
		// jsdom (unit tests) has no canvas 2D context; nothing to draw there.
		if (!ctx) return;
		const { width } = canvas;
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "currentColor";
		const mid = height / 2;
		const step = width / peaks.length;
		peaks.forEach(([lo, hi], i) => {
			const top = mid - (hi / 128) * mid;
			const bottom = mid - (lo / 128) * mid;
			ctx.fillRect(i * step, top, Math.max(step, 1), Math.max(bottom - top, 1));
		});
	}, [peaks, height]);

	if (peaks.length === 0) return null;
	return <canvas ref={ref} height={height} className="playlistTimelineWaveform" />;
}
