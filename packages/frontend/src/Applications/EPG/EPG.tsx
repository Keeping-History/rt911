import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlLabel,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import classNames from "classnames";
import type React from "react";
import {
	Fragment,
	type ReactElement,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	tvExitGrid,
	tvPause,
	tvResume,
	tvSetGridChannels,
	tvSetMuted,
	tvSetVolumeLimit,
	tvTuneChannel,
} from "../TV/TVContext";
import epgStyles from "./EPG.module.scss";

const EPG_GUIDE_URL = "https://files.911realtime.org/epg/guide.json";

// Hard cap on how many characters of a program description we ever put in the
// DOM. Past this we slice and append an ellipsis so a runaway synopsis can't
// blow out a cell. (CSS additionally hides the description entirely in cells
// too narrow to show it legibly — see EPG.module.scss.) The exact number is a
// readability heuristic: ~100 chars is roughly two comfortable lines in a
// medium-width program cell.
const DESCRIPTION_CHAR_LIMIT = 100;

const truncate = (text: string, limit: number) =>
	text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;

interface ClassicyEPGProps {
	minutesPerGrid?: number; // in Minutes
	gridTimeWidth?: number; // in Minutes
	gridWidth?: number; // in Minutes
	gridStart?: Date;
	channelHeaderWidth?: number;
}

export type EPGProgram = {
	title: string;
	description?: string;
	notes?: string;
	start: string;
	end: string;
	icons?: string[];
	selected?: boolean;
};

export type EPGChannel = {
	name: string;
	title?: string;
	number: string;
	callSign: string;
	location: string;
	icon: string;
	grid: EPGProgram[];
};

function roundDownToNearestMinuntes(date: Date, roundMinutes: number) {
	const minutes = date.getMinutes();
	date.setMinutes(minutes - (minutes % roundMinutes), 0, 0);
	return date;
}

