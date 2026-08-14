import {
	ClassicyApp, ClassicyButton, ClassicyFileOpenDialog, type ClassicyFileOpenSelection,
	ClassicyIcons, ClassicyWindow, desktopVolume, fileSystemVolume, quitAppHelper,
	quitMenuItemHelper, registerClassicyIcons, useAppManagerDispatch, useClassicyFileSystem,
} from "classicy";
import { useCallback, useMemo, useRef } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { createPlaylist } from "../../Providers/Auth/playlistApi";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import { createDirectusVolume, MEDIA_FILE_TYPES } from "./directusVolume";
import { expandSelections } from "./editorState";
import { listFileMenu, paletteFileMenu, windowMenu } from "./playlistMenus";
import { PlaylistDocumentWindow } from "./PlaylistDocumentWindow";
import { PlaylistEditorProvider, usePlaylistEditor } from "./PlaylistEditorProvider";
import { PlaylistList } from "./PlaylistList";
import { SettingsWindow } from "./SettingsWindow";
import { ToolsPalette, TOOLS_WINDOW_ID } from "./ToolsPalette";
import appIconPng from "./app.png";

const appId = "PlaylistEditor.app";
const appName = "Playlists";
export const GATE_MESSAGE = "You must be signed in to create playlists.";

const ICONS = registerClassicyIcons({
	applications: { ...ClassicyIcons.applications, playlistEditor: { app: appIconPng } },
});
const appIcon = ICONS.applications.playlistEditor.app;

const LIST_WINDOW = "playlist_editor_list";

