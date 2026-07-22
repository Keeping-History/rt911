import {
	ClassicyAlert,
	ClassicyApp,
	ClassicyIcons,
	ClassicySoundActionTypes,
	useAppManager,
	useSoundDispatch,
} from "classicy";
import type React from "react";
import { useContext, useEffect, useMemo, useState } from "react";
import {
	type AlertItem,
	MediaStreamContext,
} from "../../Providers/MediaStream/MediaStreamContext";
import { useAlertsEnabled } from "./alertsSettings";

const appId = "Alerts.app";
const appName = "Alerts";
// Extensions have no desktop icon / Apple-menu entry, but ClassicyApp still
// requires an icon path; reuse an existing bundled icon rather than a
// non-existent asset since it is never actually rendered anywhere.
const appIcon = ClassicyIcons.applications.internetExplorer.documentWarning as string;

/**
 * Silent background extension (Task 8): subscribes to the opt-in "alerts"
 * channel for the lifetime of the app and surfaces at most one ClassicyAlert
 * modal at a time — the earliest revealed alert the user hasn't dismissed yet.
 * Clicking OK (or otherwise closing it) adds the alert's id to a session-only
 * `dismissed` set so it never re-fires, even if the virtual clock seeks back
 * and re-reveals it in MediaStreamProvider's buffer.
 */
export const Alerts: React.FC = () => {
	// Boolean selector (mirrors News.tsx's isRunning): the full apps[appId]
	// object changes reference on every window interaction, which would cause
	// this effect to re-run needlessly since extensions have no windows.
	const isRunning = useAppManager(
		(s) => appId in (s.System.Manager.Applications.apps ?? {}),
	);
	const enabled = useAlertsEnabled();
	const { alertItems, subscribeAlerts, unsubscribeAlerts } =
		useContext(MediaStreamContext);
	const soundDispatch = useSoundDispatch();

	const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());

	// The extension is always mounted; subscribe while the app entry exists AND
	// the user hasn't turned alerts off in the Alerts Manager control panel.
	useEffect(() => {
		if (!isRunning || !enabled) return;
		subscribeAlerts(appId);
		return () => unsubscribeAlerts(appId);
	}, [isRunning, enabled, subscribeAlerts, unsubscribeAlerts]);

	// Earliest revealed-but-undismissed alert, by start_date. Rendering only
	// this one gives the "one modal at a time" queue: OK dismisses it, the
	// next-earliest becomes current on the following render.
	const current = useMemo<AlertItem | undefined>(() => {
		return [...alertItems]
			.filter((a) => !dismissed.has(a.id))
			.sort(
				(a, b) =>
					new Date(a.start_date).getTime() - new Date(b.start_date).getTime(),
			)[0];
	}, [alertItems, dismissed]);

	// Ring the classic Mac alert chime each time a NEW alert dialog surfaces.
	// Keyed on the displayed alert's id (not the `current` object, whose
	// reference churns as the buffer updates) so it fires exactly once per
	// distinct alert — including when OK advances to the next queued alert —
	// and never on an unrelated re-render. Gated on the same `enabled && current`
	// condition that renders the dialog. Routing through the sound dispatcher
	// (rather than a raw Audio element) means it honors the Sound control panel's
	// volume, global mute, and the per-sound disable list.
	const currentId = current?.id;
	useEffect(() => {
		if (!enabled || currentId == null) return;
		soundDispatch({
			type: ClassicySoundActionTypes.ClassicySoundPlay,
			sound: "ClassicyAlertSosumi",
		});
	}, [enabled, currentId, soundDispatch]);

	const dismiss = (id: number) =>
		setDismissed((prev) => {
			const next = new Set(prev);
			next.add(id);
			return next;
		});

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			extension
			addSystemMenu={false}
		>
			{enabled && current && (
				<ClassicyAlert
					key={current.id}
					id={`${appId}_alert_${current.id}`}
					appId={appId}
					title={appName}
					alertType={current.severity ?? "note"}
					label={current.title}
					message={
						<div>
							{current.image && (
								<figure style={{ margin: "0 0 var(--window-padding-size) 0" }}>
									{/* biome-ignore lint/a11y/useAltText: decorative alert image, headline carries meaning */}
									<img src={current.image} style={{ maxWidth: "100%" }} alt="" />
									{current.image_caption && (
										<figcaption>{current.image_caption}</figcaption>
									)}
								</figure>
							)}
							{current.content && (
								<div
									// biome-ignore lint/security/noDangerouslySetInnerHtml: alert body authored in Directus alert_items
									dangerouslySetInnerHTML={{ __html: current.content }}
								/>
							)}
						</div>
					}
					buttons={[
						{
							id: "ok",
							label: "OK",
							role: "default",
							onClick: () => dismiss(current.id),
						},
					]}
					onClose={() => dismiss(current.id)}
				/>
			)}
		</ClassicyApp>
	);
};
