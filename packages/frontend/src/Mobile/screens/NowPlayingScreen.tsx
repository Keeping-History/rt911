// The iPod's signature screen. Audio itself is mounted by IpodShell
// (StationPlayer) so it keeps playing when the user navigates away —
// this screen is pure display.
import {
	activeSegments,
	primarySegment,
	startTimeLabel,
	type Station,
} from "../../Applications/RadioScanner/stationGrouping";
import { formatUtcAsLocalTime } from "../../Applications/TimeMachine/setVirtualClock";

interface NowPlayingScreenProps {
	station: Station | null;
	nowMs: number;
	tzOffset: number;
	clockPaused: boolean;
}

export function NowPlayingScreen({
	station,
	nowMs,
	tzOffset,
	clockPaused,
}: NowPlayingScreenProps) {
	if (!station) {
		return (
			<div className="ipodTextScreen ipodCenter">
				<p className="ipodDim">Choose a station in Radio.</p>
			</div>
		);
	}

	const primary = primarySegment(activeSegments(station, nowMs));
	const clock = formatUtcAsLocalTime(new Date(nowMs).toISOString(), tzOffset);

	return (
		<div className="ipodTextScreen">
			<div className="ipodMarquee ipodCenter">{station.label}</div>
			{primary ? (
				<>
					<p className="ipodCenter">{primary.full_title || primary.title}</p>
					<p className="ipodDim ipodCenter">
						started {startTimeLabel(primary, tzOffset)}
					</p>
				</>
			) : (
				<p className="ipodDim ipodCenter">— off air —</p>
			)}
			<div className="ipodBigTime">{clock}</div>
			{clockPaused && <p className="ipodDim ipodCenter">paused</p>}
		</div>
	);
}
