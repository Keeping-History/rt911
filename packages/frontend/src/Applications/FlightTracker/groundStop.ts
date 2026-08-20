// FAA nationwide ground stop, as replayed by the virtual clock. Both instants
// are true UTC (the virtual clock's native form — see virtualClock.ts).
//
// 13:26 UTC / 9:26 a.m. EDT, September 11: FAA national operations manager
// Ben Sliney orders a nationwide ground stop of all civilian aircraft.
export const GROUND_STOP_START_MS = Date.UTC(2001, 8, 11, 13, 26);

// 15:00 UTC / 11:00 a.m. EDT, September 13: the FAA reopens national airspace
// to commercial aviation.
export const GROUND_STOP_END_MS = Date.UTC(2001, 8, 13, 15, 0);

// How long the "lifted" notice lingers in the status bar after reopening.
export const LIFTED_NOTICE_MS = 60 * 60_000;

export type GroundStopStatus = "none" | "active" | "lifted";

export function groundStopStatus(nowMs: number): GroundStopStatus {
	if (nowMs >= GROUND_STOP_START_MS && nowMs < GROUND_STOP_END_MS) return "active";
	if (nowMs >= GROUND_STOP_END_MS && nowMs < GROUND_STOP_END_MS + LIFTED_NOTICE_MS)
		return "lifted";
	return "none";
}
