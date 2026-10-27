import type React from "react";
import { BalloonButton } from "./balloonButtons";
import editPng from "./edit.png";
import trashPng from "./trash.png";
import { Disclosure as BookmarkDisclosure } from "../../Components/Disclosure/Disclosure";
import { formatUtcAsLocalTime } from "./setVirtualClock";
import type { PersonalBookmark } from "./bookmarksApi";
import type { Bookmark } from "./useBookmarks";
import styles from "./TimeMachine.module.scss";

const DEFAULT_CATEGORY = "General";

// Group items by category. "General" sorts first (the default bucket that
// null/empty categories fall into), the rest alphabetical.
export function groupByCategory<T extends { category: string | null }>(
	items: T[],
): Array<[string, T[]]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = item.category && item.category.trim() ? item.category : DEFAULT_CATEGORY;
		const bucket = map.get(key) ?? [];
		bucket.push(item);
		map.set(key, bucket);
	}
	return [...map.entries()].sort(([a], [b]) => {
		if (a === DEFAULT_CATEGORY) return -1;
		if (b === DEFAULT_CATEGORY) return 1;
		return a.localeCompare(b);
	});
}

interface BookmarksTreeProps {
	global: Bookmark[];
	personal: PersonalBookmark[];
	loading: boolean;
	error: string | null;
	signedIn: boolean;
	tzOffset: number;
	onJump: (startDate: string) => void;
	onEdit: (b: PersonalBookmark) => void;
	onDelete: (b: PersonalBookmark) => void;
}

export const BookmarksTree: React.FC<BookmarksTreeProps> = ({
	global,
	personal,
	loading,
	error,
	signedIn,
	tzOffset,
	onJump,
	onEdit,
	onDelete,
}) => {
	if (loading) return <div className={styles.bookmarksMessage}>Loading…</div>;
	if (error) return <div className={styles.bookmarksMessage}>Couldn’t load bookmarks: {error}</div>;

	const globalGroups = groupByCategory(global);
	const personalGroups = groupByCategory(personal);

	return (
		<div className={styles.bookmarks}>
			<BookmarkDisclosure label="Global" defaultOpen>
				{globalGroups.length === 0 && (
					<div className={styles.bookmarksMessage}>No bookmarks yet.</div>
				)}
				{globalGroups.map(([category, items]) => (
					<BookmarkDisclosure key={`g-${category}`} label={category} defaultOpen>
						{items.map((b) => {
							const time = formatUtcAsLocalTime(b.start_date, tzOffset);
							return (
								<BalloonButton
									key={b.id}
									className={styles.bookmarkRow}
									balloon={{
										title: b.full_title ?? b.title,
										content: `Click to set the clock to ${time} and replay from this moment.`,
									}}
									onClick={() => onJump(b.start_date)}
								>
									<span className={styles.bookmarkTime}>{time}</span>
									<span className={styles.bookmarkTitle}>{b.title}</span>
								</BalloonButton>
							);
						})}
					</BookmarkDisclosure>
				))}
			</BookmarkDisclosure>

			<BookmarkDisclosure label="Personal" defaultOpen>
				{!signedIn && (
					<div className={styles.bookmarksMessage}>Log in to view and create personal bookmarks.</div>
				)}
				{signedIn && personalGroups.length === 0 && (
					<div className={styles.bookmarksMessage}>No personal bookmarks yet.</div>
				)}
				{signedIn &&
					personalGroups.map(([category, items]) => (
						<BookmarkDisclosure key={`p-${category}`} label={category} defaultOpen>
							{items.map((b) => {
								const time = formatUtcAsLocalTime(b.start_date, tzOffset);
								return (
									<div key={b.id} className={styles.personalRow}>
										<BalloonButton
											className={styles.bookmarkRow}
											balloon={{
												title: b.title,
												content: `Click to set the clock to ${time} and replay from this moment.`,
											}}
											onClick={() => onJump(b.start_date)}
										>
											<span className={styles.bookmarkTime}>{time}</span>
											<span className={styles.bookmarkTitle}>{b.title}</span>
										</BalloonButton>
										<div className={styles.rowActions}>
											<BalloonButton
												className={styles.iconButton}
												aria-label={`Edit “${b.title}”`}
												balloon={{
													title: "Edit Bookmark",
													content: `Change the title, category or time of “${b.title}”.`,
												}}
												onClick={() => onEdit(b)}
											>
												<img src={editPng} alt="" />
											</BalloonButton>
											{/* Deletion is immediate (handleDeletePersonal has no
											    confirm step), and the balloon says so. */}
											<BalloonButton
												className={styles.iconButton}
												aria-label={`Delete “${b.title}”`}
												balloon={{
													title: "Delete Bookmark",
													content: `Remove “${b.title}” from your personal bookmarks straight away. This cannot be undone.`,
												}}
												onClick={() => onDelete(b)}
											>
												<img src={trashPng} alt="" />
											</BalloonButton>
										</div>
									</div>
								);
							})}
						</BookmarkDisclosure>
					))}
			</BookmarkDisclosure>
		</div>
	);
};
