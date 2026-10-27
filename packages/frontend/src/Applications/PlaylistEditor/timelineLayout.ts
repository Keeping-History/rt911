import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import { type EditorEntry, utcIsoToDisplayWallClock } from "./editorState";

export const TIMELINE_START_MS = Date.UTC(2001, 8, 9);
export const TIMELINE_END_MS = Date.UTC(2001, 8, 19);
const SPAN = TIMELINE_END_MS - TIMELINE_START_MS;
const SPAN_HOURS = SPAN / 3_600_000; // 240
const HOUR_MS = 3_600_000;

/** What the timeline maps to 0%…100%. Defaults to the full ten-day span. */
export type TimelineBounds = { startMs: number; endMs: number };

export const FULL_BOUNDS: TimelineBounds = {
	startMs: TIMELINE_START_MS,
	endMs: TIMELINE_END_MS,
};

/**
 * Bounds for a playlist-level window: the timeline rescales to show just the
 * window, rounded OUTWARD to whole hours so ruler ticks stay on round times.
 * A missing bound keeps the full span's edge; a degenerate result (window
 * outside the span, or inverted — the editor prevents both, but stored data
 * is untrusted) falls back to the full span rather than dividing by zero.
 */
export function timelineBounds(start?: string, end?: string): TimelineBounds {
	const startMs =
		start === undefined
			? TIMELINE_START_MS
			: Math.max(TIMELINE_START_MS, Math.floor(playlistUtcMs(start) / HOUR_MS) * HOUR_MS);
	const endMs =
		end === undefined
			? TIMELINE_END_MS
			: Math.min(TIMELINE_END_MS, Math.ceil(playlistUtcMs(end) / HOUR_MS) * HOUR_MS);
	if (endMs <= startMs) return FULL_BOUNDS;
	return { startMs, endMs };
}

const boundsSpanHours = (b: TimelineBounds): number => (b.endMs - b.startMs) / HOUR_MS;

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
 * Targets a constant *on-screen* density: ~40 ticks across the track at 1×
 * (for the full span that is a 6-hour tick every 2.5%, the density the ruler
 * was designed around), so the aim is span/40/zoom hours. The ladder floor
 * (0.25h) caps the tick count at 960 for the full span no matter how far in
 * you zoom — past that the marks are denser than the eye can use, and the DOM
 * cost is real because the whole span is rendered.
 */
export function tickIntervalHours(zoom: number, spanHours = SPAN_HOURS): number {
	const target = spanHours / 40 / Math.max(1, zoom);
	return NICE_TICK_HOURS.find((h) => h <= target) ?? NICE_TICK_HOURS[NICE_TICK_HOURS.length - 1];
}

// A bounds span is whole hours but not necessarily divisible by the interval;
// epsilon keeps `i * interval < spanHours` honest against float accumulation.
const stepsBefore = (spanHours: number, interval: number): number =>
	Math.ceil(spanHours / interval - 1e-9);

/** Unlabelled tick positions, as percentages of the track. */
export function rulerTicks(zoom: number, bounds: TimelineBounds = FULL_BOUNDS): number[] {
	const spanHours = boundsSpanHours(bounds);
	const interval = tickIntervalHours(zoom, spanHours);
	// End-exclusive: the closing boundary carries a label instead of a bare tick.
	const count = stepsBefore(spanHours, interval);
	return Array.from({ length: count }, (_, i) => (i * interval * 100) / spanHours);
}

export type RulerLabel = { leftPct: number; text: string };

/**
 * Labelled positions, as percentages of the track.
 *
 * At 1× on the full span this is exactly eleven `M/D` day labels (`9/9` …
 * `9/19` — no leading zeros, to keep the crowded ruler as narrow as
 * possible). Zoomed in — or on a playlist-window span too short for day
 * boundaries — labels subdivide with the ticks and switch to clock times,
 * because day boundaries alone can leave a viewport with no visible
 * reference at all. The closing bound always gets a label of its own, even
 * when the label interval does not divide the span.
 */
export function rulerLabels(zoom: number, bounds: TimelineBounds = FULL_BOUNDS): RulerLabel[] {
	const spanHours = boundsSpanHours(bounds);
	const interval = tickIntervalHours(zoom, spanHours) * LABEL_EVERY_N_TICKS;
	const count = stepsBefore(spanHours, interval);
	const hourMarks = Array.from({ length: count }, (_, i) => i * interval);
	return [...hourMarks, spanHours].map((hours) => {
		const d = new Date(bounds.startMs + hours * 3_600_000);
		// Keep the date visible at day boundaries even in clock-time mode, so a
		// zoomed viewport is never ambiguous about which day it is showing. The
		// check is against absolute midnight, not offset-from-start: a playlist
		// window can start mid-day.
		const atMidnight = (bounds.startMs + hours * 3_600_000) % 86_400_000 === 0;
		const text =
			interval >= 24 || atMidnight
				? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
				: d.toISOString().slice(11, 16);
		return { leftPct: (hours * 100) / spanHours, text };
	});
}

