// The iPod's signature screen. Audio itself is mounted by IpodShell
// (StationPlayer / TvPlayer) so it keeps playing when the user navigates
// away — this screen is pure display. For TV, the picture is the shell-level
// TvPlayer sitting in flex flow directly above this screen; this screen is
// the caption strip below it.
import {
	activeSegments,
	primarySegment,
	startTimeLabel,
	type Station,
} from "../../Applications/RadioScanner/stationGrouping";
import { formatUtcAsLocalTime } from "../../Applications/TimeMachine/setVirtualClock";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

interface NowPlayingScreenProps {
	station: Station | null;
	/** The tuned TV channel; the shell guarantees station XOR tvChannel. */
	tvChannel: MediaItem | null;
	nowMs: number;
	tzOffset: number;
	clockPaused: boolean;
}

export function NowPlayingScreen({
	station,
	tvChannel,
	nowMs,
	tzOffset,
	clockPaused,
}: NowPlayingScreenProps) {
	const clock = formatUtcAsLocalTime(new Date(nowMs).toISOString(), tzOffset);

	if (tvChannel) {
		return (
			<div className="ipodTextScreen">
				<div className="ipodMarquee ipodCenter">
					{tvChannel.source ?? tvChannel.title}
				</div>
				<div className="ipodBigTime">{clock}</div>
				{clockPaused && <p className="ipodDim ipodCenter">paused</p>}
			</div>
		);
	}

	if (!station) {
		return (
			<div className="ipodTextScreen ipodCenter">
				<p className="ipodDim">Choose a station in Radio or a channel in TV.</p>
			</div>
		);
	}

	const primary = primarySegment(activeSegments(station, nowMs));

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
