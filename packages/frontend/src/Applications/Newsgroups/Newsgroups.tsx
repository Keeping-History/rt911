import {
	ClassicyApp,
	ClassicyButton,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyInput,
	ClassicyTextEditor,
	ClassicyWindow,
	quitMenuItemHelper,
} from "classicy";
import { useState } from "react";
import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";
import { DisclosureTriangle } from "./DisclosureTriangle";
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

	const {
		groups,
		groupRows,
		groupQuery,
		setGroupQuery,
		toggleGroupNode,
		expandAllGroups,
		collapseAllGroups,
		selectedGroup,
		selectGroup,
		rows,
		sort,
		setSort,
		toggleThread,
		loadOlder,
		connected,
	} = useNewsgroups(appId);

	const sortMark = (field: SortField) =>
		sort.field === field ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

	const [openMessages, setOpenMessages] = useState<UsenetItem[]>([]);
	const openMessage = (item: UsenetItem) =>
		setOpenMessages((prev) => (prev.some((m) => m.id === item.id) ? prev : [...prev, item]));
	const closeMessage = (id: number) =>
		setOpenMessages((prev) => prev.filter((m) => m.id !== id));

	const appMenu = [
		{
			id: "file",
			title: "File",
			menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
		},
	];

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
						<div className={styles.treeSearch} style={{ display: "flex", gap: 4, alignItems: "center" }}>
							<div style={{width: "75%"}}>
								<ClassicyInput
									id="newsgroup-filter"
									placeholder="Filter newsgroups…"
									labelDisabled
									onChangeFunc={(e) => setGroupQuery(e.target.value)}
								/>
							</div>
							<ClassicyButton buttonSize="medium" onClickFunc={expandAllGroups}>
								+
							</ClassicyButton>
							<ClassicyButton buttonSize="medium" onClickFunc={collapseAllGroups}>
								-
							</ClassicyButton>
						</div>
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
					<div className={styles.messageList}>
						{!selectedGroup && <p className={styles.hint}>Select a newsgroup to read.</p>}
						{selectedGroup && rows.length === 0 && (
							<p className={styles.hint}>No messages up to the current time.</p>
						)}
						{selectedGroup && rows.length > 0 && (
							<div className={styles.headerRow}>
								<button type="button" className={styles.colHeader} onClick={() => setSort("subject")}>
									Subject{sortMark("subject")}
								</button>
								<button type="button" className={styles.colHeader} onClick={() => setSort("author")}>
									Author{sortMark("author")}
								</button>
								<button type="button" className={styles.colHeader} onClick={() => setSort("date")}>
									Date{sortMark("date")}
								</button>
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
								<ClassicyTextEditor id={`${m.id}-body`} border prefillValue={m.body ?? ""} autoHeight disabled />
							</ClassicyControlGroup>
						</div>
					</div>
				</ClassicyWindow>
			))}
		</ClassicyApp>
	);
};
