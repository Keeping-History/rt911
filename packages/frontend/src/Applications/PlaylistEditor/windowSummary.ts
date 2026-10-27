import type { MediaEntry } from "../../Providers/Playlist/playlistTypes";
import { utcIsoToDisplayWallClock } from "./editorState";

/** `9/11 08:40` in display time (UTC-4): the same clock the tree rows use. */
function stamp(iso: string): { day: string; time: string } {
	const w = utcIsoToDisplayWallClock(iso);
	return {
		day: `${w.getMonth() + 1}/${w.getDate()}`,
		time: `${String(w.getHours()).padStart(2, "0")}:${String(w.getMinutes()).padStart(2, "0")}`,
	};
}

/**
 * A media entry's availability window as a short label, so several windows of
 * one item can be told apart in a card row or tree: `9/11 08:40–09:30` on one
 * day, `9/11 23:00–9/12 01:00` across midnight, `from 9/11 08:40` or
 * `until 9/11 09:30` with one bound, `always` with none. The date is always
 * present — the timeline spans ten days, and a bare `08:40` is ambiguous.
 */
export function windowSummary(entry: Pick<MediaEntry, "start" | "end">): string {
	const s = entry.start ? stamp(entry.start) : null;
	const e = entry.end ? stamp(entry.end) : null;
	if (s && e) {
		return s.day === e.day
			? `${s.day} ${s.time}–${e.time}`
			: `${s.day} ${s.time}–${e.day} ${e.time}`;
	}
	if (s) return `from ${s.day} ${s.time}`;
	if (e) return `until ${e.day} ${e.time}`;
	return "always";
}
