import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyPopUpMenu,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import classNames from "classnames";
import type React from "react";
import {
	type ChangeEvent,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	MediaStreamContext,
	type MediaItem,
} from "../../Providers/MediaStream/MediaStreamContext";
import { trackAppToggle } from "../../openreplay";
import { newsSetOpenDocuments, type NewsRemoteCommand } from "./NewsContext";
import styles from "./News.module.scss";

export const News: React.FC = () => {
	const appName = "News";
	const appId = "News.app";
	const appIcon = ClassicyIcons.applications.news.app as string;
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

	const desktopEventDispatch = useAppManagerDispatch();
	const dateTime       = useAppManager((s) => s.System.Manager.DateAndTime.dateTime);
	const timeZoneOffset = useAppManager((s) => s.System.Manager.DateAndTime.timeZoneOffset);
	// Boolean selector: the full apps[appId] object changes reference on every window
	// interaction (move, focus, z-order), causing a re-render each time.
	const isRunning  = useAppManager((s) => appId in (s.System.Manager.Applications.apps ?? {}));
	// Omit the ?? [] fallback from the selector — a fresh [] on every call is a new
	// reference that would make openDocumentDetails/getWindowOpenOffset always unstable.
	const appWindows = useAppManager((s) => s.System.Manager.Applications.apps[appId]?.windows);
	const paddingSize = useAppManager((s) => s.System.Manager.Appearance.activeTheme.measurements.window.paddingSize);

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

	const [limit, setLimit] = useState<number>(10);
	const [offset, setOffset] = useState<number>(0);
	const [thumbStyle, setThumbStyle] = useState<"small" | "large">("small");
	const [openDocuments, setOpenDocuments] = useState<number[]>([]);

	// News is delivered on its own opt-in channel; subscribe only while the app is open.
	const { newsItems: items, subscribeNews, unsubscribeNews } = useContext(MediaStreamContext);
	useEffect(() => {
		if (!isRunning) return;
		subscribeNews(appId);
		return () => unsubscribeNews(appId);
	}, [isRunning, subscribeNews, unsubscribeNews, appId]);

	const entries = useMemo(
		() =>
			[...items].sort(
				(a, b) =>
					new Date(b.start_date ?? "").getTime() - new Date(a.start_date ?? "").getTime(),
			),
		[items],
	);

	const filteredEntries = useMemo(
		() =>
			entries.filter((entry: MediaItem) => {
				const startDate = new Date(entry.start_date);
				startDate.setHours(startDate.getHours() + parseInt(timeZoneOffset, 10));
				return new Date(dateTime) > startDate;
			}),
		[entries, dateTime, timeZoneOffset],
	);

	const displayEntries = useMemo(
		() => filteredEntries.slice(offset, offset + limit),
		[filteredEntries, offset, limit],
	);

	const openDocumentDetails = useCallback((docId: number) => {
		setOpenDocuments((prev) => Array.from(new Set([...prev, docId])));
		const ws = (appWindows ?? []).find(
			(w: { id: string }) => w.id === `${appId}_newsitem_${docId}`,
		);
		if (ws) {
			desktopEventDispatch({ type: "ClassicyWindowOpen",  app: { id: appId }, window: { ...ws, closed: false } });
			desktopEventDispatch({ type: "ClassicyWindowFocus", app: { id: appId }, window: ws });
		}
	}, [appWindows, desktopEventDispatch]);

	// Publish the open-documents set (playlist locked-focus reconciliation reads it).
	useEffect(() => {
		desktopEventDispatch(newsSetOpenDocuments(openDocuments));
	}, [openDocuments, desktopEventDispatch]);

	// Apply each remote focus command exactly once, tracked by its monotonic
	// seq (TV.tsx's pattern). Consume only when the article exists in the
	// stream AND its detail window has been rendered — otherwise leave the seq
	// unconsumed so the effect retries as items/appWindows update.
	const command = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.data?.command as
				| NewsRemoteCommand
				| undefined,
	);
	const lastCommandSeqRef = useRef(0);
	useEffect(() => {
		if (!command || command.seq <= lastCommandSeqRef.current) return;
		if (command.kind !== "focus") {
			lastCommandSeqRef.current = command.seq;
			return;
		}
		const exists = items.some((i) => i.id === command.docId);
		const hasWindow = (appWindows ?? []).some(
			(w: { id: string }) => w.id === `${appId}_newsitem_${command.docId}`,
		);
		if (!exists || !hasWindow) return; // retry on next items/windows update
		lastCommandSeqRef.current = command.seq;
		openDocumentDetails(command.docId);
	}, [command, items, appWindows, openDocumentDetails]);

	const paginate = useCallback((direction: "forward" | "back" | "now") => {
		if (direction === "now") {
			setOffset(0);
		} else if (direction === "back") {
			if (filteredEntries.length - (offset + limit) > 0) {
				setOffset(offset + limit);
			}
		} else if (offset - limit >= 0 && offset < entries.length) {
			setOffset(offset - limit);
		} else {
			setOffset(0);
		}
	}, [filteredEntries.length, entries.length, offset, limit]);

	const formatDate = useCallback(
		(dateStr: string | undefined, options: Intl.DateTimeFormatOptions): string => {
			if (!dateStr) return "";
			// Dates are stored as naive local event times (no UTC conversion was applied
			// during import). Appending "Z" and formatting with timeZone:"UTC" displays
			// the stored value as-is, regardless of the browser's local timezone.
			const normalized = dateStr.replace(" ", "T");
			const utc =
				normalized.endsWith("Z") || normalized.includes("+")
					? normalized
					: `${normalized}Z`;
			return new Date(utc).toLocaleString("en-US", { ...options, timeZone: "UTC" });
		},
		[],
	);

	const getDoc = useCallback(
		(docId: number) => entries.find((entry: MediaItem) => entry.id === docId),
		[entries],
	);

	const getWindowOpenOffset = useCallback(
		() => ((appWindows ?? []).filter((w: { closed: boolean }) => !w.closed).length ?? 0) * paddingSize,
		[appWindows, paddingSize],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={"latest_news"}
			addSystemMenu={false}
		>
			<ClassicyWindow
				id={"latest_news"}
				title={"Latest News"}
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={true}
				collapsable={true}
				initialSize={["75%", "75%"]}
				initialPosition={["left", "top"]}
				minimumSize={[500, 300]}
				modal={false}
				appMenu={appMenu}
			>
				<div className={styles.newsHeader}>
					<div className={styles.newsPerPageWrap}>
						<ClassicyPopUpMenu
							id={"per_page"}
							label={"Per Page"}
							labelPosition="left"
							onChangeFunc={(e: ChangeEvent<HTMLSelectElement>) =>
								setLimit(parseInt(e.target.value, 10))
							}
							options={[
								{ value: "2", label: "2" },
								{ value: "10", label: "10" },
								{ value: "20", label: "20" },
								{ value: "50", label: "50" },
								{ value: "100", label: "100" },
							]}
							selected={limit.toString()}
						/>
					</div>
					<div className={styles.newsThumbSizeWrap}>
						<ClassicyPopUpMenu
							id={"thumb_size"}
							label={"Size"}
							labelPosition="left"
							onChangeFunc={(e: ChangeEvent<HTMLSelectElement>) =>
								setThumbStyle(e.target.value as "small" | "large")
							}
							options={[
								{ value: "small", label: "Small" },
								{ value: "large", label: "Large" },
							]}
							selected={thumbStyle}
						/>
					</div>
					<ClassicyButton onClickFunc={() => paginate("back")}>
						&lt;&lt;
					</ClassicyButton>
					<ClassicyButton onClickFunc={() => paginate("now")}>
						Now
					</ClassicyButton>
					<ClassicyButton onClickFunc={() => paginate("forward")}>
						&gt;&gt;
					</ClassicyButton>
				</div>
				<div className={styles.newsBody}>
					<h1 className={styles.newsTitle}>
						Latest News
					</h1>
					{displayEntries.length > 0 && (
						<div className={styles.newsMeta}>
							<p className={styles.newsMetaText}>
								From{" "}
								{formatDate(displayEntries.at(0)?.start_date, { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "numeric" })}{" "}
								to{" "}
								{formatDate(displayEntries.at(-1)?.end_date, { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "numeric" })}
							</p>
							<p className={styles.newsMetaText}>
								Total Articles:{" "}
								{
									entries.filter((e) => {
										return (
											new Date(e.start_date).getTime() <
											new Date(dateTime).getTime()
										);
									}).length
								}
							</p>
						</div>
					)}
					<hr />

					<ul className={styles.newsList}>
						{displayEntries.map((entry) => (
							<li
								key={entry.id}
								className={classNames(styles.newsListItem, {
									[styles.newsListItemLarge]: thumbStyle === "large",
									[styles.newsListItemNoBullet]:
										Boolean(entry.image) && thumbStyle === "large",
								})}
							>
								{entry.image && (
									<img
										src={entry.image}
										className={classNames(styles.newsThumb, {
											[styles.newsThumbLarge]: thumbStyle === "large",
										})}
										alt="Thumbnail"
									/>
								)}
								<button
									type="button"
									className={styles.newsListItemButton}
									onClick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										openDocumentDetails(entry.id);
									}}
								>
									<h1
										className={classNames(styles.newsListItemTitle, {
											[styles.newsListItemTitleLarge]: thumbStyle === "large",
										})}
									>
										{entry.title}
									</h1>
								</button>
								<span
									className={classNames(styles.newsListItemDate, {
										[styles.newsListItemDateLarge]: thumbStyle === "large",
									})}
								>
									{" "}
									{formatDate(entry.start_date, { month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })}{" "}
								</span>
							</li>
						))}
					</ul>
				</div>
			</ClassicyWindow>
			{openDocuments.map((docId: number) => (
				<ClassicyWindow
					onCloseFunc={() => {
						setOpenDocuments((prev) => prev.filter((d) => d !== docId));
					}}
					id={`${appId}_newsitem_${docId}`}
					key={`${appId}_newsitem_${docId}`}
					icon={appIcon}
					title={getDoc(docId)?.title}
					appId={appId}
					closable={true}
					resizable={true}
					zoomable={true}
					scrollable={true}
					collapsable={true}
					initialSize={[400, 400]}
					initialPosition={[
						10 + getWindowOpenOffset(),
						20 + getWindowOpenOffset(),
					]}
					modal={false}
					appMenu={appMenu}
				>
					<div className={styles.newsBody}>
						<h1 className={styles.newsDetailTitle}>
							{getDoc(docId)?.title}
						</h1>
						<h6 className={styles.newsDetailMeta}>
							{formatDate(getDoc(docId)?.start_date, { month: "numeric", day: "numeric", year: "numeric" })}{" "}
							{formatDate(getDoc(docId)?.start_date, { hour: "numeric", minute: "numeric", second: "numeric" })} -{" "}
							{getDoc(docId)?.source}
						</h6>

						<hr className={styles.newsDetailDivider} />
						{getDoc(docId)?.image && (
							<figure>
								<img
									src={getDoc(docId)?.image}
									className={styles.newsDetailImage}
									alt=""
								/>
								<figcaption className={styles.newsCaption}>
									{getDoc(docId)?.image_caption}
								</figcaption>
							</figure>
						)}
						<div className={styles.newsDetailContentRow}>
							<p className={styles.newsDetailBullet}>
								•••
							</p>
							<div
								className={styles.newsDetailBody}
								// biome-ignore lint/security/noDangerouslySetInnerHtml: Content comes from the Directus media_items table via the MediaStream provider.
								dangerouslySetInnerHTML={{
									__html: getDoc(docId)?.content || "",
								}}
							></div>
						</div>
					</div>
				</ClassicyWindow>
			))}
		</ClassicyApp>
	);
};
