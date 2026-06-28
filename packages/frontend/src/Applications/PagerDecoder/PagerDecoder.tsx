import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyInput,
	ClassicyPopUpMenu,
	ClassicySpinner,
	ClassicyTextEditor,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import { useContext, useEffect, useRef, useState } from "react";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import { trackAppToggle } from "../../openreplay";
import styles from "./PagerDecoder.module.scss";
import type {
	PagerDecoderFilter,
	PagerDecoderSettings,
} from "./PagerDecoderContext";
import { DEFAULT_PAGER_SETTINGS } from "./PagerDecoderContext";
import { isoToTimeKey } from "./pagerUtils";
import type { CompletedLine } from "./usePagerPlayback";
import { usePagerPlayback } from "./usePagerPlayback";

const MAX_WILDCARD_LENGTH = 25;

export const PagerDecoder = () => {
	const appId = "PagerDecoder.app";
	const appName = "Pager Decoder";
	const appIcon = ClassicyIcons.applications.pager.app;

	const dispatch = useAppManagerDispatch();
	const appState = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId],
	);

	const isOpen = useAppManager(
		(state) =>
			state.System.Manager.Applications.apps[appId]?.open ?? false,
	);
	const prevIsOpenRef = useRef<boolean | undefined>(undefined);
	useEffect(() => {
		if (prevIsOpenRef.current === undefined) {
			prevIsOpenRef.current = isOpen;
			return;
		}
		if (prevIsOpenRef.current === isOpen) return;
		prevIsOpenRef.current = isOpen;
		trackAppToggle(appId, isOpen ? "open" : "close");
	}, [isOpen]);

	const settings: PagerDecoderSettings =
		(appState?.data?.settings as PagerDecoderSettings | undefined) ??
		DEFAULT_PAGER_SETTINGS;

	useEffect(() => {
		if (!appState) return;
		if (!appState.data?.settings) {
			dispatch({
				type: "ClassicyAppPagerDecoderInitSettings",
				settings: DEFAULT_PAGER_SETTINGS,
			});
		}
	}, [appState, dispatch]);

	const { connected } = useContext(MediaStreamContext);
	const isPaused =
		appState?.windows?.find((w) => w.id === "pager-terminal")?.closed ?? false;
	const { lines, streamingText, streamingMeta, uniqueValues, clearLines } =
		usePagerPlayback(settings, isPaused, !!appState);

	// View-only ordering. `lines` is stored oldest→newest; `newestFirst` flips the
	// presentation so the most recent message sits at the top instead of the bottom.
	const [newestFirst, setNewestFirst] = useState(false);
	const displayedLines = newestFirst ? [...lines].reverse() : lines;

	const [detailLines, setDetailLines] = useState<CompletedLine[]>([]);
	const openDetail = (line: CompletedLine) => {
		setDetailLines((prev) =>
			prev.some((l) => l.id === line.id) ? prev : [...prev, line],
		);
	};
	const closeDetail = (lineId: string) => {
		setDetailLines((prev) => prev.filter((l) => l.id !== lineId));
	};

	const terminalRef = useRef<HTMLDivElement>(null);
	// Keep the newest message in view: scroll to whichever edge it lives on.
	useEffect(() => {
		const el = terminalRef.current;
		if (el) el.scrollTop = newestFirst ? 0 : el.scrollHeight;
	}, [lines.length, newestFirst]);

	// Track message completion timestamps for rolling msgs/min rate
	const completionTimesRef = useRef<number[]>([]);
	const lastLineIdRef = useRef<string | undefined>(undefined);
	const [msgsPerMin, setMsgsPerMin] = useState(0);
	useEffect(() => {
		const last = lines[lines.length - 1];
		if (last && last.id !== lastLineIdRef.current) {
			lastLineIdRef.current = last.id;
			completionTimesRef.current.push(Date.now());
		}
	}, [lines]);
	useEffect(() => {
		const id = setInterval(() => {
			const cutoff = Date.now() - 60_000;
			completionTimesRef.current = completionTimesRef.current.filter(
				(t) => t > cutoff,
			);
			setMsgsPerMin(completionTimesRef.current.length);
		}, 1000);
		return () => clearInterval(id);
	}, []);

	const updateFilter = (patch: Partial<PagerDecoderFilter>) => {
		dispatch({
			type: "ClassicyAppPagerDecoderUpdateSettings",
			settings: {
				...settings,
				filter: { ...settings.filter, ...patch },
			},
		});
	};

	const updateRetention = (value: string) => {
		const num = parseInt(value, 10);
		if (!Number.isNaN(num) && num >= 0) {
			dispatch({
				type: "ClassicyAppPagerDecoderUpdateSettings",
				settings: { ...settings, retentionLines: num },
			});
		}
	};

	const toOptions = (values: string[] | undefined) => [
		{ value: "", label: "All" },
		...(values ?? []).map((v) => ({ value: v, label: v })),
	];

	const filterBar = (
		<div className={styles.filterBar}>
			<div className={styles.filterField}>
				<ClassicyPopUpMenu
					id="pager-filter-provider"
					placeholder="Provider"
					label="Provider"
					labelPosition="left"
					size="mini"
					options={toOptions(uniqueValues?.provider)}
					selected={settings.filter.provider}
					onChangeFunc={(e) => updateFilter({ provider: e.target.value })}
				/>
			</div>
			<div className={styles.filterField}>
				<ClassicyInput
					id="pager-filter-recipient"
					labelTitle="Recipient"
					labelPosition="left"
					labelSize="small"
					placeholder="e.g. 048*"
					prefillValue={settings.filter.recipient_id}
					onChangeFunc={(e) =>
						updateFilter({
							recipient_id: e.target.value.slice(0, MAX_WILDCARD_LENGTH),
						})
					}
				/>
			</div>
			<div className={styles.filterField}>
				<ClassicyInput
					id="pager-filter-message"
					labelTitle="Message"
					labelPosition="left"
					labelSize="small"
					placeholder="e.g. *alert*"
					prefillValue={settings.filter.message}
					onChangeFunc={(e) =>
						updateFilter({
							message: e.target.value.slice(0, MAX_WILDCARD_LENGTH),
						})
					}
				/>
			</div>
			<div className={styles.filterField}>
				<ClassicySpinner
					id="pager-filter-retention"
					labelTitle="Keep"
					labelPosition="left"
					labelSize="small"
					placeholder={200}
					prefillValue={settings.retentionLines}
					onChangeFunc={(e) => updateRetention(e.target.value)}
				/>
			</div>
			<div className={styles.filterField}>
				<ClassicyButton buttonSize="small" onClickFunc={clearLines}>
					Clear
				</ClassicyButton>
				<ClassicyButton
					buttonSize="small"
					depressed={newestFirst}
					onClickFunc={() => setNewestFirst((v) => !v)}
				>
					<span style={{ fontSize: "var(--body-font-size)" }}>
						{newestFirst ? "▲" : "▼"}
					</span>
				</ClassicyButton>
			</div>
		</div>
	);

	const streamingBlock = streamingMeta && (
		<div className={styles.line}>
			<span className={styles.meta}>
				[{isoToTimeKey(streamingMeta.timestamp)}] {streamingMeta.provider}{" "}
			</span>
			{streamingText}
			<span className={styles.cursor} aria-hidden="true" />
		</div>
	);

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
		},
	];

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="pager-terminal"
		>
			<ClassicyWindow
				id="pager-terminal"
				title="Pager Decoder"
				appId={appId}
				initialSize={[680, 480]}
				initialPosition={[80, 60]}
				appMenu={appMenu}
				header={
					<p>
						<span style={{ color: connected ? "green" : "red" }}>&bull;</span>
						{" "}{connected ? "Connected to server 203.0.113.212::3871" : "Disconnected"}
					</p>
				}
				scrollable={false}
				resizable
				growable
			>
				<div className={styles.pagerContent}>
			{filterBar}
			<div className={styles.terminalOuter}>
				<div className={styles.terminal} ref={terminalRef}>
					{!connected && lines.length === 0 && (
						<p className={styles.loading}>Waiting for server connection…</p>
					)}
					{/* The in-progress message is the newest, so it leads when newest-first. */}
					{newestFirst && streamingBlock}
					{displayedLines.map((line) => (
						<button
							key={line.id}
							className={styles.line}
							onDoubleClick={() => openDetail(line)}
							onKeyDown={(e) => e.key === "Enter" && openDetail(line)}
							type="button"
						>
							<span className={styles.meta}>
								[{isoToTimeKey(line.timestamp)}] {line.provider}{" "}
							</span>
							{line.text}
						</button>
					))}
					{!newestFirst && streamingBlock}
					{connected && !streamingMeta && (
						<span className={styles.cursor} aria-hidden="true" />
					)}
				</div>
				<div className={styles.pagerStatusBar}>
					{streamingMeta
						? `Receiving from ${streamingMeta.provider}… | ${msgsPerMin}/min`
						: connected
							? `${lines.length} message${lines.length !== 1 ? "s" : ""}`
							: "Disconnected"}
				</div>
				</div>
			</div>
			</ClassicyWindow>
			{detailLines.map((line, i) => (
				<ClassicyWindow
					key={line.id}
					id={`pager-detail-${line.id}`}
					title="Message Details"
					appId={appId}
					icon={appIcon}
					initialSize={[420, 340]}
					initialPosition={[200 + i * 20, 160 + i * 20]}
					appMenu={appMenu}
					resizable={false}
					zoomable={false}
					onCloseFunc={() => closeDetail(line.id)}
				>
					<div className={styles.detailFields}>
						<ClassicyControlGroup label="Message Details" layout="form">
							<ClassicyInput
								id={`${line.id}-timestamp`}
								labelTitle="Timestamp"
								labelPosition="left"
								prefillValue={line.record.timestamp}
								labelDisabled={false}
								disabled
							/>
							<ClassicyInput
								id={`${line.id}-provider`}
								labelTitle="Provider"
								labelPosition="left"
								prefillValue={line.record.provider}
								labelDisabled={false}
								disabled
							/>
							<ClassicyInput
								id={`${line.id}-recipient`}
								labelTitle="Recipient ID"
								labelPosition="left"
								labelDisabled={false}
								prefillValue={line.record.recipient_id}
								disabled
							/>
							<ClassicyInput
								id={`${line.id}-mode`}
								labelTitle="Mode"
								labelPosition="left"
								labelDisabled={false}
								prefillValue={line.record.mode}
								disabled
							/>
						</ClassicyControlGroup>
						<div className={styles.detailMessage}>
							<ClassicyControlGroup label="Message Contents">
								<ClassicyTextEditor
									id={`${line.id}-message`}
									border
									prefillValue={line.record.message}
									autoHeight
									disabled
								/>
							</ClassicyControlGroup>
						</div>
					</div>
				</ClassicyWindow>
			))}
		</ClassicyApp>
	);
};
