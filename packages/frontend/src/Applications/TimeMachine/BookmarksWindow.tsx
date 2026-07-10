import { ClassicyWindow } from "classicy";
import type React from "react";
import styles from "./TimeMachine.module.scss";
import { formatUtcAsLocalTime } from "./setVirtualClock";
import { type Bookmark, useBookmarks } from "./useBookmarks";

interface BookmarksWindowProps {
	appId:      string;
	appMenu:    React.ComponentProps<typeof ClassicyWindow>["appMenu"];
	icon:       string;
	tzOffset:   number;
	onSelect:   (bookmark: Bookmark) => void;
	onCloseFunc: () => void;
}

export const BookmarksWindow: React.FC<BookmarksWindowProps> = ({
	appId,
	appMenu,
	icon,
	tzOffset,
	onSelect,
	onCloseFunc,
}) => {
	const { bookmarks, loading, error } = useBookmarks();

	return (
		<ClassicyWindow
			id={`${appId}_bookmarks`}
			title="Bookmarks"
			icon={icon}
			appId={appId}
			closable={true}
			resizable={true}
			zoomable={false}
			scrollable={true}
			collapsable={true}
			initialSize={[300, 320]}
			initialPosition={[660, 200]}
			minimumSize={[240, 160]}
			appMenu={appMenu}
			onCloseFunc={onCloseFunc}
		>
			<div className={styles.bookmarks}>
				{loading && <div className={styles.bookmarksMessage}>Loading…</div>}
				{error && !loading && (
					<div className={styles.bookmarksMessage}>Couldn’t load bookmarks: {error}</div>
				)}
				{!loading && !error && bookmarks.length === 0 && (
					<div className={styles.bookmarksMessage}>No bookmarks yet.</div>
				)}
				{!loading && !error &&
					bookmarks.map((bookmark) => (
						<button
							key={bookmark.id}
							type="button"
							className={styles.bookmarkRow}
							title={bookmark.full_title ?? bookmark.title}
							onClick={() => onSelect(bookmark)}
						>
							<span className={styles.bookmarkTime}>
								{formatUtcAsLocalTime(bookmark.start_date, tzOffset)}
							</span>
							<span className={styles.bookmarkTitle}>{bookmark.title}</span>
						</button>
					))}
			</div>
		</ClassicyWindow>
	);
};
