// packages/frontend/src/Mobile/screens/TimeTravelScreen.tsx
import { useContext, useState } from "react";
import { IpodList } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";
import type { ScreenId } from "../screenStack";

export function TimeTravelScreen() {
	const { push } = useContext(ScreenNavContext);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const entries: Array<{ key: string; label: string; arrow: boolean; target: ScreenId }> = [
		{ key: "bookmarks", label: "Bookmarks", arrow: true, target: "bookmarks" },
		{ key: "scrub", label: "Scrub Time", arrow: true, target: "scrub" },
	];
	const activate = (i: number) => push(entries[i].target);
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
