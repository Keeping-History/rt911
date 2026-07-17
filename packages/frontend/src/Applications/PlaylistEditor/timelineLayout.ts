import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";

export const TIMELINE_START_MS = Date.UTC(2001, 8, 9);
export const TIMELINE_END_MS = Date.UTC(2001, 8, 19);
const SPAN = TIMELINE_END_MS - TIMELINE_START_MS;

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
			const at = e.entry.start ?? e.timelineMeta?.publishedAt ?? null;
			const hasWindow = Boolean(e.entry.start && e.entry.end);
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
