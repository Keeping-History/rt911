import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { FeedbackForm } from "./FeedbackForm";
import "./FeedbackContext";
import { feedbackDefaults, feedbackSetGithub, readStoredGithub } from "./feedbackSettings";
import { FeedbackSuccess } from "./FeedbackSuccess";
import { FEEDBACK_APP_ID, useFeedback } from "./useFeedback";
import type { FeedbackFields } from "./useFeedback";

const appId   = FEEDBACK_APP_ID;
const appName = "Feedback";

// This app's own icon, registered into the shared registry at
// ClassicyIcons.applications.feedback.app. registerClassicyIcons assigns
// shallowly, so the existing applications namespace is spread in to keep
// classicy's bundled app icons (and other apps' registrations) intact.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		feedback: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.feedback.app;

export const Feedback: React.FC = () => {
	const [view,     setView]     = useState<"form" | "success">("form");
	const [issueUrl, setIssueUrl] = useState("");

	const { state, captureScreenshot, submit } = useFeedback();

	// Identity is read live rather than snapshotted: `user` is null until
	// AuthProvider's session check returns, which happens well after this app
	// mounts (Desktop.tsx renders it at boot, not on window-open).
	const { user } = useAuth();
	const appData = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const desktopEventDispatch = useAppManagerDispatch();

	const defaults = useMemo(
		() => feedbackDefaults(user, readStoredGithub(appData)),
		[user, appData],
	);

	const appMenu = useMemo(
		() => [
			{
				id:           "file",
				title:        "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[],
	);

	const handleSubmit = useCallback(
		async (fields: FeedbackFields, attachments: File[]) => {
			const url = await submit(fields, attachments);
			// Remember the handle the report actually went out under — including
			// an empty one, so clearing the field sticks instead of falling back
			// to the previously remembered handle on the next report.
			desktopEventDispatch(feedbackSetGithub(fields.github));
			setIssueUrl(url);
			setView("success");
		},
		[submit, desktopEventDispatch],
	);

	const handleReset = useCallback(() => {
		setView("form");
		setIssueUrl("");
	}, []);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="feedback_main"
			addSystemMenu={false}
		>
			<ClassicyWindow
				id="feedback_main"
				title="Feedback"
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={false}
				zoomable={false}
				scrollable={false}
				collapsable={false}
				initialSize={["45%", 0]}
				initialPosition={[250, 150]}
				modal={false}
				appMenu={appMenu}
			>
				{view === "form" ? (
					<FeedbackForm
						onSubmit={handleSubmit}
						submitting={state.submitting}
						error={state.error}
						onCaptureScreenshot={captureScreenshot}
						defaults={defaults}
					/>
				) : (
					<FeedbackSuccess issueUrl={issueUrl} onReset={handleReset} />
				)}
			</ClassicyWindow>
		</ClassicyApp>
	);
};
