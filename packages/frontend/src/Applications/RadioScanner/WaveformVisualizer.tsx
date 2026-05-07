import AudioMotionAnalyzer from "audiomotion-analyzer";
import type React from "react";
import { useEffect, useRef, useState } from "react";

interface WaveformVisualizerProps {
	audioEl: HTMLAudioElement | null;
}

// One AudioContext + MediaElementSourceNode per audio element.
// createMediaElementSource() may only be called once per element; this
// WeakMap lets the entry be GC'd when the audio element is collected.
const audioContextMap = new WeakMap<
	HTMLAudioElement,
	{ ctx: AudioContext; source: MediaElementAudioSourceNode }
>();

const VIZ_MODES = [
	{ label: "Bars",     mode: 3,  radial: false, fillAlpha: 0,   lineWidth: 0, barSpace: 0.4 },
	{ label: "Spectrum", mode: 0,  radial: false, fillAlpha: 0.5, lineWidth: 2, barSpace: 0   },
	{ label: "Radial",   mode: 4,  radial: true,  fillAlpha: 0.3, lineWidth: 0, barSpace: 0.3 },
	{ label: "Wave",     mode: 10, radial: false, fillAlpha: 0.3, lineWidth: 2, barSpace: 0   },
] as const;

/**
 * Renders a real-time audio visualizer using audiomotion-analyzer. Uses
 * overlay mode so the canvas is absolutely positioned and transparent,
 * acting as a background layer inside the nearest positioned ancestor.
 * A small toggle button cycles through four visualization modes.
 */
export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({ audioEl }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const motionRef = useRef<AudioMotionAnalyzer | null>(null);
	const [modeIndex, setModeIndex] = useState(0);
	// Ref keeps the creation closure current without making modeIndex a dep.
	const modeIndexRef = useRef(modeIndex);
	modeIndexRef.current = modeIndex;

	// Create/destroy the audiomotion instance when the audio element changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: modeIndex intentionally excluded — handled by separate effect
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !audioEl) return;

		// Get or create the shared AudioContext and source node for this element.
		let entry = audioContextMap.get(audioEl);
		if (!entry) {
			try {
				const ctx = new AudioContext();
				const source = ctx.createMediaElementSource(audioEl);
				// Direct path to speakers ensures audio keeps playing even when
				// the visualizer is stopped or recreated between renders.
				source.connect(ctx.destination);
				entry = { ctx, source };
				audioContextMap.set(audioEl, entry);
			} catch {
				return;
			}
		}
		entry.ctx.resume().catch(() => {});

		const { mode, radial, fillAlpha, lineWidth, barSpace } = VIZ_MODES[modeIndexRef.current];
		let motion: AudioMotionAnalyzer;
		try {
			motion = new AudioMotionAnalyzer(container, {
				audioCtx: entry.ctx,
				// Audio already routes to speakers via source → destination above.
				// Disable audiomotion's own connection to avoid doubling the signal.
				connectSpeakers: false,
				// overlay: true makes the canvas position:absolute with a transparent
				// background so it layers over sibling content inside the container.
				overlay: true,
				gradient: "classic",
				mode,
				radial,
				fillAlpha,
				lineWidth,
				barSpace,
				smoothing: 0.8,
				showScaleX: false,
			});
			motion.connectInput(entry.source);
			motionRef.current = motion;
		} catch {
			return;
		}

		return () => {
			// Remove the canvas from the DOM before stopping so that React
			// StrictMode's double-invoke doesn't leave a stale canvas behind
			// when the effect re-runs.
			motion.canvas.remove();
			// Stop animation only — do NOT call destroy(), which closes the
			// AudioContext and permanently silences the audio element.
			motion.stop();
			motionRef.current = null;
		};
	}, [audioEl]);

	// Update the live instance's properties when the mode changes.
	useEffect(() => {
		const motion = motionRef.current;
		if (!motion) return;
		const { mode, radial, fillAlpha, lineWidth, barSpace } = VIZ_MODES[modeIndex];
		motion.mode = mode;
		motion.radial = radial;
		motion.fillAlpha = fillAlpha;
		motion.lineWidth = lineWidth;
		motion.barSpace = barSpace;
	}, [modeIndex]);

	return (
		<div
			ref={containerRef}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
			}}
		>
			<button
				type="button"
				onMouseUp={() => setModeIndex((i) => (i + 1) % VIZ_MODES.length)}
				style={{
					position: "absolute",
					bottom: "var(--window-padding-size, 6px)",
					right: "var(--window-padding-size, 6px)",
					zIndex: 1,
					pointerEvents: "auto",
					opacity: 0.5,
					background: "transparent",
					border: "none",
					cursor: "pointer",
					fontSize: "0.7em",
					fontFamily: "var(--ui-font)",
					color: "var(--color-theme-02, rgba(0, 210, 90, 0.8))",
					padding: "2px 4px",
				}}
			>
				{VIZ_MODES[modeIndex].label}
			</button>
		</div>
	);
};
