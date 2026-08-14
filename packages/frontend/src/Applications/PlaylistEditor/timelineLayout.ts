import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";

export const TIMELINE_START_MS = Date.UTC(2001, 8, 9);
export const TIMELINE_END_MS = Date.UTC(2001, 8, 19);
const SPAN = TIMELINE_END_MS - TIMELINE_START_MS;
const SPAN_HOURS = SPAN / 3_600_000; // 240

/* ── Zoom ──────────────────────────────────────────────────────────────────
 * Zoom widens the track rather than re-mapping time to fractions: every
 * position stays a fraction of the full 10-day span, and the rendered track is
 * `zoom * 100%` wide inside a horizontally scrolling viewport. Two things fall
 * out of that choice — every existing layout calculation is untouched, and
 * panning is just the browser's own scrolling, with no pan control to build.
 *
 * The cost is that the whole span is always in the DOM, which is why the tick
 * interval has a floor (see tickIntervalHours): without one, deep zoom would
 * emit tens of thousands of tick nodes for a viewport showing a few dozen.
 */
export const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64] as const;
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/**
 * Coerce a persisted zoom to a real ladder level.
 *
 * The stored value round-trips through localStorage, so it can be anything a
 * hand-edit or a stale schema left behind — a string, NaN, 0, a level from a
 * future ladder. Anything unusable falls back to 1× rather than propagating a
 * bad width into `${zoom * 100}%`.
 */
export function normalizeZoom(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return MIN_ZOOM;
	if (ZOOM_LEVELS.includes(value as (typeof ZOOM_LEVELS)[number])) return value;
	// Off-ladder but usable: snap to the nearest level so an old stored value
	// still lands somewhere sensible instead of resetting to fully zoomed out.
	if (value < MIN_ZOOM) return MIN_ZOOM;
	if (value > MAX_ZOOM) return MAX_ZOOM;
	return ZOOM_LEVELS.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
}

/** The next level in/out, clamped at the ends so callers need no bounds check. */
export function steppedZoom(zoom: number, direction: 1 | -1): number {
	const i = ZOOM_LEVELS.indexOf(zoom as (typeof ZOOM_LEVELS)[number]);
	// An off-ladder value (older persisted state, say) snaps to the nearest level
	// rather than refusing to move.
	if (i === -1) {
		const nearest = ZOOM_LEVELS.reduce((a, b) =>
			Math.abs(b - zoom) < Math.abs(a - zoom) ? b : a,
		);
		return nearest;
	}
	return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + direction))];
}

// Coarse→fine. Every value is a divisor of 24h and 4× each is still a round
// interval, which is what lets the label ladder below stay readable.
const NICE_TICK_HOURS = [6, 3, 1, 0.5, 0.25];
const LABEL_EVERY_N_TICKS = 4;

/**
 * Tick spacing for a zoom level, in hours.
 *
 * Targets a constant *on-screen* density: at 1× a 6-hour tick sits 2.5% of the
 * track apart, which is the density the ruler was designed around, so the aim
 * is 6/zoom hours. The ladder floor (0.25h) caps the tick count at 960 for the
 * full span no matter how far in you zoom — past that the marks are denser than
 * the eye can use, and the DOM cost is real because the whole span is rendered.
 */
export function tickIntervalHours(zoom: number): number {
	const target = 6 / Math.max(1, zoom);
	return NICE_TICK_HOURS.find((h) => h <= target) ?? NICE_TICK_HOURS[NICE_TICK_HOURS.length - 1];
}

/** Unlabelled tick positions, as percentages of the track. */
export function rulerTicks(zoom: number): number[] {
	const interval = tickIntervalHours(zoom);
	const count = Math.round(SPAN_HOURS / interval);
	// End-exclusive: the closing boundary carries a label instead of a bare tick.
	return Array.from({ length: count }, (_, i) => (i * interval * 100) / SPAN_HOURS);
}

export type RulerLabel = { leftPct: number; text: string };

/**
 * Labelled positions, as percentages of the track.
 *
 * At 1× this is exactly the eleven `MM-DD` day labels the ruler has always
 * shown. Zoomed in, labels subdivide with the ticks and switch to clock times,
 * because day boundaries alone can leave a zoomed viewport with no visible
 * reference at all — at 64× a viewport spans under four hours.
 */
