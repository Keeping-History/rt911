/**
 * EPG grid panel — same logic as EPG.tsx but without the ClassicyApp/ClassicyWindow
 * shell so it can be embedded directly inside the TV app.
 *
 * Tuning to a channel dispatches tvTuneChannel and calls onClose so the grid
 * dismisses itself after the user makes a selection.
 */
import {
	ClassicyButton,
	ClassicyIcons,
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
import { tvTuneChannel } from "./TVContext";
import epgStyles from "./TVEPGPanel.module.scss";
import styles from "./TV.module.scss";

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

const EPG_GUIDE_URL = "https://files.911realtime.org/epg/guide.json";
const DESCRIPTION_CHAR_LIMIT = 100;
const MINUTES_PER_GRID = 5;
const GRID_TIME_WIDTH = 30;
const GRID_WIDTH = 180;
const CHANNEL_HEADER_WIDTH = 5;

const truncate = (s: string, n: number) =>
	s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;

function roundDownToNearest(date: Date, roundMinutes: number): Date {
	const d = new Date(date);
	const m = d.getMinutes();
	d.setMinutes(m - (m % roundMinutes), 0, 0);
	return d;
}

interface TVEPGPanelProps {
	onClose: () => void;
}

export const TVEPGPanel: React.FC<TVEPGPanelProps> = ({ onClose }) => {
	const desktopEventDispatch = useAppManagerDispatch();
	const dateTime      = useAppManager((s) => s.System.Manager.DateAndTime.dateTime);
	const timeZoneOffset = useAppManager((s) => s.System.Manager.DateAndTime.timeZoneOffset);
	const tzOffset = Number.parseInt(timeZoneOffset, 10);

	const toLocal = useCallback(
		(utcMs: number) => utcMs + tzOffset * 3_600_000,
		[tzOffset],
	);

	const localNow = useCallback(
		() => new Date(new Date(dateTime).getTime() + tzOffset * 3_600_000),
		[dateTime, tzOffset],
	);

	const [gridData, setGridData] = useState<EPGChannel[]>([]);

	useEffect(() => {
		const controller = new AbortController();
		fetch(EPG_GUIDE_URL, { signal: controller.signal })
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
				return r.json();
			})
			.then((json) => setGridData(json as EPGChannel[]))
			.catch((err) => {
				if (err.name !== "AbortError") console.error("EPG load failed:", err);
			});
		return () => controller.abort();
	}, []);

	const [gridStartTime, setGridStartTime] = useState(() =>
		roundDownToNearest(localNow(), GRID_TIME_WIDTH),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: snap only on tz change
	useEffect(() => {
		setGridStartTime(roundDownToNearest(localNow(), GRID_TIME_WIDTH));
	}, [tzOffset]); // eslint-disable-line react-hooks/exhaustive-deps

	const gridEndTime = useMemo(() => {
		const d = new Date(gridStartTime);
		d.setMinutes(d.getMinutes() + GRID_WIDTH);
		return d;
	}, [gridStartTime]);

	const currentTime = localNow();
	const indicator = Math.floor(
		(currentTime.getTime() - gridStartTime.getTime()) / (1000 * 60 * MINUTES_PER_GRID),
	);

	const jumpBack    = () => setGridStartTime(new Date(gridStartTime.getTime() - 30 * 60 * 1000));
	const jumpForward = () => setGridStartTime(new Date(gridStartTime.getTime() + 30 * 60 * 1000));
	const jumpToNow   = () => setGridStartTime(roundDownToNearest(localNow(), GRID_TIME_WIDTH));

	const tuneToChannel = useCallback(
		(channelName: string) => {
			desktopEventDispatch(tvTuneChannel(channelName));
			onClose();
		},
		[desktopEventDispatch, onClose],
	);

	const getProgramData = useCallback(
		(channel: EPGChannel, channelIndex: number) => {
			return channel.grid.map((gridItem: EPGProgram) => {
				const totalGridSlots = GRID_WIDTH / MINUTES_PER_GRID;
				const itemStartLocal = toLocal(Date.parse(gridItem.start));
				const itemEndLocal   = toLocal(Date.parse(gridItem.end));
				const itemStart = new Date(itemStartLocal);
				const itemEnd   = new Date(itemEndLocal);

				let gridProgramStart = Math.round(
					(itemStartLocal - gridStartTime.getTime()) / 60000 / MINUTES_PER_GRID,
				);
				let gridProgramEnd = Math.round(
					(itemEndLocal - itemStartLocal) / 60000 / MINUTES_PER_GRID,
				);

				if (gridProgramStart < 0) {
					gridProgramEnd = gridProgramStart + gridProgramEnd;
					gridProgramStart = 0;
				}
				if (gridProgramEnd > totalGridSlots) gridProgramEnd = totalGridSlots;

				if (
					gridProgramEnd <= 0 ||
					itemStart > gridEndTime ||
					itemEnd < gridStartTime ||
					gridProgramStart + 2 > totalGridSlots
				) return null;

				const highlight = itemStart <= currentTime && itemEnd >= currentTime;
				if (!gridItem) return null;

				return (
					<div
						key={channel.name + gridItem.start + gridItem.end}
						className={classNames(epgStyles.epgEntry, highlight ? epgStyles.selected : undefined)}
						style={{
							gridRowStart: channelIndex + 2,
							gridColumn: `${gridProgramStart + 2} / span ${gridProgramEnd}`,
							cursor: "pointer",
						}}
						role="button"
						tabIndex={0}
						title={`Watch ${channel.name} on TV`}
						onClick={() => tuneToChannel(channel.name)}
						onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") tuneToChannel(channel.name); }}
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
							{gridItem.icons?.map((icon) => (
								<img
									key={channel.name + Date.parse(gridItem.start) + Date.parse(gridItem.end) + icon}
									className={epgStyles.epgEntryIcon}
									src={ClassicyIcons.applications.epg[icon] as string}
									alt={icon}
								/>
							))}
						</div>
					</div>
				);
			});
		},
		[gridStartTime, gridEndTime, currentTime, toLocal, tuneToChannel],
	);

	const epgHeader = useMemo(() => {
		const headers: ReactElement[] = [
			<div
				key="column_header_date"
				className={epgStyles.epgHeaderTime}
				style={{ gridColumn: "1 / span 1" }}
			>
				{gridStartTime.toLocaleDateString([], {
					month: "numeric", day: "numeric", year: "numeric", timeZone: "UTC",
				})}
			</div>,
		];
		for (let i = 1; i <= GRID_WIDTH / MINUTES_PER_GRID; i += GRID_TIME_WIDTH / MINUTES_PER_GRID) {
			const d = new Date(gridStartTime.getTime() + (i - 1) * MINUTES_PER_GRID * 60000);
			headers.push(
				<div
					key={d.toLocaleTimeString()}
					className={epgStyles.epgHeaderTime}
					style={{ gridColumn: `${i + 1} / span ${MINUTES_PER_GRID + 1}` }}
				>
					<div className={epgStyles.epgHeaderTimeInner}>
						{d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}
					</div>
				</div>,
			);
		}
		return headers;
	}, [gridStartTime]);

	const epgData = useMemo(() => gridData.map((channel, idx) => (
		<Fragment key={`${channel.name}_${channel.number}`}>
			<div
				className={epgStyles.epgChannel}
				style={{ gridRowStart: idx + 2, gridColumnStart: 1, gridColumnEnd: 2, cursor: "pointer" }}
				role="button"
				tabIndex={0}
				title={`Watch ${channel.name} on TV`}
				onClick={() => tuneToChannel(channel.name)}
				onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") tuneToChannel(channel.name); }}
			>
				<img
					className={epgStyles.epgChannelIcon}
					src={ClassicyIcons.applications.epg.channels[channel.icon] as string}
					alt={`${channel.number} ${channel.callSign} - ${channel.location}`}
				/>
				{channel.name}
			</div>
			{getProgramData(channel, idx)}
		</Fragment>
	)), [getProgramData, gridData, tuneToChannel]);

	const gridTemplateColumns = `${CHANNEL_HEADER_WIDTH}fr repeat(${GRID_WIDTH / MINUTES_PER_GRID}, 1fr)`;

	return (
		<div className={styles.tvEpgOverlay}>
			<div className={styles.tvEpgStickyBlock}>
				<div className={styles.tvEpgToolbar}>
					<ClassicyButton onClickFunc={jumpBack} buttonSize="small" margin="sm" padding="sm">
						&lt;&lt;
					</ClassicyButton>
					<ClassicyButton onClickFunc={jumpToNow} buttonSize="small" margin="sm" padding="sm">
						Now
					</ClassicyButton>
					<ClassicyButton onClickFunc={jumpForward} buttonSize="small" margin="sm" padding="sm">
						&gt;&gt;
					</ClassicyButton>
					<ClassicyButton onClickFunc={onClose} buttonSize="small" margin="sm" padding="sm">
						Close
					</ClassicyButton>
				</div>
				<div
					className={classNames(epgStyles.epgGridSetup)}
					style={{ gridTemplateColumns, backgroundColor: "var(--color-white)", borderTop: "1px solid var(--color-system-07)" }}
				>
					{epgHeader}
				</div>
			</div>
			<div className={epgStyles.epgHolder}>
				{gridStartTime < currentTime && currentTime < gridEndTime && (
					<div
						className={classNames(epgStyles.epgGridSetup, epgStyles.epgIndicatorHolder)}
						style={{ pointerEvents: "none", gridTemplateColumns }}
					>
						<div
							className={epgStyles.epgIndicator}
							style={{ gridColumnStart: indicator + 2, gridColumnEnd: indicator + 3 }}
						>
							<div className={epgStyles.epgIndicatorCenter} />
						</div>
					</div>
				)}
				<div
					className={classNames(epgStyles.epgGridSetup, epgStyles.epgGridSetupBorder, epgStyles.epgGridAnimatedBackground)}
					style={{
						gridTemplateColumns,
						backgroundImage: `url(${ClassicyIcons.ui.stripe})`,
					}}
				>
					{epgData}
				</div>
			</div>
		</div>
	);
};
