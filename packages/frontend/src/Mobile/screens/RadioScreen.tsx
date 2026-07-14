// packages/frontend/src/Mobile/screens/RadioScreen.tsx
// The mobile Radio menu: same station list as the desktop RadioScanner strip
// (pinned stations first, then online, then offline), driven by the wheel
// and by direct taps. Selecting an on-air station tunes it and pushes Now
// Playing (Task 11).
import { useContext, useMemo, useState } from "react";
import {
	activeSegments,
	sortStations,
	type Station,
} from "../../Applications/RadioScanner/stationGrouping";
import { IpodList } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";

interface RadioScreenProps {
	stations: Station[];
	nowMs: number;
	activeStationKey: string;
	onTune: (key: string) => void;
	/** WebSocket state — the station list is stream-fed, so show Connecting… until up. */
	connected: boolean;
}

export function RadioScreen({
	stations,
	nowMs,
	activeStationKey,
	onTune,
	connected,
}: RadioScreenProps) {
	const { push } = useContext(ScreenNavContext);
	const sorted = useMemo(() => sortStations(stations, nowMs), [stations, nowMs]);
	// Track the highlight by station KEY, not index: sortStations re-buckets
	// stations as they come on/off air (nowMs ticks every second), so an index
	// would silently point at a different station after a reshuffle. The
	// desktop RadioScanner tracks selection by key for the same reason.
	const [selectedKey, setSelectedKey] = useState<string>(
		() => activeStationKey || sorted[0]?.key || "",
	);
	const selectedIndex = Math.max(
		0,
		sorted.findIndex((s) => s.key === selectedKey),
	);

	const items = sorted.map((s) => {
		const onAir = activeSegments(s, nowMs).length > 0;
		return {
			key: s.key,
			label: s.label,
			value: s.key === activeStationKey ? "▶" : onAir ? undefined : "offline",
			disabled: !onAir,
		};
	});

	const select = (i: number) => {
		const station = sorted[i];
		if (station) setSelectedKey(station.key);
	};

	const activate = (i: number) => {
		if (!items[i] || items[i].disabled) return;
		onTune(sorted[i].key);
		push("nowPlaying");
	};

	useScreenWheel({
		onScroll: (steps) =>
			select(Math.max(0, Math.min(sorted.length - 1, selectedIndex + steps))),
		onSelect: () => activate(selectedIndex),
	});

	// The station catalogue arrives over the stream; until the socket is up
	// there is nothing tunable. Only this screen gates on the connection —
	// the rest of the shell works stream-free.
	if (!connected) {
		return (
			<div className="ipodTextScreen ipodCenter">
				<div className="ipodBigTime">…</div>
				<p>Connecting…</p>
			</div>
		);
	}

	return (
		<IpodList
			items={items}
			selectedIndex={selectedIndex}
			onSelectedIndexChange={select}
			onActivate={activate}
		/>
	);
}
