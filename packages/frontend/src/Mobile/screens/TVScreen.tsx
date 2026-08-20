// packages/frontend/src/Mobile/screens/TVScreen.tsx
// The mobile TV menu: every approved HLS channel in the stream, driven by the
// wheel and by direct taps. Selecting a channel tunes it and pushes Now
// Playing — the shell-level TvPlayer carries the picture, which is what keeps
// the audio alive when the user backs out with MENU.
import { useContext, useMemo, useState } from "react";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { IpodList } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";

interface TVScreenProps {
	channels: MediaItem[];
	activeTvId: number | null;
	onTune: (id: number) => void;
	/** WebSocket state — the channel list is stream-fed, so show Connecting… until up. */
	connected: boolean;
}

export function TVScreen({ channels, activeTvId, onTune, connected }: TVScreenProps) {
	const { push } = useContext(ScreenNavContext);
	const sorted = useMemo(
		() =>
			[...channels].sort((a, b) =>
				(a.source ?? "").localeCompare(b.source ?? ""),
			),
		[channels],
	);
	// Track the highlight by item ID, not index: channels come and go as the
	// virtual clock moves through the archive (same reasoning as RadioScreen's
	// station keys).
	const [selectedId, setSelectedId] = useState<number>(
		() => activeTvId ?? sorted[0]?.id ?? -1,
	);
	const selectedIndex = Math.max(
		0,
		sorted.findIndex((c) => c.id === selectedId),
	);

	const items = sorted.map((c) => ({
		key: String(c.id),
		label: c.source ?? c.title,
		value: c.id === activeTvId ? "▶" : undefined,
	}));

	const select = (i: number) => {
		const chan = sorted[i];
		if (chan) setSelectedId(chan.id);
	};

	const activate = (i: number) => {
		const chan = sorted[i];
		if (!chan) return;
		onTune(chan.id);
		push("nowPlaying");
	};

	useScreenWheel({
		onScroll: (steps) =>
			select(Math.max(0, Math.min(sorted.length - 1, selectedIndex + steps))),
		onSelect: () => activate(selectedIndex),
	});

	// The channel catalogue arrives over the stream; until the socket is up
	// there is nothing tunable (mirrors RadioScreen).
	if (!connected) {
		return (
			<div className="ipodTextScreen ipodCenter">
				<div className="ipodBigTime">…</div>
				<p>Connecting…</p>
			</div>
		);
	}

	if (sorted.length === 0) {
		return (
			<div className="ipodTextScreen ipodCenter">
				<p className="ipodDim">No channels on air.</p>
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
