import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type { FeedbackDefaults } from "./feedbackSettings";

const dispatched = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appData    = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }));
const authUser   = vi.hoisted(() => ({ current: null as AuthUser | null }));
const formProps  = vi.hoisted(() => [] as Array<{ defaults: FeedbackDefaults }>);
const submitted  = vi.hoisted(() => ({ github: "octocat" }));

vi.mock("classicy", () => ({
	ClassicyApp: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	// FeedbackSuccess renders once a report goes through.
	ClassicyButton: (props: { children?: React.ReactNode; onClickFunc?: () => void }) => (
		<button type="button" onClick={props.onClickFunc}>{props.children}</button>
	),
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: (icons: Record<string, unknown>) => icons,
	registerAppEventHandler: () => {},
	quitMenuItemHelper: () => ({ id: "quit" }),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: { Applications: { apps: { "Feedback.app": { data: appData.current } } } },
			},
		}),
	useAppManagerDispatch: () => (action: Record<string, unknown>) => {
		dispatched.push(action);
	},
}));

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ status: authUser.current ? "signedIn" : "anonymous", user: authUser.current }),
}));

vi.mock("./useFeedback", () => ({
	FEEDBACK_APP_ID: "Feedback.app",
	useFeedback: () => ({
		state: { submitting: false, error: null },
		captureScreenshot: vi.fn(),
		submit: vi.fn().mockResolvedValue("https://github.com/x/y/issues/1"),
	}),
}));

// Stubbed so this file tests the container's wiring (identity in, persistence
// out) rather than re-testing the form — FeedbackForm.test.tsx covers that.
vi.mock("./FeedbackForm", () => ({
	FeedbackForm: (props: {
		defaults: FeedbackDefaults;
		onSubmit: (fields: Record<string, string>, files: File[]) => Promise<void>;
	}) => {
		formProps.push(props);
		return (
			<button
				type="button"
				onClick={() =>
					void props.onSubmit(
						{
							name: "Ada", email: "ada@example.com", github: submitted.github,
							title: "T", description: "D",
						},
						[],
					)
				}
			>
				stub-submit
			</button>
		);
	},
}));

const { Feedback } = await import("./Feedback");

const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
	id: "1", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace",
	avatar: null, provider: "default", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});

const latestDefaults = () => formProps[formProps.length - 1].defaults;

beforeEach(() => {
	dispatched.length = 0;
	formProps.length  = 0;
	appData.current   = undefined;
	authUser.current  = null;
	submitted.github  = "octocat";
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Feedback", () => {
	it("hands the signed-in user's name and email to the form", () => {
		authUser.current = makeUser();
		render(<Feedback />);
		expect(latestDefaults()).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com" });
	});

	it("leaves name and email blank for an anonymous visitor", () => {
		render(<Feedback />);
		expect(latestDefaults()).toMatchObject({ name: "", email: "" });
	});

	it("hands the remembered github handle to the form", () => {
		appData.current = { github: "octocat" };
		render(<Feedback />);
		expect(latestDefaults().github).toBe("octocat");
	});

	it("remembers the github handle a report was sent under", async () => {
		render(<Feedback />);
		fireEvent.click(screen.getByRole("button", { name: "stub-submit" }));
		await waitFor(() =>
			expect(dispatched).toContainEqual({
				type: "ClassicyAppFeedbackSetGithub",
				github: "octocat",
			}),
		);
	});

	it("remembers a github handle the reporter cleared", async () => {
		// Persisting "" is the point: the next report must not silently resurrect
		// the handle they just deleted.
		appData.current  = { github: "octocat" };
		submitted.github = "";
		render(<Feedback />);
		fireEvent.click(screen.getByRole("button", { name: "stub-submit" }));
		await waitFor(() =>
			expect(dispatched).toContainEqual({
				type: "ClassicyAppFeedbackSetGithub",
				github: "",
			}),
		);
	});
});
