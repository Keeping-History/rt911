import type React from "react";
import { useEffect, useRef, useState } from "react";
import { captureAudioElement } from "./audioCapture";
import { keepAudioContextAlive } from "./audioContextKeepAlive";

interface WaveformVisualizerProps {
	audioEl: HTMLAudioElement | null;
}

const VIZ_MODES = [
	{ label: "Bars" },
	{ label: "Spectrum" },
	{ label: "Radial" },
	{ label: "Wave" },
] as const;

// Matches var(--color-theme-02) fallback used on the toggle button.
const COLOR_BRIGHT = "rgba(0,210,90,0.9)";
const COLOR_DIM = "rgba(0,180,70,0.3)";

function linearGrad(d: CanvasRenderingContext2D, h: number): CanvasGradient {
	const g = d.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, COLOR_BRIGHT);
	g.addColorStop(1, COLOR_DIM);
	return g;
}

function drawBars(d: CanvasRenderingContext2D, a: AnalyserNode, w: number, h: number) {
	const buf = new Uint8Array(a.frequencyBinCount);
	a.getByteFrequencyData(buf);
	d.clearRect(0, 0, w, h);
	const g = linearGrad(d, h);
	const n = Math.min(buf.length, Math.floor(w / 4));
	const bw = (w / n) * 0.6;
	const gap = (w / n) * 0.4;
	for (let i = 0; i < n; i++) {
		const bh = (buf[Math.floor((i / n) * buf.length)] / 255) * h;
		d.fillStyle = g;
		d.fillRect(i * (bw + gap), h - bh, bw, bh);
	}
}

function drawSpectrum(d: CanvasRenderingContext2D, a: AnalyserNode, w: number, h: number) {
	const buf = new Uint8Array(a.frequencyBinCount);
	a.getByteFrequencyData(buf);
	d.clearRect(0, 0, w, h);
	const g = linearGrad(d, h);
	const last = buf.length - 1;

	d.beginPath();
	d.moveTo(0, h);
	for (let i = 0; i < buf.length; i++) d.lineTo((i / last) * w, h - (buf[i] / 255) * h);
	d.lineTo(w, h);
	d.closePath();
	d.globalAlpha = 0.5;
	d.fillStyle = g;
	d.fill();

	d.globalAlpha = 1;
	d.beginPath();
	d.moveTo(0, h - (buf[0] / 255) * h);
	for (let i = 1; i < buf.length; i++) d.lineTo((i / last) * w, h - (buf[i] / 255) * h);
	d.strokeStyle = COLOR_BRIGHT;
	d.lineWidth = 2;
	d.stroke();
}

function drawRadial(d: CanvasRenderingContext2D, a: AnalyserNode, w: number, h: number) {
	const buf = new Uint8Array(a.frequencyBinCount);
	a.getByteFrequencyData(buf);
	d.clearRect(0, 0, w, h);

	const cx = w / 2;
	const cy = h / 2;
	const r0 = Math.min(w, h) * 0.15;
	const maxH = Math.min(w, h) * 0.35;
	const n = 128;
	const bw = ((2 * Math.PI * r0) / n) * 0.7;

	// Radial gradient: dim at center, bright at outer edge of bars.
	const g = d.createRadialGradient(cx, cy, r0, cx, cy, r0 + maxH);
	g.addColorStop(0, COLOR_DIM);
	g.addColorStop(1, COLOR_BRIGHT);

	d.globalAlpha = 0.85;
	for (let i = 0; i < n; i++) {
		const bh = (buf[Math.floor((i / n) * buf.length * 0.75)] / 255) * maxH;
		if (bh < 1) continue;
		d.save();
		d.translate(cx, cy);
		d.rotate((i / n) * 2 * Math.PI - Math.PI / 2);
		d.fillStyle = g;
		d.fillRect(-bw / 2, r0, bw, bh);
		d.restore();
	}
	d.globalAlpha = 1;
}

