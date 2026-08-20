import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ClassicyButton,
    ClassicyFileInput,
    type ClassicyFileInputHandle,
    ClassicyInput,
    ClassicyTextEditor,
} from "classicy";
import type { FeedbackFields } from "./useFeedback";
import type { FeedbackDefaults } from "./feedbackSettings";
import styles from "./Feedback.module.scss";

const MAX_FILES    = 5;
const MAX_FILE_MB  = 5;
const ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain";

export interface FeedbackFormProps {
    onSubmit:             (fields: FeedbackFields, attachments: File[]) => Promise<void>;
    submitting:           boolean;
    error:                string | null;
    onCaptureScreenshot:  () => Promise<File>;
    /** Pre-fill values (signed-in identity, remembered GitHub handle). */
    defaults:             FeedbackDefaults;
}

/**
 * A text field that tracks `initial` until the reporter types into it, then owns
 * its own value forever.
 *
 * Plain `useState(initial)` won't do: this app is mounted at desktop boot
 * (Desktop.tsx renders it unconditionally), so the form's first render happens
 * well before AuthProvider's session check resolves — the identity always
 * arrives late. Re-seeding on every `initial` change won't do either: that
 * overwrites whatever the reporter was already typing when auth lands, and
 * refills a field they deliberately cleared.
 */
function useSeededField(initial: string): [string, (value: string) => void] {
    const [value, setValue] = useState(initial);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        if (!dirty) setValue(initial);
    }, [initial, dirty]);

    const change = useCallback((next: string) => {
        setDirty(true);
        setValue(next);
    }, []);

    return [value, change];
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({
    onSubmit,
    submitting,
    error,
    onCaptureScreenshot,
    defaults,
}) => {
    const [name,        setName]        = useSeededField(defaults.name);
    const [email,       setEmail]       = useSeededField(defaults.email);
    const [github,      setGithub]      = useSeededField(defaults.github);
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
                labelPosition="left"
                prefillValue={name}
                onChangeFunc={(e) => setName(e.target.value)}
            />
            <ClassicyInput
                id="fb-email"
                labelTitle="Email"
                labelPosition="left"
                prefillValue={email}
                onChangeFunc={(e) => setEmail(e.target.value)}
            />
            <ClassicyInput
                id="fb-github"
                labelTitle="GitHub username (optional)"
                labelPosition="left"
                prefillValue={github}
                onChangeFunc={(e) => setGithub(e.target.value)}
            />
            <ClassicyInput
                id="fb-title"
                labelTitle="Title"
                labelPosition="left"
                prefillValue={title}
                onChangeFunc={(e) => setTitle(e.target.value)}
            />
            <ClassicyFileInput
                ref={fileInputRef}
                id="fb-files"
                labelTitle="Attachments"
                labelPosition="left"
                accept={ACCEPT}
                multiple
                maxFiles={MAX_FILES}
                maxFileSizeMb={MAX_FILE_MB}
                onChangeFunc={setAttachments}
            />
            {/* Description keeps its label above: a multi-line box next to a
                one-line label column reads badly and wastes the editor's width. */}
            <ClassicyTextEditor
                id="fb-description"
                labelTitle="Description"
                prefillValue={description}
                onChangeFunc={(e) => setDescription(e.target.value)}
                autoHeight
                border
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
