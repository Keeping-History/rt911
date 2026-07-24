import { ClassicyWindow } from "classicy";
import type React from "react";
import { BookmarkDialogForm, type BookmarkDialogFormProps } from "./BookmarkDialogForm";

type BookmarkDialogProps = BookmarkDialogFormProps & {
	appId: string;
	icon: string;
	appMenu: React.ComponentProps<typeof ClassicyWindow>["appMenu"];
};

export const BookmarkDialog: React.FC<BookmarkDialogProps> = ({
	appId,
	icon,
	appMenu,
	...formProps
}) => (
	<ClassicyWindow
		id={`${appId}_bookmark_dialog`}
		title={formProps.mode === "edit" ? "Edit Bookmark" : "New Bookmark"}
		icon={icon}
		appId={appId}
		closable={true}
		resizable={false}
		zoomable={false}
		scrollable={false}
		collapsable={false}
		initialSize={[280, 0]}
		initialPosition={[420, 260]}
		appMenu={appMenu}
		onCloseFunc={formProps.onCancel}
	>
		<BookmarkDialogForm {...formProps} />
	</ClassicyWindow>
);
