// packages/frontend/src/Mobile/screens/SettingsScreen.tsx
import { useContext, useState } from "react";
import { IpodList, type IpodListItem } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";
import type { ScreenId } from "../screenStack";

export function SettingsScreen() {
	const { push } = useContext(ScreenNavContext);
	const [selectedIndex, setSelectedIndex] = useState(0);

	const entries: Array<IpodListItem & { target: ScreenId }> = [
		{ key: "color", label: "Color", arrow: true, target: "settingsColor" },
	];

	const activate = (i: number) => {
		if (entries[i]) push(entries[i].target);
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
