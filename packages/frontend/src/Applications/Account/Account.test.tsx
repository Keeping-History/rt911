import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { AuthUser } from "../../Providers/Auth/authApi";

const mockUploadAvatar = vi.hoisted(() => vi.fn());
const mockVerifyRegistration = vi.hoisted(() => vi.fn());
vi.mock("../../Providers/Auth/authApi", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	uploadAvatar: mockUploadAvatar,
	verifyRegistration: mockVerifyRegistration,
}));

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
const mockConfirmEmailChange = vi.hoisted(() => vi.fn());
vi.mock("../../Providers/Auth/profileApi", () => ({
	updateProfile: vi.fn(async () => ({})),
	requestEmailChange: vi.fn(async () => undefined),
	confirmEmailChange: mockConfirmEmailChange,
}));

const mockAuth = vi.hoisted(() => ({
	status:              "anonymous" as "loading" | "anonymous" | "signedIn",
	user:                null as AuthUser | null,
	signInWithEmail:     vi.fn(),
	signInWithProvider:  vi.fn(),
	signOut:             vi.fn(),
	refresh:             vi.fn(),
	register:            vi.fn(),
}));

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { Account } from "./Account";
import { avatarUrl } from "../../Providers/Auth/authApi";

// Fill the non-essential AuthUser fields so fixtures stay one-line.
const makeUser = (over: Partial<AuthUser>): AuthUser => ({
	id: "1", email: null, first_name: null, last_name: null, avatar: null,
	provider: "google", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});


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
	mockAuth.register = vi.fn();
	mockUploadAvatar.mockReset();
	mockVerifyRegistration.mockReset();
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
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", avatar: null });
		render(<Account />);
		expect(screen.getByText("Signed in as Ada")).not.toBeNull();
		expect(screen.getByText("My Playlists — coming soon")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Sign Out" })).not.toBeNull();
	});

	it("falls back to email when first_name is null", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: null, last_name: null, avatar: null });
		render(<Account />);
		expect(screen.getByText("Signed in as ada@example.com")).not.toBeNull();
	});

	it("Sign Out calls signOut", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
		expect(mockAuth.signOut).toHaveBeenCalledOnce();
	});
});

