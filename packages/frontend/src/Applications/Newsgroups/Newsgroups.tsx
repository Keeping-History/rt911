import {
	ClassicyApp,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyInput,
	ClassicyTextEditor,
	ClassicyWindow,
	quitMenuItemHelper,
} from "classicy";
import { useState } from "react";
import type { UsenetItem } from "../../Providers/MediaStream/MediaStreamContext";
import styles from "./Newsgroups.module.scss";
import { useNewsgroups } from "./useNewsgroups";

export const Newsgroups = () => {
	const appId = "Newsgroups.app";
	const appName = "Newsgroups";
	const appIcon = ClassicyIcons.applications.internetExplorer.mailbox;

	const { groups, selectedGroup, selectGroup, thread, connected } = useNewsgroups(appId);

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
						{groups.length === 0 && (
							<p className={styles.hint}>
								{connected ? "Loading newsgroups…" : "Waiting for server…"}
							</p>
						)}
						{groups.map((g) => (
							<button
								key={g}
								type="button"
								className={`${styles.groupRow} ${g === selectedGroup ? styles.active : ""}`}
								onClick={() => selectGroup(g)}
							>
								{g}
							</button>
						))}
					</div>
					<div className={styles.messageList}>
						{!selectedGroup && <p className={styles.hint}>Select a newsgroup to read.</p>}
						{selectedGroup && thread.length === 0 && (
							<p className={styles.hint}>No messages up to the current time.</p>
						)}
						{thread.map(({ item, depth }) => (
							<button
								key={item.id}
								type="button"
								className={styles.messageRow}
								style={{ paddingLeft: 8 + depth * 18 }}
								onDoubleClick={() => openMessage(item)}
								onKeyDown={(e) => e.key === "Enter" && openMessage(item)}
							>
								<span className={styles.subject}>{item.subject?.trim() || "(no subject)"}</span>
								<span className={styles.author}>{item.author}</span>
							</button>
						))}
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
