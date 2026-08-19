import { useCallback, useEffect, useRef } from "react";
import styles from "./radio.module.scss";

/** 0..1, whatever came in. */
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

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
	onSeekPct,
}: {
	/**
	 * Optional because `mp3_items.peaks` is nullable and the compute-peaks
	 * backfill is still running: a card can mount for an item that has no
	 * envelope yet. Absent or empty draws the flat skeleton below.
	 */
	peaks?: number[][];
	/**
	 * The bitmap height, when the caller knows it. The playlist timeline does —
	 * its lane fixes the slot at a constant — so it passes one.
	 *
	 * Omit it and the canvas measures itself instead, which is what a Radio
	 * Traffic card needs: the card sizes its waveform as a proportion of the
	 * card, so the height is CSS's answer and no number in the component tree
	 * can know it. A bitmap authored at a constant and then stretched by CSS is
	 * a blurred waveform, which is the trap this avoids.
	 */
	height?: number;
	/**
	 * Where the virtual clock says playback should be, as a FRACTION of the
	 * recording — 0..1, the same units as radio-core's `onSeekPct`/`seekToPct`,
	 * NOT a 0..100 percentage. Card view only.
	 */
	livePct?: number;
	/**
	 * Where the playhead actually is, in the same units. The gap between this
	 * and {@link livePct} is what the card's drift badge reports.
	 */
	currentPct?: number;
	/**
	 * Makes the envelope a scrub surface: called with the 0..1 fraction under
	 * the pointer, on press and throughout a drag.
	 *
	 * Absent — which is what the playlist timeline passes — the component
	 * registers no handlers at all and renders exactly the bare canvas it always
	 * has. In particular it never listens for the wheel, in either mode: a card
	 * sits inside a lane that scrolls, and being a seek surface must not cost the
	 * listener the ability to scroll past it.
	 */
	onSeekPct?: (pct: number) => void;
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
			// And the height too, when the caller left it to CSS. Same reasoning,
			// same measurement — the ResizeObserver below already redraws on
			// either axis, so a card that grows redraws at its new resolution.
			const drawHeight = height ?? Math.round(canvas.clientHeight);
			if (drawHeight < 1) return;
			// Assigning either dimension resets the bitmap (and its context
			// state), so both are set before anything is drawn.
			if (canvas.width !== width) canvas.width = width;
			if (canvas.height !== drawHeight) canvas.height = drawHeight;
			ctx.clearRect(0, 0, width, drawHeight);
			// NOT "currentColor": that is a CSS keyword, not a color a canvas
			// context can parse, so per spec the assignment is dropped silently
			// and fillStyle stays #000000 — invisible on a dark lane. Resolve the
			// inherited color to a real value first.
			ctx.fillStyle = getComputedStyle(canvas).color || "#000000";
			const mid = drawHeight / 2;
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

	// The pointer maths, and a drag that only lives inside the waveform box.
	//
	// The move/up pair is on the window rather than on the canvas because a
	// plain canvas listener stops firing the moment the pointer leaves it —
	// exactly the case this needs to catch, not miss. Each move checks whether
	// the pointer is still over the canvas's own box and, the instant it isn't,
	// ends the drag itself rather than waiting for a pointerup that may never
	// come from outside the element. Pointer capture would report that as
	// pointerleave rather than ending the gesture, and is per-pointer-id state
	// the element has to still be alive to release — a card unmounts for
	// reasons that have nothing to do with the pointer (a tag filter, a lane
	// migration).
	const seekRef = useRef(onSeekPct);
	seekRef.current = onSeekPct;
	const endDragRef = useRef<(() => void) | null>(null);

	const seekAt = useCallback((clientX: number) => {
		const canvas = ref.current;
		const seek = seekRef.current;
		if (!canvas || !seek) return;
		const rect = canvas.getBoundingClientRect();
		// A zero-width box has no fraction to land in, and dividing by it would
		// hand the caller Infinity or NaN.
		if (rect.width <= 0) return;
		seek(clamp01((clientX - rect.left) / rect.width));
	}, []);

	/** Whether a pointer position still falls inside the waveform's own box. */
	const isInsideBox = useCallback((clientX: number, clientY: number) => {
		const canvas = ref.current;
		if (!canvas) return false;
		const rect = canvas.getBoundingClientRect();
		return (
			clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
		);
	}, []);

	const startDrag = useCallback(
		(e: React.PointerEvent<HTMLCanvasElement>) => {
			endDragRef.current?.();
			seekAt(e.clientX);
			const move = (ev: PointerEvent) => {
				// Leaving the box ends the gesture on the spot instead of clamping
				// and continuing to track — scrubbing is only "the pointer is down
				// and over the waveform," never "was down at some point off the edge."
				if (!isInsideBox(ev.clientX, ev.clientY)) {
					endDragRef.current?.();
					return;
				}
				seekAt(ev.clientX);
			};
			const end = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", end);
				window.removeEventListener("pointercancel", end);
				endDragRef.current = null;
			};
			endDragRef.current = end;
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", end);
			window.addEventListener("pointercancel", end);
		},
		[seekAt, isInsideBox],
	);

	// Unmounting mid-drag must take the window listeners with it.
	useEffect(() => () => endDragRef.current?.(), []);

	// A fragment, not a wrapper element. The scrubbers are absolutely
	// positioned against whatever containing block the caller already
	// establishes (`.playlistTimelineWaveformSlot` on the timeline, the waveform
	// slot in Radio Traffic); introducing a wrapper here would change the box
	// the timeline's canvas sits in, and this app has no global
	// `box-sizing: border-box`, so an extra box is not free. With neither
	// scrubber nor onSeekPct passed the output is exactly the bare canvas, with
	// no handlers on it, that it has always been.
	return (
		<>
			{/* The height attribute is set here as well as in the effect so the
			    element has a sane intrinsic aspect before it has ever been laid
			    out — when the caller named one. The class is global, from
			    PlaylistEditor.scss. */}
			<canvas
				ref={ref}
				height={height}
				className="playlistTimelineWaveform"
				onPointerDown={onSeekPct ? startDrag : undefined}
			/>
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
	height?: number;
}) {
	// Covers undefined, NaN and Infinity in one test: an item with no known
	// duration has no fraction, and `position / duration` is NaN before that
	// duration is known.
	if (!Number.isFinite(pct)) return null;
	// Clamped rather than trusted. An out-of-range value parks the marker at an
	// edge, which is visibly wrong — better than a line drawn outside the card.
	const clamped = clamp01(pct as number);
	return (
		<div
			className={`${styles.peaksScrubber} ${kind === "live" ? styles.peaksScrubberLive : styles.peaksScrubberCurrent}`}
			data-scrubber={kind}
			data-pct={clamped}
			// Pinned to the bitmap height the caller named, because a caller that
			// names one is telling us the box is exactly that tall. Where CSS
			// decides the height there is no such number, and stretching to the
			// containing block is the only answer that cannot be stale — a marker
			// pinned to a stale pixel height overflows its `overflow: hidden`
			// slot, and a slot with a scrollable overflow it cannot show is
			// exactly what swallows a wheel event before the lane can scroll.
			style={{ left: `${clamped * 100}%`, height: height === undefined ? "100%" : `${height}px` }}
		/>
	);
}
