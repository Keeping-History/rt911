import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicySpinner,
	ClassicyWindow,
	quitMenuItemHelper,
	useClassicyDateTime,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react"; // useState used for timeForm
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

	const handleSkipBack    = () => shiftTime(-SKIP_MINUTES);
	const handleStepBack    = () => shiftTime(-STEP_MINUTES);
	const handleStepForward = () => shiftTime(STEP_MINUTES);
	const handleSkipForward = () => shiftTime(SKIP_MINUTES);
	const handlePlay        = () => resume();
	const handlePause       = () => pause();

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
	}, [timeForm, dateTime, tzOffset, setDateTime]);

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
				initialSize={[340, 130]}
				initialPosition={[300, 200]}
				minimumSize={[340, 130]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.controls}>
					{/* Transport row */}
					<div className={styles.transport}>
						<ClassicyButton buttonShape="square" onClickFunc={handleSkipBack}>«</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleStepBack}>‹</ClassicyButton>
						<ClassicyButton onClickFunc={handlePlay}  disabled={!paused}>Play</ClassicyButton>
						<ClassicyButton onClickFunc={handlePause} disabled={paused}>Pause</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleStepForward}>›</ClassicyButton>
						<ClassicyButton buttonShape="square" onClickFunc={handleSkipForward}>»</ClassicyButton>
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
