import {
	ClassicyApp,
	ClassicyBalloonHelp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicySlider,
	ClassicySpinner,
	type ClassicyStoreSystemAppWindows,
	ClassicyWindow,
	describeAppState,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import { manifestDescription } from "../../Components/manifestDescription";
import appIconPng from "./app.png";
import { BalloonBevelButton, BalloonClassicyButton } from "./balloonButtons";
import bookPng from "./book.png";
import type React from "react";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { trackPauseResume, trackVirtualTimeSet } from "../../openreplay";
import { BookmarkDialog } from "./BookmarkDialog";
import { BookmarksWindow } from "./BookmarksWindow";
import { localPartsToUtcDate, toDirectusUtcString } from "./bookmarkTime";
import {
	createPersonalBookmark,
	deletePersonalBookmark,
	type PersonalBookmark,
	updatePersonalBookmark,
} from "./bookmarksApi";
import { setDateTimeFromUtc } from "./setVirtualClock";
import styles from "./TimeMachine.module.scss";
import {
	readTimeMachineSettings,
	TIME_MACHINE_APP_ID,
	timeMachineSetSettings,
} from "./timeMachineSettings";
import { type TransportControl, transportBalloons } from "./transportBalloons";
import { useBookmarks } from "./useBookmarks";
import { isWindowOpen } from "./windowState";

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.timeMachine.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons (and other apps' registrations) intact.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		timeMachine: { app: appIconPng },
	},
});

function formatSeconds(s: number): string {
	if (s < 60) return `${s} sec`;
	const min = Math.floor(s / 60);
	const sec = s % 60;
	return sec > 0 ? `${min} min ${sec} sec` : `${min} min`;
}

const appName = "Time Machine";
const appId = TIME_MACHINE_APP_ID;
const appIcon = ICONS.applications.timeMachine.app;

// Balloon-help content sourced from the manifest's state schema (the
// TimeMachineDataSchema field .describe() text registered in
// timeMachineSettings.ts) rather than hand-duplicated strings — read once at
// module scope since the manifest registry doesn't change at runtime. Titles
// are supplied here: describeAppState's own `title` is the raw field name,
// not end-user text (see the classicy manifest handoff, §6).
const skipBalloon = describeAppState(appId, "settings.skipMinutes");
const stepBalloon = describeAppState(appId, "settings.stepSeconds");
const scrubBalloon = describeAppState(appId, "settings.scrubSeconds");

// Both Settings and Bookmarks are conditionally mounted (see their
// showSettings/showBookmarks state below and the ClassicyWindows further
// down) because ClassicyWindow's own one-time mount effect unconditionally
// dispatches ClassicyWindowOpen (closed: false) the instant it mounts,
// regardless of what Classicy had persisted. Mounting either window
// unconditionally therefore force-reopens it on every fresh mount even when
// the persisted store says closed — verified live against 911realtime.org
// (this bug shipped for Settings even after Bookmarks was fixed for it — see
// issue #562). Reading the persisted entry once, here, lets the app keep a
// window unmounted (so that effect never fires) when it was last closed.
const readPersistedWindows = (): ClassicyStoreSystemAppWindows | undefined =>
	typeof useAppManager.getState === "function"
		? useAppManager.getState().System.Manager.Applications.apps[appId]?.windows
		: undefined;

