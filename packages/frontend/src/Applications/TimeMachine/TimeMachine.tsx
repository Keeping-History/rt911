import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicySlider,
	ClassicySpinner,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
	useClassicyDateTime,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { type ChangeEvent, useCallback, useMemo, useState } from "react";
import { trackPauseResume, trackVirtualTimeSet } from "../../openreplay";
import { BookmarksWindow } from "./BookmarksWindow";
import { setDateTimeFromUtc } from "./setVirtualClock";
import styles from "./TimeMachine.module.scss";
import {
	DEFAULT_TIME_MACHINE_SETTINGS,
	readTimeMachineSettings,
	TIME_MACHINE_APP_ID,
	timeMachineSetSettings,
} from "./timeMachineSettings";
import type { Bookmark } from "./useBookmarks";

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
	const { skipMinutes, stepSeconds } = useMemo(
		() => readTimeMachineSettings(appData),
		[appData],
	);

	const [showSettings, setShowSettings] = useState(false);
	const [showBookmarks, setShowBookmarks] = useState(false);
	const [settingsForm, setSettingsForm] = useState(DEFAULT_TIME_MACHINE_SETTINGS);

	const openSettings = useCallback(() => {
		setSettingsForm({ skipMinutes, stepSeconds });
		setShowSettings(true);
	}, [skipMinutes, stepSeconds]);

	const saveSettings = useCallback(() => {
		desktopEventDispatch(timeMachineSetSettings(settingsForm));
		setShowSettings(false);
	}, [settingsForm, desktopEventDispatch]);

	const openBookmarks = useCallback(() => setShowBookmarks(true), []);

	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [
					{
						id: `${appId}_bookmarks`,
						title: "Bookmarks\u2026",
						onClickFunc: openBookmarks,
					},
					{
						id: `${appId}_settings`,
						title: "Settings\u2026",
						onClickFunc: openSettings,
					},
					quitMenuItemHelper(appId, appName, appIcon),
				],
			},
		],
		[openBookmarks, openSettings],
	);

	const { dateTime, setDateTime, tzOffset, paused, pause, resume } = useClassicyDateTime({ tick: true });

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

	const handleScrubForward = () => shiftTime(5 / 60);
	const handleScrubBack    = () => shiftTime(-5 / 60);
	const handleSkipBack    = () => shiftTime(-skipMinutes);
	const handleStepBack    = () => shiftTime(-(stepSeconds / 60));
	const handleStepForward = () => shiftTime(stepSeconds / 60);
	const handleSkipForward = () => shiftTime(skipMinutes);
	const handlePlay        = () => { resume();  trackPauseResume("resume", dateTime); };
	const handlePause       = () => { pause();   trackPauseResume("pause",  dateTime); };

	// --- Time entry ---

	const handleGo = useCallback(() => {
		const localH24 =
			(parseInt(timeForm.hours, 10) % 12) +
			(timeForm.ampm === "PM" ? 12 : 0);
		// User entered local time — convert to UTC by subtracting the tz offset.
		// setUTCHours handles out-of-range values (e.g. -3 wraps to previous day 21:00).
		const utcH = localH24 - tzOffset;
		const base = new Date(dateTime);
		base.setUTCHours(utcH, parseInt(timeForm.minutes, 10), parseInt(timeForm.seconds, 10), 0);
		setDateTime(base);
		trackVirtualTimeSet(base.toISOString(), "seek");
	}, [timeForm, dateTime, tzOffset, setDateTime]);

	// --- Bookmarks ---

	const handleBookmarkClick = useCallback(
		(bookmark: Bookmark) => {
			const applied = setDateTimeFromUtc(setDateTime, bookmark.start_date);
			trackVirtualTimeSet(applied.toISOString(), "seek");
		},
		[setDateTime],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
			addSystemMenu={false}
		>
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
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={styles.settings}>
						<ClassicyControlGroup label="Skip">
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
						</ClassicyControlGroup>
						<ClassicyControlGroup label="Step">
							<ClassicySlider
								id="controls_step_seconds"
								labelTitle="Duration:"
								labelPosition="left"
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
						</ClassicyControlGroup>
						<div className={styles.settingsButtons}>
							<ClassicyButton onClickFunc={() => setShowSettings(false)}>
								Cancel
							</ClassicyButton>
							<ClassicyButton isDefault={true} onClickFunc={saveSettings}>
								Save
							</ClassicyButton>
						</div>
					</div>
				</ClassicyWindow>
			)}
			{showBookmarks && (
				<BookmarksWindow
					appId={appId}
					appMenu={appMenu}
					icon={appIcon}
					tzOffset={tzOffset}
					onSelect={handleBookmarkClick}
					onCloseFunc={() => setShowBookmarks(false)}
				/>
			)}
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				icon={appIcon}
				appId={appId}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={true}
				initialSize={[380, 130]}
				initialPosition={[300, 200]}
				minimumSize={[340, 130]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.controls}>
					{/* Transport row */}
					<div className={styles.transport}>
						<ClassicyButton buttonShape="square" onClickFunc={handleSkipBack}>⇚</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleStepBack}>«</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleScrubBack}>‹</ClassicyButton>
						<ClassicyButton onClickFunc={handlePlay}  disabled={!paused}>Play</ClassicyButton>
						<ClassicyButton onClickFunc={handlePause} disabled={paused}>Pause</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleScrubForward}>›</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleStepForward}>»</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleSkipForward}>⇛</ClassicyButton>
					</div>

					<hr className={styles.divider} />

					{/* Time entry row */}
					<div className={styles.timeEntry}>
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
							options={[
								{ value: "AM", label: "AM" },
								{ value: "PM", label: "PM" },
							]}
							selected={timeForm.ampm}
							onChangeFunc={(e) => setTimeForm((f) => ({ ...f, ampm: e.target.value }))}
							/>
						<ClassicyButton onClickFunc={handleGo}>GO</ClassicyButton>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