/**
 * A UTC instant as a fraction of the timeline bounds, UNCLAMPED.
 *
 * Anything laid out as a percentage inside the track is in this space — the
 * track is `zoom * 100%` wide and every child positions against it, so a
 * fraction here is the one unit that stays meaningful at every zoom level.
 * Unclamped because a *span* (a recording overlapping the bounds, say) has to
 * keep its true width: clamping one end would silently stretch or squash it.
 * {@link timeToFraction} clamps, because a bar's own bounds are meant to.
 */
export function msToFraction(ms: number, bounds: TimelineBounds = FULL_BOUNDS): number {
	return (ms - bounds.startMs) / (bounds.endMs - bounds.startMs);
}

export function timeToFraction(iso: string, bounds: TimelineBounds = FULL_BOUNDS): number {
	return Math.min(1, Math.max(0, msToFraction(playlistUtcMs(iso), bounds)));
}

/** The inverse of {@link timeToFraction}: a track fraction back to a UTC ms instant. */
export function fractionToMs(frac: number, bounds: TimelineBounds = FULL_BOUNDS): number {
	return bounds.startMs + frac * (bounds.endMs - bounds.startMs);
}

// Edge drags snap to whole minutes: finer precision is invisible at any zoom
// level, and it keeps the committed ISO strings as round as hand-entered ones.
const DRAG_SNAP_MS = 60_000;

/**
 * Where an edge drag at track-fraction `frac` lands, as a virtual-clock UTC
 * ISO string: snapped to the minute, kept inside the timeline bounds, and held
 * at least one snap step away from the entry's opposite bound so a drag can
 * never invert the window. `opposite` may be absent (unbounded edge), in which
 * case the timeline bound stands in for it.
 */
export function dragEdgeIso(
	edge: "start" | "end",
	frac: number,
	bounds: TimelineBounds = FULL_BOUNDS,
	opposite?: string,
): string {
	const raw = bounds.startMs + Math.min(1, Math.max(0, frac)) * (bounds.endMs - bounds.startMs);
	let ms = snapMs(raw);
	const oppMs = opposite === undefined ? undefined : playlistUtcMs(opposite);
	if (edge === "start") {
		ms = Math.min(ms, (oppMs ?? bounds.endMs) - DRAG_SNAP_MS);
		ms = Math.max(ms, bounds.startMs);
	} else {
		ms = Math.max(ms, (oppMs ?? bounds.startMs) + DRAG_SNAP_MS);
		ms = Math.min(ms, bounds.endMs);
	}
	return new Date(ms).toISOString();
}

const snapMs = (ms: number): number => Math.round(ms / DRAG_SNAP_MS) * DRAG_SNAP_MS;

/**
 * Where a whole-bar drag lands: both bounds carried by `deltaMs`, the start
 * snapped to the minute and the end following it by the window's exact
 * duration, so a move never changes how long the window is. The delta is
 * first clamped so no bound leaves the timeline bounds — the window parks
 * against the edge instead of being pushed past it.
 *
 * An unbounded edge stays unbounded: only the bound that exists moves. With
 * neither bound there is nothing to move, and the result is null so the
 * caller can leave the entry alone.
 */
export function shiftWindow(
	start: string | undefined,
	end: string | undefined,
	deltaMs: number,
	bounds: TimelineBounds = FULL_BOUNDS,
): { start: string | undefined; end: string | undefined } | null {
	const startMs = start === undefined ? undefined : playlistUtcMs(start);
	const endMs = end === undefined ? undefined : playlistUtcMs(end);
	if (startMs === undefined && endMs === undefined) return null;
	let delta = deltaMs;
	if (startMs !== undefined) delta = Math.max(delta, bounds.startMs - startMs);
	if (endMs !== undefined) delta = Math.min(delta, bounds.endMs - endMs);
	if (startMs !== undefined) {
		const movedStart = snapMs(startMs + delta);
		return {
			start: new Date(movedStart).toISOString(),
			end: endMs === undefined ? undefined : new Date(movedStart + (endMs - startMs)).toISOString(),
		};
	}
	return { start: undefined, end: new Date(snapMs((endMs as number) + delta)).toISOString() };
}

/** The window a right-click inserts: half an hour, the span of a typical
 * class segment, which the user then drags or edits to fit. */
export const INSERT_WINDOW_MS = 30 * 60_000;

/**
 * A fresh window opening at the minute under track-fraction `frac`, running
 * {@link INSERT_WINDOW_MS}. Near the end of the track the window slides back so
 * it still fits; past the start it opens at the start.
 */
