import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyWindow,
	quitAppHelper,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManagerDispatch,
} from "classicy";
import { useMemo, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { type PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { PlaylistList } from "./PlaylistList";
import appIconPng from "./app.png";

const appId = "PlaylistEditor.app";
const appName = "Playlists";
export const GATE_MESSAGE = "You must be signed in to create playlists.";

const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		playlistEditor: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.playlistEditor.app;

export function PlaylistEditor() {
	const { status, user } = useAuth();
	const dispatch = useAppManagerDispatch();
	const [openRecord, setOpenRecord] = useState<PlaylistRecord | null>(null);

	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[],
	);

	const quit = () => dispatch(quitAppHelper(appId, appName, appIcon));

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="playlist_editor_main"
			addSystemMenu={false}
		>
			{status === "anonymous" && (
				<ClassicyWindow
					id="playlist_editor_gate"
					appId={appId}
					title={appName}
					icon={appIcon}
					modal={true}
					closable={true}
					resizable={false}
					zoomable={false}
					collapsable={false}
					scrollable={false}
					initialSize={[320, 0]}
					initialPosition={[260, 200]}
					onCloseFunc={quit}
				>
					<div className="playlistEditorGate">
						<p>{GATE_MESSAGE}</p>
						<ClassicyButton isDefault={true} onClickFunc={quit}>
							Quit
						</ClassicyButton>
					</div>
				</ClassicyWindow>
			)}
			{status === "signedIn" && (
				<ClassicyWindow
					id="playlist_editor_main"
					appId={appId}
					title={appName}
					icon={appIcon}
					closable={true}
					resizable={true}
					zoomable={true}
					collapsable={false}
					scrollable={true}
					initialSize={[640, 480]}
					initialPosition={[140, 90]}
					appMenu={appMenu}
				>
					{openRecord === null ? (
						<PlaylistList meId={user?.id ?? ""} onOpen={setOpenRecord} />
					) : (
						<div>Editor: {openRecord.title}</div>
					)}
				</ClassicyWindow>
			)}
			{/* status === "loading": render no window; auth resolves within a tick of boot */}
		</ClassicyApp>
	);
}
