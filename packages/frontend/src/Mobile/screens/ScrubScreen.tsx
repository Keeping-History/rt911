// packages/frontend/src/Mobile/screens/ScrubScreen.tsx
// The wheel becomes the time dial: one step = one minute, center-click
// commits, MENU (handled by the shell) abandons the scrub. The anchor is the
// clock value at mount — the display target doesn't drift while you dial.
import { useAppManager, useClassicyDateTime } from "classicy";
import { useContext, useRef, useState } from "react";
import {
	formatUtcAsLocalTime,
	setDateTimeFromUtc,
} from "../../Applications/TimeMachine/setVirtualClock";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";

interface ScrubScreenProps {
	getNowMs: () => number;
	tzOffset: number;
}

export function ScrubScreen({ getNowMs, tzOffset }: ScrubScreenProps) {
	const { setDateTime } = useClassicyDateTime();
	const { pop } = useContext(ScreenNavContext);
	const anchorMsRef = useRef(getNowMs());
	const [pendingMinutes, setPendingMinutes] = useState(0);
	// Belt-and-suspenders alongside the shell's reactive eviction: gate the
	// write itself so a wheel-select landing in the sub-frame window between
	// the lock committing and the shell's eviction effect can't move the clock.
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);

	const targetMs = anchorMsRef.current + pendingMinutes * 60_000;

	useScreenWheel({
		onScroll: (steps) => setPendingMinutes((m) => m + steps),
		onSelect: () => {
			if (dateTimeLocked) return;
			setDateTimeFromUtc(setDateTime, new Date(targetMs).toISOString());
			pop();
		},
	});

	const sign = pendingMinutes >= 0 ? "+" : "-";
	return (
		<div className="ipodTextScreen ipodCenter">
			<p className="ipodDim">Turn the wheel to travel</p>
			<div className="ipodBigTime">
				{formatUtcAsLocalTime(new Date(targetMs).toISOString(), tzOffset)}
			</div>
			<p>{`${sign}${Math.abs(pendingMinutes)} min`}</p>
			<p className="ipodDim">Press center to jump · MENU to cancel</p>
		</div>
	);
}
