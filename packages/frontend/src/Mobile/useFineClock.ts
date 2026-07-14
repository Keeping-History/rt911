// Sub-minute virtual clock for the mobile shell — the RadioScanner fine-clock
// pattern (see Applications/RadioScanner/RadioScanner.tsx): classicy's stored
// dateTime advances once per minute, so add the real time elapsed since its
// last change to recover seconds. nowMs is a UTC epoch — compare it directly
// against item start_dates (never against display localDate values).
import { useClassicyDateTime } from "classicy";
import { useCallback, useEffect, useRef, useState } from "react";

export interface FineClock {
	nowMs: number;
	getNowMs: () => number;
	clockPaused: boolean;
	tzOffset: number;
}

export function useFineClock(): FineClock {
	const { dateTime, paused: clockPaused, tzOffset } = useClassicyDateTime();

	const dateTimeRef = useRef(dateTime);
	dateTimeRef.current = dateTime;
	const clockPausedRef = useRef(clockPaused);
	clockPausedRef.current = clockPaused;
	const dateTimeUpdatedAtRef = useRef<number>(Date.now());
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
	useEffect(() => {
		dateTimeUpdatedAtRef.current = Date.now();
	}, [dateTime]);

	const getNowMs = useCallback(() => {
		const elapsed = clockPausedRef.current
			? 0
			: Date.now() - dateTimeUpdatedAtRef.current;
		return new Date(dateTimeRef.current).getTime() + elapsed;
	}, []);

	// Re-render every second so nowMs tracks the clock at ~1s resolution.
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, []);

	return { nowMs: getNowMs(), getNowMs, clockPaused, tzOffset: Number(tzOffset) };
}
