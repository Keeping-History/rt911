// BookmarksWindow.tsx
import { ClassicyWindow } from "classicy";
import type React from "react";
import type { PersonalBookmark } from "./bookmarksApi";
import { BookmarksTree } from "./BookmarksTree";
import type { Bookmark } from "./useBookmarks";

interface BookmarksWindowProps {
	appId: string;
	appMenu: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
	icon: string;
	tzOffset: number;
	global: Bookmark[];
	personal: PersonalBookmark[];
	loading: boolean;
	error: string | null;
	signedIn: boolean;
	onJump: (startDate: string) => void;
	onEdit: (b: PersonalBookmark) => void;
	onDelete: (b: PersonalBookmark) => void;
	onCloseFunc: () => void;
}

export const BookmarksWindow: React.FC<BookmarksWindowProps> = ({
	appId,
	appMenu,
	icon,
	tzOffset,
	global,
	personal,
	loading,
	error,
	signedIn,
	onJump,
	onEdit,
	onDelete,
	onCloseFunc,
}) => (
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
		<BookmarksTree
			global={global}
			personal={personal}
			loading={loading}
			error={error}
			signedIn={signedIn}
			tzOffset={tzOffset}
			onJump={onJump}
			onEdit={onEdit}
			onDelete={onDelete}
		/>
	</ClassicyWindow>
);
