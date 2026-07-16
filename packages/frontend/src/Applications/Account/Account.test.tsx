import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { AuthUser } from "../../Providers/Auth/authApi";

// Partial classicy mock — ClassicyApp/ClassicyWindow require a real
// ClassicyAppManagerProvider tree to render their children (they bail out
// to an empty shell without one, same as every other app-shell test in this
// repo — see Weather.test.tsx/FlightTracker.test.tsx). Everything else
// (ClassicyButton, ClassicyInput, ClassicyIcons, registerClassicyIcons,
// quitMenuItemHelper) renders for real via importOriginal, so the form
// itself is exercised end-to-end.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyApp:    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock only the auth seam beyond that.
const mockAuth = vi.hoisted(() => ({
	status:              "anonymous" as "loading" | "anonymous" | "signedIn",
	user:                null as AuthUser | null,
	signInWithEmail:     vi.fn(),
	signInWithProvider:  vi.fn(),
	signOut:             vi.fn(),
	refresh:             vi.fn(),
}));

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { Account } from "./Account";

// Suppress classicy's analytics no-provider warning — expected in test environment
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => { warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });

beforeEach(() => {
	mockAuth.status = "anonymous";
	mockAuth.user = null;
	mockAuth.signInWithEmail = vi.fn();
	mockAuth.signInWithProvider = vi.fn();
	mockAuth.signOut = vi.fn();
	mockAuth.refresh = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	window.history.pushState({}, "", "/");
});

function fillCredentials(email: string, password: string) {
	fireEvent.change(screen.getByLabelText("Email"),    { target: { value: email } });
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
}

describe("Account — anonymous", () => {
	it("renders the Google provider button and the email/password form", () => {
		render(<Account />);
		expect(screen.getByRole("button", { name: "Sign in with Google" })).not.toBeNull();
		expect(screen.getByLabelText("Email")).not.toBeNull();
		expect(screen.getByLabelText("Password")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Sign In" })).not.toBeNull();
	});

	it("clicking the Google button calls signInWithProvider(\"google\")", () => {
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
		expect(mockAuth.signInWithProvider).toHaveBeenCalledWith("google");
	});

	it("Sign In is disabled until both fields are filled", () => {
		render(<Account />);
		expect((screen.getByRole("button", { name: "Sign In" }) as HTMLButtonElement).disabled).toBe(true);
		fillCredentials("teacher@example.com", "hunter2");
		expect((screen.getByRole("button", { name: "Sign In" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("submitting calls signInWithEmail with the typed values", async () => {
		mockAuth.signInWithEmail.mockResolvedValue(undefined);
		render(<Account />);
		fillCredentials("teacher@example.com", "hunter2");
		fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
		await waitFor(() => expect(mockAuth.signInWithEmail).toHaveBeenCalledWith("teacher@example.com", "hunter2"));
	});

	it("renders the thrown message verbatim under the form on sign-in failure", async () => {
		mockAuth.signInWithEmail.mockRejectedValue(new Error("Invalid email or password."));
		render(<Account />);
		fillCredentials("teacher@example.com", "wrong");
		fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
		await waitFor(() => expect(screen.getByText("Invalid email or password.")).not.toBeNull());
	});

	it("renders a ?reason= query param as the error line", () => {
		window.history.pushState({}, "", "/?reason=Google%20sign-in%20was%20cancelled");
		render(<Account />);
		expect(screen.getByText("Google sign-in was cancelled")).not.toBeNull();
	});
});

describe("Account — loading", () => {
	it("renders a quiet placeholder, not the form", () => {
		mockAuth.status = "loading";
		render(<Account />);
		expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
		expect(screen.queryByText(/signed in as/i)).toBeNull();
	});
});

describe("Account — signedIn", () => {
	it("shows the first_name identity, Sign Out button, and the coming-soon line", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "1", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" };
		render(<Account />);
		expect(screen.getByText("Signed in as Ada")).not.toBeNull();
		expect(screen.getByText("My Playlists — coming soon")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Sign Out" })).not.toBeNull();
	});

	it("falls back to email when first_name is null", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "1", email: "ada@example.com", first_name: null, last_name: null };
		render(<Account />);
		expect(screen.getByText("Signed in as ada@example.com")).not.toBeNull();
	});

	it("Sign Out calls signOut", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "1", email: "ada@example.com", first_name: "Ada", last_name: null };
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
		expect(mockAuth.signOut).toHaveBeenCalledOnce();
	});
});

describe("Account — preview origins", () => {
	it("replaces the form with the preview notice on a github.io hostname", () => {
		render(<Account hostnameForTest="my-org.github.io" />);
		expect(screen.getByText("Sign-in is unavailable on preview builds.")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
		expect(screen.queryByLabelText("Email")).toBeNull();
	});

	it("renders the form normally on a non-preview hostname", () => {
		render(<Account hostnameForTest="beta.911realtime.org" />);
		expect(screen.getByRole("button", { name: "Sign in with Google" })).not.toBeNull();
	});
});