export function insertWindowAt(
	frac: number,
	bounds: TimelineBounds = FULL_BOUNDS,
	durationMs = INSERT_WINDOW_MS,
): { start: string; end: string } {
	const span = bounds.endMs - bounds.startMs;
	const length = Math.min(durationMs, span);
	let startMs = snapMs(bounds.startMs + Math.min(1, Math.max(0, frac)) * span);
	startMs = Math.max(bounds.startMs, Math.min(startMs, bounds.endMs - length));
	return {
		start: new Date(startMs).toISOString(),
		end: new Date(startMs + length).toISOString(),
	};
}

/** What a bar drag grabbed: an edge handle or the body, and the entry's
 * committed window at the press. */
export type DragGrab = { mode: "start" | "end" | "move"; start?: string; end?: string };

/** The insert item's title, on the display clock the Settings window and
 * entry rows use (not the ruler's UTC). */
export function insertMenuTitle(label: string, startIso: string, endIso: string): string {
	const clock = (iso: string) => {
		const w = utcIsoToDisplayWallClock(iso);
		return `${String(w.getHours()).padStart(2, "0")}:${String(w.getMinutes()).padStart(2, "0")}`;
	};
	return `Insert ${label} ${clock(startIso)}–${clock(endIso)}`;
}

/**
 * The window a drag previews once it is past the dead zone: the grabbed edge
 * (or both bounds, for a move) carried by `deltaMs` with the same snapping and
 * clamping the commit will apply. An unbounded edge being dragged starts from
 * the timeline bound it is drawn at.
 */
export function dragPreview(
	drag: DragGrab,
	deltaMs: number,
	bounds: TimelineBounds = FULL_BOUNDS,
): { start?: string; end?: string } | null {
	if (drag.mode === "move") return shiftWindow(drag.start, drag.end, deltaMs, bounds);
	const grabbed = drag.mode === "start" ? drag.start : drag.end;
	const fromMs =
		grabbed === undefined
			? drag.mode === "start" ? bounds.startMs : bounds.endMs
			: playlistUtcMs(grabbed);
	const iso = dragEdgeIso(
		drag.mode,
		msToFraction(fromMs + deltaMs, bounds),
		bounds,
		drag.mode === "start" ? drag.end : drag.start,
	);
	return drag.mode === "start" ? { start: iso, end: drag.end } : { start: drag.start, end: iso };
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

export function layoutBars(
	entries: EditorEntry[],
	bounds: TimelineBounds = FULL_BOUNDS,
): TimelineBar[] {
	const bars: TimelineBar[] = [];
	for (const group of BAR_GROUPS) {
		for (const e of entries) {
			if (e.entry.kind !== "media" || e.entry.app !== group) continue;
			const bar: TimelineBar = {
				uid: e.uid,
				label: e.entry.itemId,
				group,
				startFrac: e.entry.start ? timeToFraction(e.entry.start, bounds) : 0,
				endFrac: e.entry.end ? timeToFraction(e.entry.end, bounds) : 1,
				fadeStart: !e.entry.start,
				fadeEnd: !e.entry.end,
				focus: e.entry.focus,
			};
			if (group === "flights") {
				if (e.timelineMeta?.departure) bar.actualStartFrac = timeToFraction(e.timelineMeta.departure, bounds);
				if (e.timelineMeta?.arrival) bar.actualEndFrac = timeToFraction(e.timelineMeta.arrival, bounds);
			}
			bars.push(bar);
		}
	}
	return bars;
}

export function layoutFlags(
	entries: EditorEntry[],
	minGapFrac = 0.015,
	bounds: TimelineBounds = FULL_BOUNDS,
): TimelineFlag[] {
	const raw: Omit<TimelineFlag, "row">[] = [];
	for (const e of entries) {
		if (e.entry.kind === "media" && e.entry.app === "news") {
			const hasWindow = Boolean(e.entry.start && e.entry.end);
			const at = hasWindow ? e.entry.start : (e.timelineMeta?.publishedAt ?? e.entry.start ?? null);
			raw.push({
				uid: e.uid,
				label: e.entry.itemId,
				kindGlyph: "news",
				atFrac: at ? timeToFraction(at, bounds) : 0,
				extentEndFrac: hasWindow && e.entry.end ? timeToFraction(e.entry.end, bounds) : undefined,
			});
		} else if (e.entry.kind === "jump" && e.entry.at) {
			raw.push({ uid: e.uid, label: "Jump", kindGlyph: "jump", atFrac: timeToFraction(e.entry.at, bounds) });
		} else if (e.entry.kind === "file" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.path.split(":").pop() ?? e.entry.path, kindGlyph: "file", atFrac: timeToFraction(e.entry.at, bounds) });
		} else if (e.entry.kind === "browser" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.url, kindGlyph: "browser", atFrac: timeToFraction(e.entry.at, bounds) });
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
