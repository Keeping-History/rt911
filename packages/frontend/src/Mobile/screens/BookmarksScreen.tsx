// packages/frontend/src/Mobile/screens/BookmarksScreen.tsx
// The mobile counterpart of the desktop TimeMachine bookmark jump list.
// Clock writes flow through the same setDateTimeFromUtc helper — see the
// clock-writer rule in packages/frontend/CLAUDE.md.
import { useAppManager, useClassicyDateTime } from "classicy";
import { useContext, useState } from "react";
import { useBookmarks } from "../../Applications/TimeMachine/useBookmarks";
import {
	formatUtcAsLocalTime,
	setDateTimeFromUtc,
} from "../../Applications/TimeMachine/setVirtualClock";
import { IpodList } from "../IpodList";
import { ScreenNavContext, useScreenWheel } from "../WheelContext";

export function BookmarksScreen({ tzOffset }: { tzOffset: number }) {
	const { setDateTime } = useClassicyDateTime();
	const { pop } = useContext(ScreenNavContext);
	const { global, loading, error } = useBookmarks();
	const [selectedIndex, setSelectedIndex] = useState(0);
	// Belt-and-suspenders alongside the shell's reactive eviction: gate the
	// write itself so a wheel-select landing in the sub-frame window between
	// the lock committing and the shell's eviction effect can't move the clock.
	const dateTimeLocked = useAppManager(
		(s) => s.System.Manager.DateAndTime.dateTimeLocked,
	);

	const activate = (i: number) => {
		if (dateTimeLocked) return;
		const bookmark = global[i];
		if (!bookmark) return;
		setDateTimeFromUtc(setDateTime, bookmark.start_date);
		pop();
	};

	useScreenWheel({
		onScroll: (steps) =>
			setSelectedIndex((i) => Math.max(0, Math.min(global.length - 1, i + steps))),
		onSelect: () => activate(selectedIndex),
	});

	if (loading) {
		return <div className="ipodTextScreen ipodCenter ipodDim">Loading…</div>;
	}
	if (error) {
		return (
			<div className="ipodTextScreen ipodCenter ipodDim">
				Bookmarks unavailable
			</div>
		);
	}
	return (
		<IpodList
			items={global.map((b) => ({
				key: String(b.id),
				label: b.title,
				value: formatUtcAsLocalTime(b.start_date, tzOffset),
			}))}
			selectedIndex={selectedIndex}
			onSelectedIndexChange={setSelectedIndex}
			onActivate={activate}
		/>
	);
}
