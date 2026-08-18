import { useEffect, useRef } from "react";
import styles from "./radio.module.scss";

/**
 * A static amplitude envelope drawn from precomputed peaks.
 *
 * Deliberately not an extension of radio-core's own WaveformVisualizer: that
 * one captures live audio off an HTMLAudioElement through an AnalyserNode and
 * renders what is audible at this instant, so it can only ever show a moving
 * window of a *playing* element. This draws a whole recording from a fixed
 * array, whether or not anything is playing. There is no shared logic between
 * reading an AnalyserNode and drawing an array.
 *
 * `peaks` is `mp3_items.peaks`: an array of `[min, max]` pairs — 480 buckets on
 * every populated row — scaled to -128..127, matching the compute-peaks
 * pipeline's int8 range.
 *
 * It lives in radio-core rather than in PlaylistEditor because two unrelated
 * surfaces draw the same envelope: the playlist timeline's radio lane (which
 * passes neither scrubber) and the Radio Traffic cards (which pass both).
 * PlaylistEditor re-exports it from its old path so the timeline's call sites
 * did not have to move.
 */
export function PeaksWaveform({
	peaks,
	height,
	livePct,
	currentPct,
}: {
	/**
	 * Optional because `mp3_items.peaks` is nullable and the compute-peaks
	 * backfill is still running: a card can mount for an item that has no
	 * envelope yet. Absent or empty draws the flat skeleton below.
	 */
	peaks?: number[][];
	height: number;
	/**
	 * Where the virtual clock says playback should be, as a FRACTION of the
	 * recording — 0..1, the same units as radio-core's `onSeekPct`/`seekToPct`,
	 * NOT a 0..100 percentage. Card view only.
	 */
	livePct?: number;
	/**
	 * Where the `<audio>` element actually is, in the same units. The gap
	 * between this and {@link livePct} is what the card's drift badge reports.
	 */
	currentPct?: number;
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
			if (!peaks || peaks.length === 0) {
				// Flat skeleton rather than an early `return null`, because the
				// card reserves a fixed slot for the waveform: collapsing it
				// would reflow the card the moment the envelope arrived. Also
				// guards the `width / peaks.length` below against a zero
				// divisor. The playlist timeline never reaches this branch —
				// `overlappingSpans` in usePeaksForSpan.ts already drops rows
				// whose `peaks` is missing or empty, so the lane still shows
				// nothing rather than a row of hairlines.
				ctx.fillRect(0, mid - 0.5, width, 1);
				return;
			}
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

	// A fragment, not a wrapper element. The scrubbers are absolutely
	// positioned against whatever containing block the caller already
	// establishes (`.playlistTimelineWaveformSlot` on the timeline, the card
	// frame in Radio Traffic); introducing a wrapper here would change the box
	// the timeline's canvas sits in, and this app has no global
	// `box-sizing: border-box`, so an extra box is not free. With neither
	// scrubber passed the output is exactly the bare canvas it has always been.
	return (
		<>
			{/* The height attribute is set here as well as in the effect so the
			    element has a sane intrinsic aspect before it has ever been laid
			    out. The class is global, from PlaylistEditor.scss. */}
			<canvas ref={ref} height={height} className="playlistTimelineWaveform" />
			<Scrubber kind="live" pct={livePct} height={height} />
			<Scrubber kind="current" pct={currentPct} height={height} />
		</>
	);
}

/**
 * One position marker.
 *
 * A positioned div and not a canvas draw on purpose: these move on every clock
 * tick, and repainting a 480-bucket envelope at tick rate to move a 2px line is
 * the cost this avoids. Moving one is a style update on an element the browser
 * composites; the bitmap is only ever rewritten when the layout width changes.
 */
function Scrubber({
	kind,
	pct,
	height,
}: {
	kind: "live" | "current";
	pct?: number;
	height: number;
}) {
	// Covers undefined, NaN and Infinity in one test: a card with no audio
	// element yet has no position, and `position / duration` is NaN before
	// duration is known.
	if (!Number.isFinite(pct)) return null;
	// Clamped rather than trusted. An out-of-range value parks the marker at an
	// edge, which is visibly wrong — better than a line drawn outside the card.
	const clamped = Math.min(Math.max(pct as number, 0), 1);
	return (
		<div
			className={`${styles.peaksScrubber} ${kind === "live" ? styles.peaksScrubberLive : styles.peaksScrubberCurrent}`}
			data-scrubber={kind}
			data-pct={clamped}
			// Height tracks the canvas's own pixel height rather than stretching
			// to the containing block, which is taller than the waveform on a
			// card.
			style={{ left: `${clamped * 100}%`, height: `${height}px` }}
		/>
	);
}
