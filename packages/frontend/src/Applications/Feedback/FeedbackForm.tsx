import type React from "react";
import { useCallback, useRef, useState } from "react";
import {
    ClassicyButton,
    ClassicyFileInput,
    type ClassicyFileInputHandle,
    ClassicyInput,
    ClassicyTextEditor,
} from "classicy";
import type { FeedbackFields } from "./useFeedback";
import styles from "./Feedback.module.scss";

const MAX_FILES    = 5;
const MAX_FILE_MB  = 5;
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
    const [screenshotError, setScreenshotError] = useState<string | null>(null);
    const fileInputRef = useRef<ClassicyFileInputHandle>(null);

    const canSubmit = !submitting
        && name.trim() !== ""
        && email.trim() !== ""
        && title.trim() !== ""
        && description.trim() !== "";

    const handleScreenshot = useCallback(async () => {
        setScreenshotError(null);
        try {
            const file = await onCaptureScreenshot();
            fileInputRef.current?.addFiles([file]);
        } catch (err) {
            setScreenshotError(err instanceof Error ? err.message : "Screenshot failed.");
        }
    }, [onCaptureScreenshot]);

    const handleSubmit = useCallback(() => {
        if (!canSubmit) return;
        void onSubmit({ name, email, github, title, description }, attachments);
    }, [canSubmit, onSubmit, name, email, github, title, description, attachments]);

    return (
        <div className={styles.fbForm}>
            <ClassicyInput
                id="fb-name"
                labelTitle="Name"
                prefillValue={name}
                onChangeFunc={(e) => setName(e.target.value)}
            />
            <ClassicyInput
                id="fb-email"
                labelTitle="Email"
                prefillValue={email}
                onChangeFunc={(e) => setEmail(e.target.value)}
            />
            <ClassicyInput
                id="fb-github"
                labelTitle="GitHub username (optional)"
                prefillValue={github}
                onChangeFunc={(e) => setGithub(e.target.value)}
            />
            <ClassicyInput
                id="fb-title"
                labelTitle="Title"
                prefillValue={title}
                onChangeFunc={(e) => setTitle(e.target.value)}
            />
            <ClassicyTextEditor
                id="fb-description"
                labelTitle="Description"
                prefillValue={description}
                onChangeFunc={(e) => setDescription(e.target.value)}
                autoHeight
                border
            />
            <ClassicyFileInput
                ref={fileInputRef}
                id="fb-files"
                labelTitle="Attachments"
                accept={ACCEPT}
                multiple
                maxFiles={MAX_FILES}
                maxFileSizeMb={MAX_FILE_MB}
                onChangeFunc={setAttachments}
            />
            <div className={styles.fbActions}>
                <ClassicyButton onClickFunc={() => void handleScreenshot()}>
                    Capture Screenshot
                </ClassicyButton>
                <ClassicyButton
                    isDefault
                    disabled={!canSubmit}
                    onClickFunc={handleSubmit}
                >
                    {submitting ? "Sending…" : "Send Feedback"}
                </ClassicyButton>
            </div>
            {screenshotError && <div className={styles.fbError}>{screenshotError}</div>}
            {error && <div className={styles.fbError}>{error}</div>}
        </div>
    );
};
