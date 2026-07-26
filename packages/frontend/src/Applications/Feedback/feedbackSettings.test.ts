import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import {
	feedbackDefaults,
	feedbackSetGithub,
	readStoredGithub,
} from "./feedbackSettings";

const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
	id: "1",
	email: "ada@example.com",
	first_name: "Ada",
	last_name: "Lovelace",
	avatar: null,
	provider: "default",
	city: null,
	state: null,
	country: null,
	school_name: null,
	educator_role: null,
	grade_levels: null,
	subjects: null,
	...over,
});

describe("readStoredGithub", () => {
	it("returns undefined when the app has never stored a handle", () => {
		expect(readStoredGithub(undefined)).toBeUndefined();
		expect(readStoredGithub({})).toBeUndefined();
	});

	it("returns an empty string the user deliberately saved", () => {
		// The whole point of the undefined/"" split: a cleared handle must stay
		// cleared instead of falling back to the previously remembered one.
		expect(readStoredGithub({ github: "" })).toBe("");
	});

	it("returns the stored handle", () => {
		expect(readStoredGithub({ github: "octocat" })).toBe("octocat");
	});

	it("ignores a non-string value from a hand-edited localStorage snapshot", () => {
		expect(readStoredGithub({ github: 42 })).toBeUndefined();
	});
});

describe("feedbackSetGithub", () => {
	it("builds a ClassicyAppFeedback-namespaced action carrying the handle", () => {
		expect(feedbackSetGithub("octocat")).toEqual({
			type: "ClassicyAppFeedbackSetGithub",
			github: "octocat",
		});
	});
});

describe("feedbackDefaults", () => {
	it("fills name and email from the signed-in user", () => {
		expect(feedbackDefaults(makeUser(), undefined)).toEqual({
			name: "Ada Lovelace",
			email: "ada@example.com",
			github: "",
		});
	});

	it("uses just the first name when there is no last name", () => {
		expect(feedbackDefaults(makeUser({ last_name: null }), undefined).name).toBe("Ada");
	});

	it("leaves the name blank when the account has no name on it", () => {
		// Deliberately not the email: this field is asking who the person is, and
		// the email already has its own field right below it.
		expect(
			feedbackDefaults(makeUser({ first_name: null, last_name: null }), undefined).name,
		).toBe("");
	});

	it("leaves name and email blank for an anonymous visitor", () => {
		expect(feedbackDefaults(null, undefined)).toEqual({ name: "", email: "", github: "" });
	});

	it("prefills the remembered github handle", () => {
		expect(feedbackDefaults(null, "octocat").github).toBe("octocat");
	});

	it("keeps github blank when the user previously cleared it", () => {
		expect(feedbackDefaults(makeUser(), "").github).toBe("");
	});
});
