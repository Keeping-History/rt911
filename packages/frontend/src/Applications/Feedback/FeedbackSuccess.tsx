import type React from "react";
import styles from "./Feedback.module.scss";

interface FeedbackSuccessProps {
	issueUrl: string;
	onReset:  () => void;
}

export const FeedbackSuccess: React.FC<FeedbackSuccessProps> = ({ issueUrl, onReset }) => (
	<div className={styles.fbSuccess}>
		<p>Thanks for your feedback! Your report has been submitted.</p>
		<a
			href={issueUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={styles.fbSuccessLink}
		>
			View your GitHub issue
		</a>
		<button type="button" className={styles.fbBtn} onMouseUp={onReset}>
			Send Another Feedback
		</button>
	</div>
);
