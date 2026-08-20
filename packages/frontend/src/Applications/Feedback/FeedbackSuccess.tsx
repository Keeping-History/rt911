import { ClassicyButton, ClassicyLink } from "classicy";
import type React from "react";
import styles from "./Feedback.module.scss";

interface FeedbackSuccessProps {
	issueUrl: string;
	onReset:  () => void;
}

export const FeedbackSuccess: React.FC<FeedbackSuccessProps> = ({ issueUrl, onReset }) => (
	<div className={styles.fbSuccess}>
		<p>Thanks for your feedback! Your report has been submitted.</p>
		<ClassicyLink
			href={issueUrl}
			disposition="browser-new"
			target="_blank"
			rel="noopener noreferrer"
			className={styles.fbSuccessLink}
		>
			View your GitHub issue
		</ClassicyLink>
		<ClassicyButton onClickFunc={onReset}>Send Another Feedback</ClassicyButton>
	</div>
);
