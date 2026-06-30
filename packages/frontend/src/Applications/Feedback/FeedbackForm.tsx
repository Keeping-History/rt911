import type React from "react";
import { useCallback, useRef, useState } from "react";
import type { FeedbackFields } from "./useFeedback";
import styles from "./Feedback.module.scss";

const MAX_FILES    = 5;
const MAX_FILE_MB  = 5;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain";

interface FeedbackFormProps {
	onSubmit:             (fields: FeedbackFields, attachments: File[]) => Promise<void>;
	submitting:           boolean;
	error:                string | null;
	onCaptureScreenshot:  () => Promise<File>;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({
	onSubmit,
	submitting,
	error,
	onCaptureScreenshot,
}) => {
	const [name,        setName]        = useState("");
	const [email,       setEmail]       = useState("");
	const [github,      setGithub]      = useState("");
	const [title,       setTitle]       = useState("");
	const [description, setDescription] = useState("");
	const [attachments, setAttachments] = useState<File[]>([]);
	const [fileError,   setFileError]   = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const canSubmit = !submitting && name.trim() !== "" && email.trim() !== "" && title.trim() !== "" && description.trim() !== "";

	const handleFiles = useCallback((incoming: File[]) => {
		setFileError(null);
		const combined = [...attachments, ...incoming];
		if (combined.length > MAX_FILES) {
			setFileError(`Max ${MAX_FILES} files allowed.`);
			return;
		}
		const oversized = incoming.find((f) => f.size > MAX_FILE_BYTES);
		if (oversized) {
			setFileError(`"${oversized.name}" exceeds ${MAX_FILE_MB} MB.`);
			return;
		}
		setAttachments(combined);
	}, [attachments]);

	const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files ?? []);
		if (files.length > 0) handleFiles(files);
		// reset so the same file can be re-selected
		if (fileInputRef.current) fileInputRef.current.value = "";
	}, [handleFiles]);

	const removeFile = useCallback((name: string) => {
		setAttachments((prev) => prev.filter((f) => f.name !== name));
	}, []);

	const handleScreenshot = useCallback(async () => {
		const file = await onCaptureScreenshot();
		setAttachments((prev) => [file, ...prev]);
	}, [onCaptureScreenshot]);

	const handleSubmit = useCallback(() => {
		if (!canSubmit) return;
		void onSubmit({ name, email, github, title, description }, attachments);
	}, [canSubmit, onSubmit, name, email, github, title, description, attachments]);

	return (
		<div className={styles.fbForm}>
			<div className={styles.fbField}>
				<label htmlFor="fb-name">Name</label>
				<input
					id="fb-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
				/>
			</div>

			<div className={styles.fbField}>
				<label htmlFor="fb-email">Email</label>
				<input
					id="fb-email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
			</div>

			<div className={styles.fbField}>
				<label htmlFor="fb-github">GitHub username (optional)</label>
				<input
					id="fb-github"
					type="text"
					value={github}
					onChange={(e) => setGithub(e.target.value)}
				/>
			</div>

			<div className={styles.fbField}>
				<label htmlFor="fb-title">Title</label>
				<input
					id="fb-title"
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					required
				/>
			</div>

			<div className={styles.fbField}>
				<label htmlFor="fb-description">Description</label>
				<textarea
					id="fb-description"
					rows={5}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					required
				/>
			</div>

			<div className={styles.fbAttachments}>
				<label htmlFor="fb-files">Attachments</label>
				<input
					id="fb-files"
					ref={fileInputRef}
					type="file"
					accept={ACCEPT}
					multiple
					onChange={handleFileChange}
				/>
				{fileError && <div className={styles.fbFileError}>{fileError}</div>}
				{attachments.length > 0 && (
					<ul className={styles.fbThumbs}>
						{attachments.map((f) => (
							<li key={f.name} className={styles.fbThumb}>
								<span>{f.name}</span>
								<button
									type="button"
									onMouseUp={() => removeFile(f.name)}
									aria-label={`Remove ${f.name}`}
									className={styles.fbRemoveBtn}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className={styles.fbActions}>
				<button type="button" className={styles.fbBtn} onMouseUp={() => void handleScreenshot()}>
					Capture Screenshot
				</button>
				<button
					type="button"
					className={styles.fbBtn}
					onMouseUp={handleSubmit}
					disabled={!canSubmit}
				>
					{submitting ? "Sending…" : "Send Feedback"}
				</button>
			</div>

			{error && <div className={styles.fbError}>{error}</div>}
		</div>
	);
};
