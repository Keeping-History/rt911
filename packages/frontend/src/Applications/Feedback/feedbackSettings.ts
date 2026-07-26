import type { ActionMessage } from "classicy";
import type { AuthUser } from "../../Providers/Auth/authApi";

/** The three fields the form can pre-fill on the user's behalf. */
export interface FeedbackDefaults {
	name:   string;
	email:  string;
	github: string;
}

/**
 * Remember the GitHub handle the reporter last sent feedback under. classicy
 * snapshots app data to localStorage, so persisting is just a dispatch — see
 * README/readmeSettings.ts for the same pattern.
 */
export const feedbackSetGithub = (github: string): ActionMessage => ({
	type: "ClassicyAppFeedbackSetGithub",
	github,
});

/**
 * `undefined` and `""` mean different things here and must stay distinct:
 * `undefined` = never entered a handle (no stored opinion), `""` = entered one
 * and later cleared it. Collapsing them (e.g. `stored || ""` on write, or a
 * truthiness check on read) would resurrect an old handle after the user
 * deliberately wiped the field.
 *
 * Stored state comes from localStorage, so a hand-edited or stale snapshot
 * could hold anything — anything that isn't a string reads as "never entered".
 */
export const readStoredGithub = (
	data: Record<string, unknown> | undefined,
): string | undefined =>
	typeof data?.github === "string" ? data.github : undefined;

/**
 * Pre-fill values for a freshly-opened form. Name/email come from the Directus
 * session (nothing to remember — signing in *is* the source of truth), while
 * github is device-local because it isn't part of the account profile.
 */
export const feedbackDefaults = (
	user: AuthUser | null,
	storedGithub: string | undefined,
): FeedbackDefaults => ({
	// Blank rather than the email when the account carries no name: the field
	// asks who the reporter is, and email has its own field directly below.
	name:   [user?.first_name, user?.last_name].filter(Boolean).join(" "),
	email:  user?.email ?? "",
	github: storedGithub ?? "",
});
