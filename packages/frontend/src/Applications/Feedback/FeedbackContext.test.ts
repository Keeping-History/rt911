import type { ActionMessage, ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { classicyFeedbackEventHandler } from "./FeedbackContext";
import { feedbackSetGithub, readStoredGithub } from "./feedbackSettings";

// A minimal store shaped like the slice the handler touches.
function storeWith(data: Record<string, unknown> | undefined): ClassicyStore {
	return {
		System: {
			Manager: { Applications: { apps: { "Feedback.app": { data } } } },
		},
	} as unknown as ClassicyStore;
}

const dataOf = (ds: ClassicyStore) =>
	ds.System.Manager.Applications.apps["Feedback.app"].data as Record<string, unknown>;

describe("classicyFeedbackEventHandler", () => {
	it("writes the github handle into the Feedback.app data slice", () => {
		const out = classicyFeedbackEventHandler(
			storeWith({ existing: true }),
			feedbackSetGithub("octocat") as ActionMessage,
		);
		expect(dataOf(out)).toEqual({ existing: true, github: "octocat" });
	});

	it("stores an empty handle rather than dropping the key", () => {
		// Round-trips as "" (cleared), not undefined (never entered) — otherwise
		// the next open would resurrect the handle the user just deleted.
		const out = classicyFeedbackEventHandler(
			storeWith({ github: "octocat" }),
			feedbackSetGithub("") as ActionMessage,
		);
		expect(readStoredGithub(dataOf(out))).toBe("");
	});

	it("ignores actions it does not own", () => {
		const out = classicyFeedbackEventHandler(
			storeWith({ github: "octocat" }),
			{ type: "SomethingElse" } as ActionMessage,
		);
		expect(dataOf(out)).toEqual({ github: "octocat" });
	});

	it("no-ops when the app is not mounted", () => {
		const ds = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(() =>
			classicyFeedbackEventHandler(ds, feedbackSetGithub("octocat") as ActionMessage),
		).not.toThrow();
	});
});