function PlaylistEditorContent() {
	const { user } = useAuth();
	const dispatch = useAppManagerDispatch();
	const {
		states, openIds, activeId, dialogMode, listVersion,
		openPlaylist, edit, setDialogMode, refreshList, openSettingsWindow,
	} = usePlaylistEditor();

	const fs = useClassicyFileSystem();
	const { sources } = useMediaStream();
	// The volume's closures read this ref, not the render's `sources`, so they
	// always see the live lists even though the volume is created only once.
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	const localVolumes = useMemo(
		() => [desktopVolume(fs), fileSystemVolume(fs, "Macintosh HD")],
		[fs],
	);
	const archiveVolume = useMemo(
		() =>
			createDirectusVolume({
				tvSlugs: () => sourcesRef.current.video,
				radioSlugs: () => sourcesRef.current.audio,
			}),
		// identity must stay stable for the dialog's per-folder cache
		[],
	);

	// Open THEN focus: ClassicyWindowFocus does not clear `closed`, so focusing
	// a closed window would do nothing visible.
	const reveal = useCallback(
		(windowId: string) => {
			dispatch({ type: "ClassicyWindowOpen", app: { id: appId }, window: { id: windowId } });
			dispatch({ type: "ClassicyWindowFocus", app: { id: appId }, window: { id: windowId } });
		},
		[dispatch],
	);

	const quitItem = useMemo(() => quitMenuItemHelper(appId, appName, appIcon), []);

	// File > New creates a playlist and opens it, matching the list window's
	// own New button — focusing the list instead would make the item a no-op
	// whenever the list was already frontmost.
	const onNew = useCallback(() => {
		void createPlaylist("Untitled Playlist", { version: 1, mode: "annotate", entries: [] })
			.then((record) => {
				openPlaylist(record);
				refreshList();
			})
			.catch(() => {
				/* the list window surfaces its own errors; nothing to add here */
			});
	}, [openPlaylist, refreshList]);

	const onFocusList = useCallback(() => reveal(LIST_WINDOW), [reveal]);
	const onFocusTools = useCallback(() => reveal(TOOLS_WINDOW_ID), [reveal]);
	const onFocusDocument = useCallback(
		(playlistId: string) => reveal(`playlist_doc_${playlistId}`),
		[reveal],
	);

	const sharedWindowMenu = useMemo(
		() =>
			windowMenu({
				onFocusTools, onFocusSettings: openSettingsWindow, onFocusList, onFocusDocument,
				documents: openIds.map((id) => ({ playlistId: id, title: states[id]?.title ?? "" })),
			}),
		[onFocusTools, openSettingsWindow, onFocusList, onFocusDocument, openIds, states],
	);

	const listMenu = useMemo(
		() => [
			listFileMenu({ onNew, onOpenList: onFocusList, quitItem }),
			sharedWindowMenu,
		],
		[onNew, onFocusList, quitItem, sharedWindowMenu],
	);

	// The menu of last resort, supplied unconditionally. With every window
	// closable and quitting reachable only from File > Quit, closing everything
	// would otherwise leave the menu bar showing a dead window's menus and no
	// way to quit. The design wanted this only while no document was open, so
	// that clicking the palette never swapped the bar — but withholding the
	// prop cannot deliver that (classicy's focus reducer falls back to the
	// window's stored `menuBar`, which the SetMenuBar effect never clears), and
	// the bar would swap to a STALE palette menu instead. See decision 9.
	const paletteMenu = useMemo(
		() => [paletteFileMenu({ onOpenList: onFocusList, quitItem }), sharedWindowMenu],
		[onFocusList, quitItem, sharedWindowMenu],
	);

	const handleDialogOpen = (selections: ClassicyFileOpenSelection[]) => {
		setDialogMode(null);
		if (!activeId) return;
		// Captured now: expansion is async (a "Select All" pseudo-entry re-lists
		// its folders through the archive volume's cached, serialized Directus
		// calls) and the active document must not drift while it runs.
		const targetId = activeId;
		void expandSelections(selections, archiveVolume.list).then((entries) => {
			if (entries.length > 0) edit(targetId, { type: "addEntries", entries });
		});
	};

	return (
		<>
			<ClassicyWindow
				id={LIST_WINDOW}
				appId={appId}
				title={appName}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				collapsable={false}
				scrollable={true}
				initialSize={[420, 400]}
				initialPosition={[100, 80]}
				appMenu={listMenu}
			>
				<PlaylistList
					meId={user?.id ?? ""}
					onOpen={openPlaylist}
					refreshToken={listVersion}
				/>
			</ClassicyWindow>

			{openIds.map((playlistId, index) => (
				<PlaylistDocumentWindow
					key={playlistId}
					playlistId={playlistId}
					index={index}
					appId={appId}
					appIcon={appIcon}
					quitItem={quitItem}
					onFocusTools={onFocusTools}
					onFocusList={onFocusList}
					onFocusDocument={onFocusDocument}
					onOpenList={onFocusList}
				/>
			))}

			<ToolsPalette appId={appId} icon={appIcon} appMenu={paletteMenu} />

			<SettingsWindow appId={appId} icon={appIcon} appMenu={paletteMenu} />

			<ClassicyFileOpenDialog
				id="playlist_editor_open"
				appId={appId}
				open={dialogMode !== null}
				title={dialogMode === "media" ? "Add Media" : "Add File"}
				volumes={dialogMode === "media" ? [...localVolumes, archiveVolume] : localVolumes}
				selectionMode={dialogMode === "media" ? "multi" : "single"}
				fileTypeFilters={
					dialogMode === "media"
						? [
								{ label: "All Media", types: Object.values(MEDIA_FILE_TYPES) },
								{ label: "TV Channels", types: [MEDIA_FILE_TYPES.tv] },
								{ label: "Radio Stations", types: [MEDIA_FILE_TYPES.radio] },
								{ label: "News", types: [MEDIA_FILE_TYPES.news] },
								{ label: "Flights", types: [MEDIA_FILE_TYPES.flight] },
							]
						: undefined
				}
				onOpenFunc={handleDialogOpen}
				onCancelFunc={() => setDialogMode(null)}
			/>
		</>
	);
}

export function PlaylistEditor() {
	const { status } = useAuth();
	const dispatch = useAppManagerDispatch();
	const quit = () => dispatch(quitAppHelper(appId, appName, appIcon));

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={LIST_WINDOW}
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
					backgroundColor="var(--color-system-03)"
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
				<PlaylistEditorProvider appId={appId}>
					<PlaylistEditorContent />
				</PlaylistEditorProvider>
			)}
			{/* status === "loading": render no window; auth resolves within a tick of boot */}
		</ClassicyApp>
	);
}
