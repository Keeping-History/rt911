import type { FlightPosition } from "../../Providers/MediaStream/MediaStreamContext";

// Shift-click toggle over the multi-selection list (issue #310). If `hit` is
// already selected (matched by flight callsign) it is removed; otherwise it is
// appended and becomes the active/shown entry. On removal the active index is
// shifted left when the removed entry sat at or before it, then clamped so the
// detail pane never points past the end (0 when the list empties).
export function toggleFlightSelection(
	current: FlightPosition[],
	hit: FlightPosition,
	activeIdx: number,
): { list: FlightPosition[]; activeIdx: number } {
	const i = current.findIndex((p) => p.flight === hit.flight);
	if (i >= 0) {
		const list = current.filter((_, j) => j !== i);
		const next = i <= activeIdx ? activeIdx - 1 : activeIdx;
		return { list, activeIdx: Math.max(0, Math.min(next, list.length - 1)) };
	}
	const list = [...current, hit];
	return { list, activeIdx: list.length - 1 };
}
