// packages/frontend/src/Mobile/screens/BookmarksScreen.tsx
// The mobile counterpart of the desktop TimeMachine bookmark jump list.
// Clock writes flow through the same setDateTimeFromUtc helper — see the
// clock-writer rule in packages/frontend/CLAUDE.md.
import { useClassicyDateTime } from "classicy";
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
	const { bookmarks, loading, error } = useBookmarks();
	const [selectedIndex, setSelectedIndex] = useState(0);

	const activate = (i: number) => {
		const bookmark = bookmarks[i];
		if (!bookmark) return;
		setDateTimeFromUtc(setDateTime, bookmark.start_date);
		pop();
	};

	useScreenWheel({
		onScroll: (steps) =>
			setSelectedIndex((i) => Math.max(0, Math.min(bookmarks.length - 1, i + steps))),
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
			items={bookmarks.map((b) => ({
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
