// packages/frontend/src/Mobile/screens/ScrubScreen.tsx
// The wheel becomes the time dial: one step = one minute, center-click
// commits, MENU (handled by the shell) abandons the scrub. The anchor is the
// clock value at mount — the display target doesn't drift while you dial.
import { useClassicyDateTime } from "classicy";
import { useContext, useRef, useState } from "react";
import { formatUtcAsLocalTime } from "../../Applications/TimeMachine/setVirtualClock";
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

	const targetMs = anchorMsRef.current + pendingMinutes * 60_000;

	useScreenWheel({
		onScroll: (steps) => setPendingMinutes((m) => m + steps),
		onSelect: () => {
			setDateTime(new Date(targetMs));
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