describe("Account — avatar", () => {
	beforeEach(() => {
		mockAuth.status = "signedIn";
	});

	it("renders the avatar image with the preset URL when the user has one", () => {
		mockAuth.user = makeUser({
			id:         "1",
			email:      "ada@example.com",
			first_name: "Ada",
			last_name:  null,
			avatar:     "file-1",
		});
		render(<Account />);
		const img = screen.getByAltText("Your avatar") as HTMLImageElement;
		expect(img.src).toBe(avatarUrl("file-1"));
		expect(img.width).toBe(74);
		expect(img.height).toBe(74);
		expect(screen.getByRole("button", { name: "Change Avatar" })).not.toBeNull();
	});

	it("renders no avatar image and an Upload Avatar label when the user has none", () => {
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		render(<Account />);
		expect(screen.queryByAltText("Your avatar")).toBeNull();
		expect(screen.getByRole("button", { name: "Upload Avatar" })).not.toBeNull();
	});

	it("rejects an oversized file before calling uploadAvatar", async () => {
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		render(<Account />);
		const file = new File([new ArrayBuffer(1)], "big.png", { type: "image/png" });
		Object.defineProperty(file, "size", { value: 51 * 1024 * 1024 });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(screen.getByText("Image must be 50 MB or smaller.")).not.toBeNull(),
		);
		expect(mockUploadAvatar).not.toHaveBeenCalled();
	});

	it("rejects a non-image file before calling uploadAvatar", async () => {
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		render(<Account />);
		const file = new File([new ArrayBuffer(1)], "doc.pdf", { type: "application/pdf" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() =>
			expect(screen.getByText("Please choose an image file.")).not.toBeNull(),
		);
		expect(mockUploadAvatar).not.toHaveBeenCalled();
	});

	it("uploads a valid image and calls refresh on success", async () => {
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		mockUploadAvatar.mockResolvedValue("new-file");
		render(<Account />);
		const file = new File([new ArrayBuffer(1)], "avatar.png", { type: "image/png" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => expect(mockUploadAvatar).toHaveBeenCalledWith(file, null));
		await waitFor(() => expect(mockAuth.refresh).toHaveBeenCalledOnce());
	});

	it("renders upload errors verbatim", async () => {
		mockAuth.user = makeUser({ id: "1", email: "ada@example.com", first_name: "Ada", last_name: null, avatar: null });
		mockUploadAvatar.mockRejectedValue(new Error("Upload rejected by server."));
		render(<Account />);
		const file = new File([new ArrayBuffer(1)], "avatar.png", { type: "image/png" });

		const input = document.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => expect(screen.getByText("Upload rejected by server.")).not.toBeNull());
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

	it("masks the password field (classicy type passthrough)", () => {
		render(<Account />);
		expect(
			document.getElementById("account-password")?.getAttribute("type"),
		).toBe("password");
	});
});

describe("Account — email-change confirm link", () => {
	it("confirms immediately when signed in and shows the new email", async () => {
		window.history.pushState({}, "", "/?confirm-email=tok123");
		mockConfirmEmailChange.mockResolvedValue("new@x.org");
		mockAuth.status = "signedIn";
		mockAuth.user = makeUser({ email: "old@x.org", first_name: "Ada" });
		render(<Account />);
		await waitFor(() =>
			expect(mockConfirmEmailChange).toHaveBeenCalledWith("tok123"),
		);
		expect(await screen.findByText("Your email is now new@x.org.")).not.toBeNull();
		expect(window.location.search).not.toContain("confirm-email");
		expect(mockAuth.refresh).toHaveBeenCalled();
	});

	it("prompts to sign in when anonymous, then confirms after status flips", async () => {
		window.history.pushState({}, "", "/?confirm-email=tok456");
		mockConfirmEmailChange.mockResolvedValue("new@x.org");
		mockAuth.status = "anonymous";
		const { rerender } = render(<Account />);
		expect(
			screen.getByText("Sign in to confirm your new email address."),
		).not.toBeNull();
		expect(mockConfirmEmailChange).not.toHaveBeenCalled();
		mockAuth.status = "signedIn";
		mockAuth.user = makeUser({ email: "old@x.org" });
		rerender(<Account />);
		await waitFor(() =>
			expect(mockConfirmEmailChange).toHaveBeenCalledWith("tok456"),
		);
	});

	it("renders the confirm error verbatim on a bad token", async () => {
		window.history.pushState({}, "", "/?confirm-email=expired");
		mockConfirmEmailChange.mockRejectedValue(
			new Error("This confirmation link is invalid or has expired."),
		);
		mockAuth.status = "signedIn";
		mockAuth.user = makeUser({ email: "old@x.org" });
		render(<Account />);
		expect(
			await screen.findByText("This confirmation link is invalid or has expired."),
		).not.toBeNull();
	});
});

describe("Account — create an account", () => {
	it("switches to the registration view and back", () => {
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Create an Account" }));
		expect(screen.getByRole("button", { name: "Create Account" })).not.toBeNull();
		expect(screen.getByLabelText("Confirm Password")).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Back to Sign In" }));
		expect(screen.getByRole("button", { name: "Sign In" })).not.toBeNull();
	});
	it("validates locally before calling register", async () => {
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Create an Account" }));
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "t@x.org" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "short" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
		expect(await screen.findByText("Password must be at least 8 characters.")).not.toBeNull();
		expect(mockAuth.register).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough1" } });
		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "different1" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
		expect(await screen.findByText("Passwords do not match.")).not.toBeNull();
	});
	it("registers and shows the check-your-email state", async () => {
		mockAuth.register.mockResolvedValue(undefined);
		render(<Account />);
		fireEvent.click(screen.getByRole("button", { name: "Create an Account" }));
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "t@x.org" } });
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough1" } });
		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "longenough1" } });
		fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
		await waitFor(() => expect(mockAuth.register).toHaveBeenCalledWith("t@x.org", "longenough1"));
		expect(
			await screen.findByText("Check your email to verify your account, then sign in."),
		).not.toBeNull();
	});
});

describe("Account — registration verification link", () => {
	it("verifies the ?token= param and shows the verified banner", async () => {
		window.history.pushState({}, "", "/?token=regtok1");
		mockVerifyRegistration.mockResolvedValue(undefined);
		render(<Account />);
		await waitFor(() => expect(mockVerifyRegistration).toHaveBeenCalledWith("regtok1"));
		expect(
			await screen.findByText("Email verified — you can now sign in."),
		).not.toBeNull();
		expect(window.location.search).not.toContain("token");
	});
	it("renders the verification error verbatim", async () => {
		window.history.pushState({}, "", "/?token=expired");
		mockVerifyRegistration.mockRejectedValue(
			new Error("This verification link is invalid or has expired."),
		);
		render(<Account />);
		expect(
			await screen.findByText("This verification link is invalid or has expired."),
		).not.toBeNull();
	});
});