function drawWave(d: CanvasRenderingContext2D, a: AnalyserNode, w: number, h: number) {
	const buf = new Uint8Array(a.fftSize);
	a.getByteTimeDomainData(buf);
	d.clearRect(0, 0, w, h);
	const g = linearGrad(d, h);
	const sw = w / buf.length;

	d.beginPath();
	d.moveTo(0, h / 2);
	for (let i = 0; i < buf.length; i++) d.lineTo(i * sw, ((buf[i] - 128) / 128) * (h / 2) + h / 2);
	d.lineTo(w, h / 2);
	d.lineTo(w, h);
	d.lineTo(0, h);
	d.closePath();
	d.globalAlpha = 0.3;
	d.fillStyle = g;
	d.fill();

	d.globalAlpha = 1;
	d.beginPath();
	d.moveTo(0, ((buf[0] - 128) / 128) * (h / 2) + h / 2);
	for (let i = 1; i < buf.length; i++) d.lineTo(i * sw, ((buf[i] - 128) / 128) * (h / 2) + h / 2);
	d.strokeStyle = COLOR_BRIGHT;
	d.lineWidth = 2;
	d.stroke();
}

/**
 * Renders a real-time audio visualizer using the Web Audio API and Canvas 2D.
 * Uses overlay mode so the canvas is absolutely positioned inside the nearest
 * positioned ancestor. A small toggle button cycles through four visualization
 * modes.
 */
export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({ audioEl }) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const [modeIndex, setModeIndex] = useState(3);
	const modeIndexRef = useRef(modeIndex);
	modeIndexRef.current = modeIndex;

	// biome-ignore lint/correctness/useExhaustiveDependencies: modeIndex intentionally excluded — read each frame via ref
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !audioEl) return;

		// Get or create the shared capture (source → gain → destination) for
		// this element — audioCapture.ts owns it so StationPlayer can silence
		// captured elements in-graph. The gain path to the speakers persists
		// when the visualizer is stopped or recreated between renders.
		const entry = captureAudioElement(audioEl);
		if (!entry) return;
		entry.ctx.resume().catch(() => {});
		const stopKeepAlive = keepAudioContextAlive(entry.ctx);

		// Tap post-gain so the waveform reflects what is actually audible —
		// a muted or un-soloed clip draws flat instead of dancing silently.
		const { gain } = entry;

		const analyser = entry.ctx.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = 0.8;
		gain.connect(analyser);

		const canvas = document.createElement("canvas");
		canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;";
		container.appendChild(canvas);

		const resize = () => {
			canvas.width = container.clientWidth;
			canvas.height = container.clientHeight;
		};
		resize();
		const ro = new ResizeObserver(resize);
		ro.observe(container);

		const ctx2d = canvas.getContext("2d");
		if (!ctx2d) {
			canvas.remove();
			ro.disconnect();
			stopKeepAlive();
			return;
		}

		let rafId: number;
		const draw = () => {
			rafId = requestAnimationFrame(draw);
			const w = canvas.width;
			const h = canvas.height;
			if (w === 0 || h === 0) return;
			const mode = VIZ_MODES[modeIndexRef.current].label;
			if (mode === "Bars") drawBars(ctx2d, analyser, w, h);
			else if (mode === "Spectrum") drawSpectrum(ctx2d, analyser, w, h);
			else if (mode === "Radial") drawRadial(ctx2d, analyser, w, h);
			else drawWave(ctx2d, analyser, w, h);
		};
		draw();

		return () => {
			cancelAnimationFrame(rafId);
			ro.disconnect();
			// Remove canvas before stopping so StrictMode's double-invoke doesn't
			// leave a stale canvas when the effect re-runs.
			canvas.remove();
			gain.disconnect(analyser);
			stopKeepAlive();
		};
	}, [audioEl]);

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
					pointerEvents: "auto",
					opacity: 0.5,
					background: "transparent",
					border: "none",
					cursor: "pointer",
					fontSize: "0.7em",
					fontFamily: "var(--ui-font)",
					color: "var(--color-theme-02, rgba(0, 210, 90, 0.8))",
					padding: "2px 4px",
					zIndex: 999,
				}}
			>
				{VIZ_MODES[modeIndex].label}
			</button>
		</div>
	);
};
