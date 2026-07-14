// Sub-minute virtual clock for the mobile shell, delegating to classicy's
// ticking clock hook — the same pattern MediaStreamProvider uses. localDate
// is a DISPLAY value (UTC shifted by tzOffset for the menu-bar clock);
// virtualUtcMs strips the offset back off to recover the true UTC instant
// (see Providers/MediaStream/virtualClock.ts — comparing localDate directly
// against wire timestamps is the classic tz bug). classicy owns the 1 Hz
// tick and the pause/resume/seek anchoring, which is what makes pause
// correct here even though the desktop menu-bar clock never mounts on
// mobile.
import { useClassicyDateTime } from "classicy";
import { useCallback, useRef } from "react";
import { virtualUtcMs } from "../Providers/MediaStream/virtualClock";

export interface FineClock {
	nowMs: number;
	getNowMs: () => number;
	clockPaused: boolean;
	tzOffset: number;
}

export function useFineClock(): FineClock {
	const {
		localDate,
		paused: clockPaused,
		tzOffset,
	} = useClassicyDateTime({ tick: true });
	const tz = Number(tzOffset);
	const nowMs = virtualUtcMs(localDate, tz);
	const nowMsRef = useRef(nowMs);
	nowMsRef.current = nowMs;
	const getNowMs = useCallback(() => nowMsRef.current, []);
	return { nowMs, getNowMs, clockPaused, tzOffset: tz };
}
