import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyInput,
	ClassicyPopUpMenu,
	ClassicyTextEditor,
	ClassicyWindow,
	quitMenuItemHelper,
	useAppManager,
} from "classicy";
import { useEffect, useMemo, useState } from "react";
import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";
import { DisclosureTriangle } from "./DisclosureTriangle";
import type { GroupSortField } from "./groupTree";
import { messageBodyView } from "./messageBodyView";
import styles from "./Newsgroups.module.scss";
import type { SortField } from "./newsgroupUtils";
import { useNewsgroups } from "./useNewsgroups";

/** Compact "YYYY-MM-DD HH:mm" for the date column; blank for an unparseable date. */
const fmtDate = (iso: string): string => {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const Newsgroups = () => {
	const appId = "Newsgroups.app";
	const appName = "Newsgroups";
	const appIcon = ClassicyIcons.applications.internetExplorer.mailbox;

	// Select only a boolean — the full app-state object changes reference on every
	// classicy window interaction (focus, z-order), which would re-render this
	// component on every click even when nothing relevant changed.
	const isRunning = useAppManager((s) => appId in (s.System.Manager.Applications.apps ?? {}));

	const {
		groups,
		groupRows,
		groupQuery,
		setGroupQuery,
		toggleGroupNode,
		expandAllGroups,
		collapseAllGroups,
		groupSort,
		setGroupSort,
		selectedGroup,
		selectGroup,
		rows,
		sort,
		setSort,
		toggleThread,
		loadOlder,
		connected,
		bodies,
		bodyErrors,
		requestBody,
	} = useNewsgroups(appId, isRunning);

	const sortMark = (field: SortField) =>
		sort.field === field ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

	// Draft search text: typing no longer filters live; the filter only updates
	// when the user presses Go (or Enter), committing the draft to groupQuery.
	const [searchText, setSearchText] = useState("");
	const runSearch = () => setGroupQuery(searchText.trim());

	const [openMessages, setOpenMessages] = useState<UsenetItem[]>([]);
	const openMessage = (item: UsenetItem) => {
		setOpenMessages((prev) => (prev.some((m) => m.id === item.id) ? prev : [...prev, item]));
	};
	const closeMessage = (id: number) =>
		setOpenMessages((prev) => prev.filter((m) => m.id !== id));

	// Each open message window needs its body fetched on demand (bodies no longer
	// ride the list frames). requestBody de-dupes, so re-running on any change is safe.
	useEffect(() => {
		for (const m of openMessages) requestBody(m.id);
	}, [openMessages, requestBody]);

	const appMenu = useMemo(
		() => [{ id: "file", title: "File", menuChildren: [quitMenuItemHelper(appId, appName, appIcon)] }],
		[appId, appName, appIcon],
	);

	return (
		<ClassicyApp id={appId} name={appName} icon={appIcon} defaultWindow="newsgroups-main">
			<ClassicyWindow
				id="newsgroups-main"
				title="Newsgroups"
				appId={appId}
				icon={appIcon}
				initialSize={[720, 520]}
				initialPosition={[100, 70]}
				appMenu={appMenu}
				header={
					<p>
						<span style={{ color: connected ? "green" : "red" }}>&bull;</span>{" "}
						{connected ? "Connected" : "Disconnected"}
						{selectedGroup ? ` — ${selectedGroup}` : ""}
					</p>
				}
				scrollable={false}
				resizable
				growable
			>
				<div className={styles.layout}>
					<div className={styles.groupList}>
						<div className={styles.paneTitle}>Newsgroups</div>
						<div className={styles.treeSearch}>
							{/* Row 1: the name filter and its Go button (search runs on Go/Enter). */}
							<div
								className={styles.searchRow}
								onKeyDown={(e) => e.key === "Enter" && runSearch()}
							>
								<div className={styles.searchInput}>
									<ClassicyInput
										id="newsgroup-filter"
										placeholder="Filter newsgroups…"
										labelDisabled
										prefillValue={searchText}
										onChangeFunc={(e) => setSearchText(e.target.value)}
									/>
								</div>
								<ClassicyButton buttonSize="small" onClickFunc={runSearch}>
									<span style={{ fontSize: "var(--body-font-size)" }}>Go</span>
								</ClassicyButton>
							</div>
							{/* Row 2: expand/collapse/view toggles and the list sort selector. */}
							<div className={styles.searchRow}>
								<ClassicyButton buttonSize="small" onClickFunc={expandAllGroups} padding="sm" margin="sm">
									<span style={{ fontSize: "var(--body-font-size)" }}>+</span>
								</ClassicyButton>
								<ClassicyButton buttonSize="small" onClickFunc={collapseAllGroups} padding="sm" margin="sm">
									<span style={{ fontSize: "var(--body-font-size)" }}>-</span>
								</ClassicyButton>
								<div className={styles.sortField}>
									<ClassicyPopUpMenu
										id="newsgroup-sort"
										label="Sort"
										labelPosition="left"
										size="small"
										options={[
											{ value: "name", label: "Name" },
											{ value: "count", label: "Messages" },
										]}
										selected={groupSort}
										onChangeFunc={(e) => setGroupSort(e.target.value as GroupSortField)}
									/>
								</div>
							</div>
						</div>
						<div className={styles.groupScroll}>
							{groups.length === 0 && (
								<p className={styles.hint}>
									{connected ? "Loading newsgroups…" : "Waiting for server…"}
								</p>
							)}
							{groups.length > 0 && groupRows.length === 0 && (
								<p className={styles.hint}>No newsgroups match “{groupQuery.trim()}”.</p>
							)}
							{groupRows.map(({ node, depth, hasChildren, collapsed }) => {
								const displayCount = node.isGroup ? node.ownCount : node.totalCount;
								// A real group reads on click; a pure namespace toggles its subtree.
								const activate = () =>
									node.isGroup ? selectGroup(node.path) : toggleGroupNode(node.path);
								const isActive = node.isGroup && node.path === selectedGroup;
								return (
									<div
										key={node.path}
										role="button"
										tabIndex={0}
										className={`${styles.treeRow} ${isActive ? styles.active : ""}`}
										style={{ paddingLeft: 6 + depth * 16 }}
										onClick={activate}
										onKeyDown={(e) => e.key === "Enter" && activate()}
									>
										{hasChildren ? (
											<button
												type="button"
												className={styles.treeToggle}
												aria-label={collapsed ? "Expand" : "Collapse"}
												onClick={(e) => {
													e.stopPropagation();
													toggleGroupNode(node.path);
												}}
											>
												<DisclosureTriangle open={!collapsed} />
											</button>
										) : (
											<span className={styles.treeSpacer} />
										)}
										<span className={styles.groupName}>{node.segment}</span>
										{displayCount > 0 && (
											<span className={styles.groupCount}>{displayCount.toLocaleString()}</span>
										)}
									</div>
								);
							})}
						</div>
					</div>
					<div className={styles.messageList}>
						{!selectedGroup && <p className={styles.hint}>Select a newsgroup to read.</p>}
						{selectedGroup && rows.length === 0 && (
							<p className={styles.hint}>No messages up to the current time.</p>
						)}
						{selectedGroup && rows.length > 0 && (
							<div className={styles.headerRow}>
								{(["subject", "author", "date"] as SortField[]).map((field) => (
									<button
										key={field}
										type="button"
										className={`${styles.colHeader} ${sort.field === field ? styles.colHeaderSelected : ""}`}
										onClick={() => setSort(field)}
									>
										{field.charAt(0).toUpperCase() + field.slice(1)}
										{sortMark(field)}
									</button>
								))}
							</div>
						)}
						{rows.map((row) => (
							<div
								key={row.item.id}
								className={styles.row}
								role="button"
								tabIndex={0}
								onDoubleClick={() => openMessage(row.item)}
								onKeyDown={(e) => e.key === "Enter" && openMessage(row.item)}
							>
								<span className={styles.subjectCell} style={{ paddingLeft: 6 + row.depth * 18 }}>
									{row.isRoot && row.hasChildren ? (
										<button
											type="button"
											className={styles.triangle}
											aria-label={row.collapsed ? "Expand thread" : "Collapse thread"}
											onClick={(e) => {
												e.stopPropagation();
												toggleThread(row.threadKey);
											}}
										>
											<DisclosureTriangle open={!row.collapsed} />
										</button>
									) : (
										<span className={styles.triangleSpacer} />
									)}
									{row.isRoot && row.hasChildren && (
										<span className={styles.count}>{row.count}</span>
									)}
									<span className={styles.subject}>
										{row.item.subject?.trim() || "(no subject)"}
									</span>
								</span>
								<span className={styles.authorCell}>{row.item.author}</span>
								<span className={styles.dateCell}>{fmtDate(row.displayDate)}</span>
							</div>
						))}
						{selectedGroup && rows.length > 0 && (
							<ClassicyButton onClickFunc={loadOlder} buttonSize={"medium"}>
								Check For More
							</ClassicyButton>
						)}
					</div>
				</div>
			</ClassicyWindow>

			{openMessages.map((m, i) => (
				<ClassicyWindow
					key={m.id}
					id={`newsgroup-message-${m.id}`}
					title={m.subject?.trim() || "(no subject)"}
					appId={appId}
					icon={appIcon}
					initialSize={[520, 420]}
					initialPosition={[220 + i * 20, 150 + i * 20]}
					appMenu={appMenu}
					resizable
					growable
					onCloseFunc={() => closeMessage(m.id)}
				>
					<div className={styles.detail}>
						<ClassicyControlGroup label="Message" layout="form">
							<ClassicyInput id={`${m.id}-from`} labelTitle="From" labelPosition="left" prefillValue={m.author ?? ""} disabled />
							<ClassicyInput id={`${m.id}-group`} labelTitle="Newsgroup" labelPosition="left" prefillValue={m.newsgroup ?? ""} disabled />
							<ClassicyInput id={`${m.id}-date`} labelTitle="Date" labelPosition="left" prefillValue={m.start_date} disabled />
							<ClassicyInput id={`${m.id}-subject`} labelTitle="Subject" labelPosition="left" prefillValue={m.subject ?? ""} disabled />
						</ClassicyControlGroup>
						<div className={styles.detailBody}>
							<ClassicyControlGroup label="Body">
								{(() => {
									// ClassicyTextEditor is uncontrolled (snapshots prefillValue at
									// mount), but the body arrives after the window opens — so key it
									// by view state to force a remount when the body lands.
									const view = messageBodyView(m.id, bodies, bodyErrors);
									return (
										<ClassicyTextEditor
											key={view.key}
											id={`${m.id}-body`}
											border
											prefillValue={view.value}
											autoHeight
											disabled
										/>
									);
								})()}
							</ClassicyControlGroup>
						</div>
					</div>
				</ClassicyWindow>
			))}
		</ClassicyApp>
	);
};
