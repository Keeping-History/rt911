import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { FeedbackForm } from "./FeedbackForm";
import { FeedbackSuccess } from "./FeedbackSuccess";
import { useFeedback } from "./useFeedback";
import type { FeedbackFields } from "./useFeedback";

const appId   = "Feedback.app";
const appName = "Feedback";
const appIcon = ClassicyIcons.system.bomb as string;

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
				initialSize={["25%", "25%"]}
				initialPosition={["left", "top"]}
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
