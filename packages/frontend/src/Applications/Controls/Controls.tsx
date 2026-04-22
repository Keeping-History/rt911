import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import styles from "./Controls.module.scss";

// How many minutes each skip/rewind step moves the clock
const SKIP_MINUTES = 30;
const STEP_MINUTES = 5;

export const Controls: React.FC = () => {
	const appName = "Controls";
	const appId = "Controls.app";
	const appIcon = ClassicyIcons.system.quicktime.controlPanel as string;
	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[appIcon],
	);

	const { dateTime, setDateTime } = useClassicyDateTime({ tick: true });

	// Playback state
	const [isPlaying, setIsPlaying] = useState(false);

	// Time entry form state — initialise from the current virtual clock
	const parseCurrentTime = useCallback(() => {
		const d = new Date(dateTime);
		let h = d.getUTCHours();
		const ampm = h >= 12 ? "PM" : "AM";
		h = h % 12 || 12;
		return {
			hours: String(h),
			minutes: String(d.getUTCMinutes()).padStart(2, "0"),
			seconds: String(d.getUTCSeconds()).padStart(2, "0"),
			ampm,
		};
	}, [dateTime]);

	const [timeForm, setTimeForm] = useState(parseCurrentTime);

	// --- Playback controls ---

	const shiftTime = useCallback(
		(deltaMinutes: number) => {
			const next = new Date(new Date(dateTime).getTime() + deltaMinutes * 60_000);
			setDateTime(next);
		},
		[dateTime, setDateTime],
	);

	const handleSkipBack    = () => shiftTime(-SKIP_MINUTES);
	const handleStepBack    = () => shiftTime(-STEP_MINUTES);
	const handleStepForward = () => shiftTime(STEP_MINUTES);
	const handleSkipForward = () => shiftTime(SKIP_MINUTES);
	const handlePlay        = () => setIsPlaying(true);
	const handlePause       = () => setIsPlaying(false);

	// --- Time entry ---

	const handleGo = useCallback(() => {
		const h24 =
			(parseInt(timeForm.hours, 10) % 12) +
			(timeForm.ampm === "PM" ? 12 : 0);
		const base = new Date(dateTime);
		base.setUTCHours(h24, parseInt(timeForm.minutes, 10), parseInt(timeForm.seconds, 10), 0);
		setDateTime(base);
	}, [timeForm, dateTime, setDateTime]);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
			addSystemMenu={false}
		>
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				appId={appId}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={true}
				initialSize={[340, 110]}
				initialPosition={[300, 200]}
				minimumSize={[340, 110]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.controls}>
					{/* Transport row */}
					<div className={styles.transport}>
						<ClassicyButton onClickFunc={handleSkipBack}>«</ClassicyButton>
						<ClassicyButton onClickFunc={handleStepBack}>‹</ClassicyButton>
						<ClassicyButton onClickFunc={handlePlay}  disabled={isPlaying}>Play</ClassicyButton>
						<ClassicyButton onClickFunc={handlePause} disabled={!isPlaying}>Pause</ClassicyButton>
						<ClassicyButton onClickFunc={handleStepForward}>›</ClassicyButton>
						<ClassicyButton onClickFunc={handleSkipForward}>»</ClassicyButton>
					</div>

					<hr className={styles.divider} />

					{/* Time entry row */}
					<div className={styles.timeEntry}>
						<label className={styles.timeLabel}>H:</label>
						<input
							className={styles.timeInput}
							type="text"
							maxLength={2}
							value={timeForm.hours}
							onChange={(e) => setTimeForm((f) => ({ ...f, hours: e.target.value }))}
						/>
						<label className={styles.timeLabel}>M:</label>
						<input
							className={styles.timeInput}
							type="text"
							maxLength={2}
							value={timeForm.minutes}
							onChange={(e) => setTimeForm((f) => ({ ...f, minutes: e.target.value }))}
						/>
						<label className={styles.timeLabel}>S:</label>
						<input
							className={styles.timeInput}
							type="text"
							maxLength={2}
							value={timeForm.seconds}
							onChange={(e) => setTimeForm((f) => ({ ...f, seconds: e.target.value }))}
						/>
						<select
							className={styles.ampmSelect}
							value={timeForm.ampm}
							onChange={(e) => setTimeForm((f) => ({ ...f, ampm: e.target.value }))}
						>
							<option value="AM">AM</option>
							<option value="PM">PM</option>
						</select>
						<ClassicyButton onClickFunc={handleGo}>GO</ClassicyButton>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
