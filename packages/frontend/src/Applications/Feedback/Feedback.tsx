import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
} from "classicy";
import appIconPng from "./app.png";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { FeedbackForm } from "./FeedbackForm";
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
			setIssueUrl(url);
			setView("success");
		},
		[submit],
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
					/>
				) : (
					<FeedbackSuccess issueUrl={issueUrl} onReset={handleReset} />
				)}
			</ClassicyWindow>
		</ClassicyApp>
	);
};
