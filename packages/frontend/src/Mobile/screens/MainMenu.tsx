// packages/frontend/src/Mobile/screens/MainMenu.tsx
import { useAppManager } from "classicy";
import { useContext, useState } from "react";
import { IpodList, type IpodListItem } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";
import type { ScreenId } from "../screenStack";

interface MainMenuProps {
	/** Now Playing is only reachable once a radio station or TV channel is tuned. */
	hasNowPlaying: boolean;
}

export function MainMenu({ hasNowPlaying }: MainMenuProps) {
	const { push } = useContext(ScreenNavContext);
	const [selectedIndex, setSelectedIndex] = useState(0);
	// While the server forces the clock, Time Travel (and everything reachable
	// from it — Bookmarks, Scrub) can't be used to move the clock.
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);

	const entries: Array<IpodListItem & { target: ScreenId }> = [
		{ key: "radio", label: "Radio", arrow: true, target: "radio" },
		{ key: "tv", label: "TV", arrow: true, target: "tv" },
		{
			key: "timeTravel",
			label: "Time Travel",
			arrow: true,
			target: "timeTravel",
			disabled: dateTimeLocked,
		},
		{
			key: "nowPlaying",
			label: "Now Playing",
			arrow: true,
			target: "nowPlaying",
			disabled: !hasNowPlaying,
		},
		{ key: "about", label: "About", arrow: true, target: "about" },
	];

	const activate = (i: number) => {
		if (!entries[i].disabled) push(entries[i].target);
	};

	useScreenWheel({
		onScroll: (steps) =>
			setSelectedIndex((i) => Math.max(0, Math.min(entries.length - 1, i + steps))),
		onSelect: () => activate(selectedIndex),
	});

	return (
		<IpodList
			items={entries}
			selectedIndex={selectedIndex}
			onSelectedIndexChange={setSelectedIndex}
			onActivate={activate}
		/>
	);
}
