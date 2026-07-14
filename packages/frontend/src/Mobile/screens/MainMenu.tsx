// packages/frontend/src/Mobile/screens/MainMenu.tsx
import { useContext, useState } from "react";
import { IpodList, type IpodListItem } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";
import type { ScreenId } from "../screenStack";

interface MainMenuProps {
	/** Now Playing is only reachable once a station has been tuned. */
	hasActiveStation: boolean;
}

export function MainMenu({ hasActiveStation }: MainMenuProps) {
	const { push } = useContext(ScreenNavContext);
	const [selectedIndex, setSelectedIndex] = useState(0);

	const entries: Array<IpodListItem & { target: ScreenId }> = [
		{ key: "radio", label: "Radio", arrow: true, target: "radio" },
		{ key: "timeTravel", label: "Time Travel", arrow: true, target: "timeTravel" },
		{
			key: "nowPlaying",
			label: "Now Playing",
			arrow: true,
			target: "nowPlaying",
			disabled: !hasActiveStation,
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