export function rulerLabels(zoom: number): RulerLabel[] {
	const interval = tickIntervalHours(zoom) * LABEL_EVERY_N_TICKS;
	const count = Math.round(SPAN_HOURS / interval);
	return Array.from({ length: count + 1 }, (_, i) => {
		const hours = i * interval;
		const iso = new Date(TIMELINE_START_MS + hours * 3_600_000).toISOString();
		// Keep the date visible at day boundaries even in clock-time mode, so a
		// zoomed viewport is never ambiguous about which day it is showing.
		const atMidnight = hours % 24 === 0;
		const text = interval >= 24 || atMidnight ? iso.slice(5, 10) : iso.slice(11, 16);
		return { leftPct: (hours * 100) / SPAN_HOURS, text };
	});
}

export function timeToFraction(iso: string): number {
	const frac = (playlistUtcMs(iso) - TIMELINE_START_MS) / SPAN;
	return Math.min(1, Math.max(0, frac));
}

export type TimelineBar = {
	uid: string; label: string; group: "tv" | "radio" | "flights";
	startFrac: number; endFrac: number; fadeStart: boolean; fadeEnd: boolean;
	focus?: "once" | "locked"; actualStartFrac?: number; actualEndFrac?: number;
};

export type TimelineFlag = {
	uid: string; label: string; kindGlyph: "news" | "jump" | "file" | "browser";
	atFrac: number; extentEndFrac?: number; row: number;
};

const BAR_GROUPS = ["tv", "radio", "flights"] as const;

export function layoutBars(entries: EditorEntry[]): TimelineBar[] {
	const bars: TimelineBar[] = [];
	for (const group of BAR_GROUPS) {
		for (const e of entries) {
			if (e.entry.kind !== "media" || e.entry.app !== group) continue;
			const bar: TimelineBar = {
				uid: e.uid,
				label: e.entry.itemId,
				group,
				startFrac: e.entry.start ? timeToFraction(e.entry.start) : 0,
				endFrac: e.entry.end ? timeToFraction(e.entry.end) : 1,
				fadeStart: !e.entry.start,
				fadeEnd: !e.entry.end,
				focus: e.entry.focus,
			};
			if (group === "flights") {
				if (e.timelineMeta?.departure) bar.actualStartFrac = timeToFraction(e.timelineMeta.departure);
				if (e.timelineMeta?.arrival) bar.actualEndFrac = timeToFraction(e.timelineMeta.arrival);
			}
			bars.push(bar);
		}
	}
	return bars;
}

export function layoutFlags(entries: EditorEntry[], minGapFrac = 0.015): TimelineFlag[] {
	const raw: Omit<TimelineFlag, "row">[] = [];
	for (const e of entries) {
		if (e.entry.kind === "media" && e.entry.app === "news") {
			const hasWindow = Boolean(e.entry.start && e.entry.end);
			const at = hasWindow ? e.entry.start : (e.timelineMeta?.publishedAt ?? e.entry.start ?? null);
			raw.push({
				uid: e.uid,
				label: e.entry.itemId,
				kindGlyph: "news",
				atFrac: at ? timeToFraction(at) : 0,
				extentEndFrac: hasWindow && e.entry.end ? timeToFraction(e.entry.end) : undefined,
			});
		} else if (e.entry.kind === "jump" && e.entry.at) {
			raw.push({ uid: e.uid, label: "Jump", kindGlyph: "jump", atFrac: timeToFraction(e.entry.at) });
		} else if (e.entry.kind === "file" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.path.split(":").pop() ?? e.entry.path, kindGlyph: "file", atFrac: timeToFraction(e.entry.at) });
		} else if (e.entry.kind === "browser" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.url, kindGlyph: "browser", atFrac: timeToFraction(e.entry.at) });
		}
	}
	raw.sort((a, b) => a.atFrac - b.atFrac);
	const lastAtInRow: number[] = [];
	return raw.map((f) => {
		let row = 0;
		while (lastAtInRow[row] !== undefined && f.atFrac - lastAtInRow[row] < minGapFrac) row += 1;
		lastAtInRow[row] = f.atFrac;
		return { ...f, row };
	});
}