export const EPG: React.FC<ClassicyEPGProps> = ({
	minutesPerGrid = 5,
	gridTimeWidth = 30,
	gridWidth = 180,
	gridStart,
	channelHeaderWidth = 5,
}) => {
	const appName = "EPG";
	const appId = "EPG.app";
	const appIcon = ClassicyIcons.applications.epg.app as string;
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

	const dateTime      = useAppManager((s) => s.System.Manager.DateAndTime.dateTime);
	const timeZoneOffset = useAppManager((s) => s.System.Manager.DateAndTime.timeZoneOffset);
	const tzOffset = parseInt(timeZoneOffset, 10);

	const desktopEventDispatch = useAppManagerDispatch();

	// Ask the TV app to tune to a channel. EPG channels are keyed by call sign
	// (name); the TV resolves that against the stream's `source` slug. This is a
	// fire-and-forget cross-app event — EPG never imports the TV component.
	const tuneToChannel = useCallback(
		(channelName: string) => desktopEventDispatch(tvTuneChannel(channelName)),
		[desktopEventDispatch],
	);

	const [showSettings, setShowSettings] = useState<boolean>(false);

	// EPG schedule is fetched at runtime from the files proxy rather than bundled.
	// Starts empty (renders zero rows) and populates once the fetch resolves.
	const [gridData, setGridData] = useState<EPGChannel[]>([]);

	useEffect(() => {
		const controller = new AbortController();
		fetch(EPG_GUIDE_URL, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText}`);
				}
				return response.json();
			})
			.then((json) => setGridData(json as EPGChannel[]))
			.catch((err) => {
				// Ignore the abort thrown on unmount; surface real failures.
				if (err.name !== "AbortError") {
					console.error("Failed to load EPG guide:", err);
				}
			});
		return () => controller.abort();
	}, []);

	// Shift a UTC ms timestamp into "local space" so it can be compared against
	// gridStartTime (which is also stored in local space).
	const toLocal = useCallback(
		(utcMs: number) => utcMs + tzOffset * 3_600_000,
		[tzOffset],
	);

	const localNow = useCallback(
		() => new Date(new Date(dateTime).getTime() + tzOffset * 3_600_000),
		[dateTime, tzOffset],
	);

	const [gridStartTime, setGridStartTime] = useState(() =>
		roundDownToNearestMinuntes(gridStart ?? localNow(), gridTimeWidth),
	);

	// When the timezone changes, snap the grid to "now" in the new timezone.
	// Intentionally keyed only on tzOffset: depending on localNow/gridTimeWidth
	// would re-snap on every clock tick or width change and fight the user's scroll.
	useEffect(() => {
		setGridStartTime(roundDownToNearestMinuntes(localNow(), gridTimeWidth));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tzOffset]);

	const gridEndTime = useMemo(() => {
		const endTime = new Date(gridStartTime);
		endTime.setMinutes(endTime.getMinutes() + gridWidth);
		return endTime;
	}, [gridStartTime, gridWidth]);

	const currentTime = localNow();
	const indicator = Math.floor(
		(currentTime.getTime() - gridStartTime.getTime()) /
			(1000 * 60 * minutesPerGrid),
	);

	const jumpBack = () => {
		setGridStartTime(new Date(gridStartTime.getTime() - 30 * 60 * 1000));
	};

	const jumpForward = () => {
		setGridStartTime(new Date(gridStartTime.getTime() + 30 * 60 * 1000));
	};

	const jumpToNow = () => {
		setGridStartTime(roundDownToNearestMinuntes(localNow(), gridTimeWidth));
	};

	const getProgramData = useCallback(
		(channel: EPGChannel, channelIndex: number) => {
			return channel.grid.map((gridItem) => {
				const totalGridSlots = gridWidth / minutesPerGrid;

				// Convert UTC program times into local space (same space as gridStartTime).
				const itemStartLocal = toLocal(Date.parse(gridItem.start));
				const itemEndLocal   = toLocal(Date.parse(gridItem.end));
				const itemStart = new Date(itemStartLocal);
				const itemEnd   = new Date(itemEndLocal);

				// Snap to whole grid slots. Source timestamps carry second-level
				// jitter (e.g. 11:00:01, 11:30:04, 11:29:56), so the raw quotients are
				// fractional. CSS rejects a non-integer grid line or `span`, dropping
				// the whole `grid-column` — which left such programs unplaced and piled
				// up at the grid's auto-flow origin instead of at their real time.
				let gridProgramStart = Math.round(
					(itemStartLocal - gridStartTime.getTime()) / 60000 / minutesPerGrid,
				);
				let gridProgramEnd = Math.round(
					(itemEndLocal - itemStartLocal) / 60000 / minutesPerGrid,
				);

				if (gridProgramStart < 0) {
					gridProgramEnd = gridProgramStart + gridProgramEnd;
					gridProgramStart = 0;
				}

				if (gridProgramEnd > gridWidth / minutesPerGrid) {
					gridProgramEnd = totalGridSlots;
				}

				if (
					gridProgramEnd <= 0 ||
					itemStart > gridEndTime ||
					itemEnd < gridStartTime ||
					gridProgramStart + 2 > totalGridSlots
				) {
					return null;
				}

				const highlight = itemStart <= currentTime && itemEnd >= currentTime;

				if (!gridItem) return null;

				return (
					<div
						key={channel.name + gridItem.start + gridItem.end}
						className={classNames(
							epgStyles.epgEntry,
							highlight ? epgStyles.selected : undefined,
						)}
						style={{
							gridRowStart: channelIndex + 2,
							gridColumn: `${gridProgramStart + 2}/ span ${gridProgramEnd}`,
							cursor: "pointer",
						}}
						role="button"
						tabIndex={0}
						title={`Watch ${channel.name} on TV`}
						onClick={() => tuneToChannel(channel.name)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") tuneToChannel(channel.name);
						}}
					>
						<div className={epgStyles.epgEntryText}>
							<div className={epgStyles.epgEntryTitle}>{gridItem.title}</div>
							{gridItem.description && (
								<div className={epgStyles.epgEntryDescription}>
									{truncate(gridItem.description, DESCRIPTION_CHAR_LIMIT)}
								</div>
							)}
						</div>
						<div className={epgStyles.epgEntryIcons}>
							{gridItem.icons?.map((icon) => {
								return (
									<img
										key={
											channel.name +
											Date.parse(gridItem.start) +
											Date.parse(gridItem.end) +
											icon
										}
										className={epgStyles.epgEntryIcon}
										src={ClassicyIcons.applications.epg[icon] as string}
										alt={icon}
									/>
								);
							})}
						</div>
					</div>
				);
			});
		},
		[gridWidth, minutesPerGrid, gridStartTime, gridEndTime, currentTime, toLocal, tuneToChannel],
	);

	const epgHeader = useMemo(() => {
		// gridStartTime is stored in "local space" (UTC + tzOffset), so formatting
		// with timeZone:"UTC" correctly displays the Classicy local time.
		const headers: ReactElement[] = [
			<div
				key={"column_header_date"}
				className={epgStyles.epgHeaderTime}
				style={{
					gridColumn: `1 / span 1`,
				}}
			>
				{gridStartTime.toLocaleDateString([], {
					month: "numeric",
					day: "numeric",
					year: "numeric",
					timeZone: "UTC",
				})}
			</div>,
		];

		for (
			let i = 1;
			i <= gridWidth / minutesPerGrid;
			i += gridTimeWidth / minutesPerGrid
		) {
			const d = new Date(
				gridStartTime.getTime() + (i - 1) * minutesPerGrid * 60000,
			);
			headers.push(
				<div
					key={d.toLocaleTimeString()}
					className={epgStyles.epgHeaderTime}
					style={{
						gridColumn: `${i + 1} / span ${minutesPerGrid + 1}`,
					}}
				>
					<div className={epgStyles.epgHeaderTimeInner}>
						{d.toLocaleTimeString([], {
							hour: "numeric",
							minute: "2-digit",
							timeZone: "UTC",
						})}
					</div>
				</div>,
			);
		}
		return headers;
	}, [gridStartTime, gridWidth, minutesPerGrid, gridTimeWidth]);

	const epgData = useMemo(() => {
		return gridData.map((channel, channelIndex) => {
			return (
				<Fragment key={`${channel.name}_${channel.number}`}>
					<div
						className={epgStyles.epgChannel}
						style={{
							gridRowStart: channelIndex + 2,
							gridColumnStart: 1,
							gridColumnEnd: 2,
							cursor: "pointer",
						}}
						role="button"
						tabIndex={0}
						title={`Watch ${channel.name} on TV`}
						onClick={() => tuneToChannel(channel.name)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") tuneToChannel(channel.name);
						}}
					>
						<img
							className={epgStyles.epgChannelIcon}
							src={
								ClassicyIcons.applications.epg.channels[channel.icon] as string
							}
							alt={`${channel.number} ${channel.callSign} - ${channel.location}`}
						/>
						{channel.name}
					</div>
					{getProgramData(channel, channelIndex)}
				</Fragment>
			);
		});
	}, [getProgramData, gridData, tuneToChannel]);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={`${appId}_main`}
		>
			{showSettings && (
				<ClassicyWindow
					id={`${appId}_settings`}
					title={appName}
					appId={appId}
					closable={false}
					resizable={false}
					zoomable={false}
					scrollable={false}
					collapsable={false}
					initialSize={[200, 100]}
					initialPosition={[100, 100]}
					minimumSize={[200, 100]}
					modal={true}
					hidden={true}
					appMenu={appMenu}
				>
					<div
						style={{
							display: "flex",
							justifyContent: "center",
							flexDirection: "column",
						}}
					>
						<ClassicyControlLabel label={"Nothing Here"}></ClassicyControlLabel>
						<ClassicyButton onClickFunc={() => setShowSettings(!showSettings)}>
							Close
						</ClassicyButton>
					</div>
				</ClassicyWindow>
			)}
			<ClassicyWindow
				id={`${appId}_main`}
				title={appName}
				appId={appId}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={true}
				collapsable={true}
				initialSize={[800, 400]}
				initialPosition={[100, 50]}
				minimumSize={[600, 300]}
				modal={false}
				appMenu={appMenu}
			>
				<div
					style={{
						backgroundColor: "var(--color-system-03)",
						height: "100%",
					}}
				>
					<div>
						<ClassicyButton onClickFunc={() => setShowSettings(!showSettings)}>
							Settings
						</ClassicyButton>
						<ClassicyButton onClickFunc={jumpBack}>&lt;&lt;</ClassicyButton>
						<ClassicyButton onClickFunc={jumpToNow}>Now</ClassicyButton>
						<ClassicyButton onClickFunc={jumpForward}>&gt;&gt;</ClassicyButton>
					</div>
					{/* TV remote-control test bar: every button is a fire-and-forget
					    cross-app event handled by the TV app (see TVContext). */}
					<div style={{ display: "flex", flexWrap: "wrap", alignItems: "center" }}>
						<ClassicyControlLabel label="TV Remote:" />
						<ClassicyButton
							onClickFunc={() =>
								desktopEventDispatch(
									tvSetGridChannels(["CNN", "MSNBC", "BBC", "WETA"]),
								)
							}
						>
							Grid
						</ClassicyButton>
						<ClassicyButton onClickFunc={() => desktopEventDispatch(tvExitGrid())}>
							Single
						</ClassicyButton>
						<ClassicyButton onClickFunc={() => desktopEventDispatch(tvPause())}>
							Pause
						</ClassicyButton>
						<ClassicyButton onClickFunc={() => desktopEventDispatch(tvResume())}>
							Play
						</ClassicyButton>
						<ClassicyButton onClickFunc={() => desktopEventDispatch(tvSetMuted(true))}>
							Mute
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => desktopEventDispatch(tvSetMuted(false))}
						>
							Unmute
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => desktopEventDispatch(tvSetVolumeLimit(1))}
						>
							Vol 100%
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => desktopEventDispatch(tvSetVolumeLimit(0.5))}
						>
							Vol 50%
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => desktopEventDispatch(tvSetVolumeLimit(0.25))}
						>
							Vol 25%
						</ClassicyButton>
					</div>
					<div
						className={epgStyles.epgHolder}
						style={{ borderTop: "1px solid var(--color-system-07)" }}
					>
						{gridStartTime < currentTime && currentTime < gridEndTime && (
							<div
								className={classNames(
									epgStyles.epgGridSetup,
									epgStyles.epgIndicatorHolder,
								)}
								style={{
									pointerEvents: "none",
									gridTemplateColumns: `${channelHeaderWidth}fr repeat(${gridWidth / minutesPerGrid}, 1fr)`,
								}}
							>
								<div
									className={epgStyles.epgIndicator}
									style={{
										gridColumnStart: indicator + 2,
										gridColumnEnd: indicator + 3,
									}}
								>
									<div className={epgStyles.epgIndicatorCenter}></div>
								</div>
							</div>
						)}
						<div
							className={classNames(epgStyles.epgGridSetup)}
							style={{
								gridTemplateColumns: `${channelHeaderWidth}fr repeat(${gridWidth / minutesPerGrid}, 1fr)`,
								backgroundColor: "var(--color-white)",
								position: "relative",
							}}
						>
							{epgHeader}
						</div>
						<div
							className={classNames([
								epgStyles.epgGridSetup,
								epgStyles.epgGridSetupBorder,
								epgStyles.epgGridAnimatedBackground,
							])}
							style={{
								gridTemplateColumns: `${channelHeaderWidth}fr repeat(${gridWidth / minutesPerGrid}, 1fr)`,
								backgroundImage: `url(${ClassicyIcons.ui.stripe})`,
							}}
						>
							{epgData}
						</div>
					</div>
				</div>
			</ClassicyWindow>
		</ClassicyApp>
	);
};
