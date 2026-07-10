import html2canvas from "html2canvas-pro";
import { useCallback, useState } from "react";
import { getSessionURL } from "../../openreplay";

// Also the `id` of <ClassicyApp> in Feedback.tsx. Classicy gives every window
// a DOM id of `${appId}_${windowId}`, which is how captureScreenshot excludes
// this app's own windows from the shot.
export const FEEDBACK_APP_ID = "Feedback.app";

export interface FeedbackFields {
	name:        string;
	email:       string;
	github:      string;
	title:       string;
	description: string;
}

export interface FeedbackState {
	submitting: boolean;
	error:      string | null;
}

export function useFeedback(): {
	state:             FeedbackState;
	captureScreenshot: () => Promise<File>;
	submit:            (fields: FeedbackFields, attachments: File[]) => Promise<string>;
} {
	const [state, setState] = useState<FeedbackState>({ submitting: false, error: null });

	const captureScreenshot = useCallback(async (): Promise<File> => {
		const root = document.getElementById("root")!;
		const canvas = await html2canvas(root, {
			useCORS:        true,
			ignoreElements: (el) => {
				// html2canvas re-renders the DOM rather than grabbing the real
				// screen, so skipping this app's windows is what "hides" them.
				if (el.id.startsWith(`${FEEDBACK_APP_ID}_`)) return true;
				if (el.tagName !== "IFRAME") return false;
				try {
					return new URL((el as HTMLIFrameElement).src).origin !== window.location.origin;
				} catch {
					return true;
				}
			},
		});
		return new Promise<File>((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
				resolve(new File([blob], "screenshot.png", { type: "image/png" }));
			}, "image/png");
		});
	}, []);

	const submit = useCallback(async (fields: FeedbackFields, attachments: File[]): Promise<string> => {
		setState({ submitting: true, error: null });

		const body = new FormData();
		body.append("name",        fields.name);
		body.append("email",       fields.email);
		body.append("github",      fields.github);
		body.append("title",       fields.title);
		body.append("description", fields.description);

		const sessionUrl = getSessionURL();
		if (sessionUrl) body.append("sessionUrl", sessionUrl);

		for (const file of attachments) {
			body.append("attachments[]", file);
		}

		const base = import.meta.env.VITE_FEEDBACK_URL || "http://localhost:8080";

		try {
			const res = await fetch(`${base}/feedback`, { method: "POST", body });
			const json = await res.json() as { ok?: boolean; issueUrl?: string; error?: string };

			if (!res.ok) {
				const msg = json.error ?? `HTTP ${res.status}`;
				setState({ submitting: false, error: msg });
				throw new Error(msg);
			}

			setState({ submitting: false, error: null });
			return json.issueUrl!;
		} catch (err) {
			// Only update state here for errors not already handled above (network failures, JSON parse errors).
			setState((prev) =>
				prev.error ? prev : { submitting: false, error: err instanceof Error ? err.message : String(err) },
			);
			throw err;
		}
	}, []);

	return { state, captureScreenshot, submit };
}