export const TimeMachine: React.FC = () => {

	// Skip/step durations persist in Classicy app data (the Settings window
	// writes them); the settings draft below stays local until Save.
	const desktopEventDispatch = useAppManagerDispatch();
	const appData = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const { skipMinutes, stepSeconds, scrubSeconds } = useMemo(
		() => readTimeMachineSettings(appData),
		[appData],
	);

	// Restore Bookmarks' and Settings' mounted-ness from the persisted store so
	// a window that was open before a reload reappears, and — the actual bug
	// this guards against — one that was closed stays unmounted instead of
	// being force-reopened by ClassicyWindow's own mount effect (see
	// readPersistedWindows above).
	const [showBookmarks, setShowBookmarks] = useState(() =>
		isWindowOpen(readPersistedWindows(), `${appId}_bookmarks`),
	);
	const [showSettings, setShowSettings] = useState(() =>
		isWindowOpen(readPersistedWindows(), `${appId}_settings`),
	);

	// Seed the draft from the saved values (not defaults) so a Settings window
	// restored on reload shows the persisted slider positions immediately;
	// openSettings re-seeds on a fresh manual open.
	const [settingsForm, setSettingsForm] = useState(() => ({
		skipMinutes,
		stepSeconds,
		scrubSeconds,
	}));
	const [showOnTop, setShowOnTop] = useState(true);

	// If Settings isn't mounted yet, mounting it is enough on its own:
	// ClassicyWindow's own one-time mount effect registers the window entry
	// and opens it. Dispatching ClassicyWindowOpen ourselves in that case hits
	// a window id with no entry yet and crashes the reducer. Once it IS
	// mounted, that one-time effect has already fired, so reopening a closed
	// window (or refocusing an open one) needs an explicit dispatch instead —
	// open THEN focus, since ClassicyWindowFocus does not clear `closed`, so
	// focusing alone would do nothing visible to a closed window (same idiom
	// as PlaylistEditorProvider's openSettingsWindow).
	const openSettings = useCallback(() => {
		setSettingsForm({ skipMinutes, stepSeconds, scrubSeconds });
		if (showSettings) {
			desktopEventDispatch({
				type: "ClassicyWindowOpen",
				app: { id: appId },
				window: { id: `${appId}_settings` },
			});
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: appId },
				window: { id: `${appId}_settings` },
			});
		} else {
			setShowSettings(true);
		}
	}, [skipMinutes, stepSeconds, scrubSeconds, showSettings, desktopEventDispatch]);

	const closeSettings = useCallback(() => {
		desktopEventDispatch({
			type: "ClassicyWindowClose",
			app: { id: appId },
			window: { id: `${appId}_settings` },
		});
	}, [desktopEventDispatch]);

	const saveSettings = useCallback(() => {
		desktopEventDispatch(timeMachineSetSettings(settingsForm));
		closeSettings();
	}, [settingsForm, desktopEventDispatch, closeSettings]);

	// If Bookmarks isn't mounted yet, mounting it is enough on its own:
	// ClassicyWindow's own one-time mount effect registers the window entry
	// and opens it. Dispatching ClassicyWindowOpen ourselves in that case hits
	// a window id with no entry yet and crashes the reducer. Once it IS
	// mounted, that one-time effect has already fired, so reopening a closed
	// window (or refocusing an open one) needs an explicit dispatch instead.
	const openBookmarks = useCallback(() => {
		if (showBookmarks) {
			desktopEventDispatch({
				type: "ClassicyWindowOpen",
				app: { id: appId },
				window: { id: `${appId}_bookmarks` },
			});
			desktopEventDispatch({
				type: "ClassicyWindowFocus",
				app: { id: appId },
				window: { id: `${appId}_bookmarks` },
			});
		} else {
			setShowBookmarks(true);
		}
	}, [showBookmarks, desktopEventDispatch]);

	// Menu items are plain data, so their balloon help rides along as the
	// `balloon` field; the <ClassicyBalloonHelp> wrapper further down is for
	// JSX controls only. quitMenuItemHelper builds its item without one, so
	// the help text is layered on by spreading.
	const appMenu = useMemo(
		() => [
			{
				id: `${appId}_file`,
				title: "File",
				menuChildren: [
					{
						id: `${appId}_bookmarks`,
						title: "Bookmarks\u2026",
						onClickFunc: openBookmarks,
						balloon: {
							title: "Bookmarks",
							content:
								"Open the Bookmarks window: key moments of the day, plus any you have saved yourself. Click one to jump the clock to it.",
						},
					},
					{
						id: `${appId}_settings`,
						title: "Settings\u2026",
						onClickFunc: openSettings,
						balloon: {
							title: "Settings",
							content: "Choose how far the Skip, Step and Scrub buttons move the clock.",
						},
					},
					{
						...quitMenuItemHelper(appId, appName, appIcon),
						balloon: {
							title: "Quit",
							content: `Close ${appName}. The clock keeps running; open ${appName} again from the desktop to change the time.`,
						},
					},
				],
			},
			{
				id: `${appId}_view`,
				title: "View",
				menuChildren: [
					{
						id: `${appId}_show_on_top`,
						title: (showOnTop ? "✓" : " ") + "Show on Top",
						onClickFunc: () => setShowOnTop(!showOnTop),
						balloon: {
							title: "Show on Top",
							content: showOnTop
								? "Time Machine currently stays above every other window. Choose this to let other windows cover it."
								: "Keep Time Machine above every other window, so the controls are always within reach.",
						},
					},
				],
			},
		],
		// showOnTop drives both the checkmark and the balloon; without it in
		// the deps the menu kept showing the stale mark after a toggle.
		[openBookmarks, openSettings, showOnTop],
	);

	const { dateTime, setDateTime, tzOffset, paused, pause, resume } = useClassicyDateTime({ tick: true });

	const {
		global,
		personal,
		loading: bookmarksLoading,
		error: bookmarksError,
		signedIn,
		addPersonal,
		updatePersonalLocal,
		removePersonalLocal,
	} = useBookmarks();

	const [dialogState, setDialogState] = useState<
		{ mode: "create" | "edit"; bookmark?: PersonalBookmark } | null
	>(null);
	const [saving, setSaving] = useState(false);

	// Capture the live virtual-clock instant (read only — never writes the clock).
	const openCaptureDialog = useCallback(() => {
		if (!signedIn) {
			openBookmarks(); // Personal section shows the login prompt
			return;
		}
		setDialogState({ mode: "create" });
	}, [signedIn, openBookmarks]);

	const openEditDialog = useCallback((bookmark: PersonalBookmark) => {
		setDialogState({ mode: "edit", bookmark });
	}, []);

	const handleDialogSave = useCallback(
		async (input: Parameters<typeof createPersonalBookmark>[0]) => {
			setSaving(true);
			try {
				if (dialogState?.mode === "edit" && dialogState.bookmark) {
					const updated = await updatePersonalBookmark(dialogState.bookmark.id, input);
					updatePersonalLocal(updated);
				} else {
					const created = await createPersonalBookmark(input);
					addPersonal(created);
				}
				setDialogState(null);
			} catch (err) {
				desktopEventDispatch({
					type: "ClassicyDesktopShowErrorDialog",
					title: "Bookmarks",
					message: err instanceof Error ? err.message : "Something went wrong.",
				});
			} finally {
				setSaving(false);
			}
		},
		[dialogState, addPersonal, updatePersonalLocal, desktopEventDispatch],
	);

	const handleDeletePersonal = useCallback(
		async (bookmark: PersonalBookmark) => {
			try {
				await deletePersonalBookmark(bookmark.id);
				removePersonalLocal(bookmark.id);
			} catch (err) {
				desktopEventDispatch({
					type: "ClassicyDesktopShowErrorDialog",
					title: "Bookmarks",
					message: err instanceof Error ? err.message : "Something went wrong.",
				});
			}
		},
		[removePersonalLocal, desktopEventDispatch],
	);

	const handleBookmarkClick = useCallback(
		(startDate: string) => {
			const applied = setDateTimeFromUtc(setDateTime, startDate);
			trackVirtualTimeSet(applied.toISOString(), "seek");
		},
		[setDateTime],
	);

	// Time entry form state — initialise from the current virtual clock in local time
	const parseCurrentTime = useCallback(() => {
		// Shift UTC timestamp into local space so we display the Classicy local time
		const localMs = new Date(dateTime).getTime() + tzOffset * 3_600_000;
		const d = new Date(localMs);
		let h = d.getUTCHours();
		const ampm = h >= 12 ? "PM" : "AM";
		h = h % 12 || 12;
		return {
			hours: String(h),
			minutes: String(d.getUTCMinutes()).padStart(2, "0"),
			seconds: String(d.getUTCSeconds()).padStart(2, "0"),
			ampm,
		};
	}, [dateTime, tzOffset]);

	const [timeForm, setTimeForm] = useState(parseCurrentTime);

	// --- Playback controls ---

	const shiftTime = useCallback(
		(deltaMinutes: number) => {
			const next = new Date(new Date(dateTime).getTime() + deltaMinutes * 60_000);
			setDateTime(next);
		},
		[dateTime, setDateTime],
	);

	const handleScrubForward = () => shiftTime(scrubSeconds / 60);
	const handleScrubBack    = () => shiftTime(-(scrubSeconds / 60));
	const handleSkipBack    = () => shiftTime(-skipMinutes);
	const handleStepBack    = () => shiftTime(-(stepSeconds / 60));
	const handleStepForward = () => shiftTime(stepSeconds / 60);
	const handleSkipForward = () => shiftTime(skipMinutes);
	const handlePlay        = () => { resume();  trackPauseResume("resume", dateTime); };
	const handlePause       = () => { pause();   trackPauseResume("pause",  dateTime); };

	// Balloon help for the transport row quotes the live Settings distances
	// (see transportBalloons.ts), so it is rebuilt whenever they or the
	// paused state change. The row itself is data so each button gets its
	// balloon from the same table by key.
	const balloons = transportBalloons({ skipMinutes, stepSeconds, scrubSeconds, paused });
	const transportRow: Array<{
		key: TransportControl;
		label: string;
		onClick: () => void;
		square?: boolean;
		disabled?: boolean;
	}> = [
		{ key: "skipBack", label: "⇚", onClick: handleSkipBack, square: true },
		{ key: "stepBack", label: "«", onClick: handleStepBack, square: true },
		{ key: "scrubBack", label: "‹", onClick: handleScrubBack, square: true },
		{ key: "play", label: "Play", onClick: handlePlay, disabled: !paused },
		{ key: "pause", label: "Pause", onClick: handlePause, disabled: paused },
		{ key: "scrubForward", label: "›", onClick: handleScrubForward, square: true },
		{ key: "stepForward", label: "»", onClick: handleStepForward, square: true },
		{ key: "skipForward", label: "⇛", onClick: handleSkipForward, square: true },
	];

	// --- Time entry ---

	const handleGo = useCallback(() => {
		const next = localPartsToUtcDate(new Date(dateTime), timeForm, tzOffset);
		setDateTime(next);
		trackVirtualTimeSet(next.toISOString(), "seek");
	}, [timeForm, dateTime, tzOffset, setDateTime]);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
			addSystemMenu={false}
			desktopIconBalloonHelp={manifestDescription(appId)}
		>
			{/*
				Conditionally mounted, like Bookmarks below — see the
				readPersistedWindows/showSettings comments near the top of this
				file for why: an always-mounted Settings window cannot survive a
				reload closed, because ClassicyWindow force-opens on its own mount
				effect regardless of what was persisted (this was issue #562).
				closeSettings/saveSettings still just dispatch ClassicyWindowClose —
				the close box does the same via its own onCloseFunc default, so no
				local state needs to mirror it here beyond the mount gate itself.
			*/}
			{showSettings && (
				<ClassicyWindow
					id={`${appId}_settings`}
					title="Settings"
					icon={appIcon}
					appId={appId}
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={false}
					collapsable={false}
					initialSize={[300, 0]}
					initialPosition={[250, 150]}
					appMenu={appMenu}
				>
					<div className={styles.settings}>
						<ClassicyControlGroup label="Skip" backgroundColor="var(--color-system-02-)">
							{(() => {
								const slider = (
									<ClassicySlider
										id="controls_skip_minutes"
										labelTitle="Duration:"
										labelPosition="left"
										labelSize="small"
										value={settingsForm.skipMinutes}
										min={1}
										max={60}
										step={1}
										valueLabel={`${settingsForm.skipMinutes} min`}
										onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
											setSettingsForm((f) => ({
												...f,
												skipMinutes: parseInt(e.target.value, 10),
											}))
										}
									/>
								);
								return skipBalloon ? (
									<ClassicyBalloonHelp title="Skip distance" content={skipBalloon.content}>
										{slider}
									</ClassicyBalloonHelp>
								) : (
									slider
								);
							})()}
						</ClassicyControlGroup>
						<ClassicyControlGroup label="Step" backgroundColor="var(--color-system-02-)">
							{(() => {
								const slider = (
									<ClassicySlider
										id="controls_step_seconds"
										labelTitle="Duration:"
										labelPosition="left"
										labelSize="small"
										value={settingsForm.stepSeconds}
										min={1}
										max={600}
										step={1}
										valueLabel={formatSeconds(settingsForm.stepSeconds)}
										onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
											setSettingsForm((f) => ({
												...f,
												stepSeconds: parseInt(e.target.value, 10),
											}))
										}
									/>
								);
								return stepBalloon ? (
									<ClassicyBalloonHelp title="Step distance" content={stepBalloon.content}>
										{slider}
									</ClassicyBalloonHelp>
								) : (
									slider
								);
							})()}
						</ClassicyControlGroup>
						<ClassicyControlGroup label="Scrub" backgroundColor="var(--color-system-02-)">
							{(() => {
								const slider = (
									<ClassicySlider
										id="controls_scrub_seconds"
										labelTitle="Duration:"
										labelPosition="left"
										labelSize="small"
										value={settingsForm.scrubSeconds}
										min={1}
										max={60}
										step={1}
										valueLabel={formatSeconds(settingsForm.scrubSeconds)}
										onChangeFunc={(e: ChangeEvent<HTMLInputElement>) =>
											setSettingsForm((f) => ({
												...f,
												scrubSeconds: parseInt(e.target.value, 10),
											}))
										}
									/>
								);
								return scrubBalloon ? (
									<ClassicyBalloonHelp title="Scrub distance" content={scrubBalloon.content}>
										{slider}
									</ClassicyBalloonHelp>
								) : (
									slider
								);
							})()}
						</ClassicyControlGroup>
						<div className={styles.settingsButtons}>
							<ClassicyBalloonHelp
								title="Cancel"
								content="Close Settings and keep the Skip, Step and Scrub distances you had before."
							>
								<ClassicyButton onClickFunc={closeSettings}>
									Cancel
								</ClassicyButton>
							</ClassicyBalloonHelp>
							<ClassicyBalloonHelp
								title="Save"
								content="Use these Skip, Step and Scrub distances from now on and close Settings. They are remembered the next time you visit."
							>
								<ClassicyButton isDefault={true} onClickFunc={saveSettings}>
									Save
								</ClassicyButton>
							</ClassicyBalloonHelp>
						</div>
					</div>
				</ClassicyWindow>
			)}
			{/*
				Conditionally mounted, like Settings above — see the
				readPersistedWindows/showBookmarks comments near the top of this
				file for why: an always-mounted Bookmarks window cannot survive a
				reload closed, because ClassicyWindow force-opens on its own mount
				effect regardless of what was persisted.
			*/}
			{showBookmarks && (
				<BookmarksWindow
					appId={appId}
					appMenu={appMenu}
					icon={appIcon}
					tzOffset={tzOffset}
					global={global}
					personal={personal}
					loading={bookmarksLoading}
					error={bookmarksError}
					signedIn={signedIn}
					onJump={handleBookmarkClick}
					onEdit={openEditDialog}
					onDelete={handleDeletePersonal}
				/>
			)}
			{dialogState && (
				<BookmarkDialog
					appId={appId}
					icon={appIcon}
					appMenu={appMenu}
					mode={dialogState.mode}
					saving={saving}
					tzOffset={tzOffset}
					initial={
						dialogState.mode === "edit" && dialogState.bookmark
							? {
									title: dialogState.bookmark.title,
									category: dialogState.bookmark.category,
									startDateUtc: dialogState.bookmark.start_date,
								}
							: {
									title: "",
									category: "General",
									// live clock -> bare UTC string for the form's base date
									startDateUtc: toDirectusUtcString(new Date(dateTime)),
								}
					}
					onSave={handleDialogSave}
					onCancel={() => setDialogState(null)}
				/>
			)}
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				icon={appIcon}
				appId={appId}
				alwaysOnTop={showOnTop}
				closable={true}
				windowType="utility"
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={true}
				initialSize={[380, 105]}
				initialPosition={[300, 200]}
				minimumSize={[380, 105]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.controls}>
					{/* Transport row */}
					<div className={styles.transport}>
						{transportRow.map(({ key, label, onClick, square, disabled }) =>
							square ? (
								// Hook-bound, not wrapped: the six square buttons only fit
								// this 380px window because they shrink as direct flex
								// items of the row (see balloonButtons.tsx). Their labels
								// are arrows, so the balloon title doubles as the
								// accessible name.
								<BalloonClassicyButton
									key={key}
									balloon={balloons[key]}
									buttonShape="square"
									aria-label={balloons[key].title}
									onClickFunc={onClick}
								>
									{label}
								</BalloonClassicyButton>
							) : (
								// Play and Pause take turns being disabled, and React
								// delivers no mouse events to a disabled button — the
								// wrapper hears the hover instead. Rectangular buttons
								// have a min-width and never shrink, so the wrapper
								// costs nothing here.
								<ClassicyBalloonHelp
									key={key}
									title={balloons[key].title}
									content={balloons[key].content}
								>
									<ClassicyButton onClickFunc={onClick} disabled={disabled}>
										{label}
									</ClassicyButton>
								</ClassicyBalloonHelp>
							),
						)}
					</div>

					<hr className={styles.divider} />

					{/* Time entry row */}
					<div className={styles.timeEntry}>
						<BalloonBevelButton
							balloon={{
								title: "Capture Bookmark",
								content: signedIn
									? "Save this exact moment as a personal bookmark, so you can jump straight back to it later."
									: "Save this moment as a personal bookmark. Personal bookmarks need you to be signed in, so for now this opens the Bookmarks window instead.",
							}}
							aria-label="Capture Bookmark"
							square={true}
							onClickFunc={openCaptureDialog}
							style={{ minHeight: "var(--hig-button-height)" }}
						>
							<img className={styles.captureIcon} src={bookPng} alt="" />
						</BalloonBevelButton>
						<ClassicySpinner
							id="pager-filter-retention"
							labelTitle="H"
							labelPosition="left"
							labelSize="medium"
							placeholder={parseInt(timeForm.hours, 10)}
							prefillValue={parseInt(timeForm.hours, 10)}
							onChangeFunc={(e) => setTimeForm((f) => ({ ...f, hours: e.target.value }))}
							maxValue={24}
							minValue={0}
						/>
						<ClassicySpinner
							id="pager-filter-retention"
							labelTitle="M"
							labelPosition="left"
							labelSize="medium"
							placeholder={parseInt(timeForm.minutes, 10)}
							prefillValue={parseInt(timeForm.minutes, 10)}
							onChangeFunc={(e) => setTimeForm((f) => ({ ...f, minutes: e.target.value }))}
							maxValue={59}
							minValue={0}
						/>
						<ClassicySpinner
							id="pager-filter-retention"
							labelTitle="S"
							labelPosition="left"
							labelSize="medium"
							placeholder={parseInt(timeForm.seconds, 10)}
							prefillValue={parseInt(timeForm.seconds, 10)}
							onChangeFunc={(e) => setTimeForm((f) => ({ ...f, seconds: e.target.value }))}
							maxValue={59}
							minValue={0}
						/>
						<ClassicyPopUpMenu
							id={"am_or_pm"}
							size="small"
							options={[
								{ value: "AM", label: "AM" },
								{ value: "PM", label: "PM" },
							]}
							selected={timeForm.ampm}
							onChangeFunc={(e) => setTimeForm((f) => ({ ...f, ampm: e.target.value }))}
							/>
						<ClassicyBalloonHelp
							title="Go"
							content="Set the clock to the hour, minute, second and AM/PM entered here, on the day the clock is already showing."
						>
							<ClassicyButton onClickFunc={handleGo}>GO</ClassicyButton>
						</ClassicyBalloonHelp>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
