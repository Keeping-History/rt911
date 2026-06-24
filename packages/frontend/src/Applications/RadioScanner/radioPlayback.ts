// Single source of truth for which radio stations may have audio playing.
//
// The Radio Scanner has two modes:
//   - Scan mode: the user hand-picks a grid of stations that all play together.
//   - Single-station mode (default): exactly one station — the active one —
//     plays, so switching stations must silence the previous one.
//
// Playback was previously gated only by the `muted` prop, which never paused the
// previous element (and React does not reliably re-apply `muted` on re-render),
// so the old station kept playing after a switch. Centralising the rule here and
// pausing everything it excludes is what enforces "one station at a time".
export interface PlaybackSelection {
	scannerMode: boolean;
	activeStation: number;
	selectedStations: number[];
}

export function shouldStationPlay(sel: PlaybackSelection, id: number): boolean {
	return sel.scannerMode
		? sel.selectedStations.includes(id)
		: id === sel.activeStation;
}
