import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AuthUser } from "../../Providers/Auth/authApi";

const mockUpdateProfile = vi.hoisted(() => vi.fn());
const mockRequestEmailChange = vi.hoisted(() => vi.fn());
vi.mock("../../Providers/Auth/profileApi", () => ({
	updateProfile: mockUpdateProfile,
	requestEmailChange: mockRequestEmailChange,
	confirmEmailChange: vi.fn(),
}));

const mockAuth = vi.hoisted(() => ({
	status: "signedIn" as const,
	user: null as AuthUser | null,
	signInWithEmail: vi.fn(),
	signInWithProvider: vi.fn(),
	signOut: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { ProfileEditor } from "./ProfileEditor";

// Fields are grouped under Classicy tabs; inactive panels render `hidden`, so
// their controls are out of the accessibility tree until the tab is selected.
// ClassicyTabs commits the active tab on mouseUp (not click).
const selectTab = (name: string) => fireEvent.mouseUp(screen.getByRole("tab", { name }));

const makeUser = (over: Partial<AuthUser>): AuthUser => ({
	id: "1", email: "t@x.org", first_name: null, last_name: null, avatar: null,
	provider: "google", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});

beforeEach(() => {
	mockAuth.user = makeUser({});
	mockAuth.refresh = vi.fn();
	mockUpdateProfile.mockReset().mockResolvedValue({});
	mockRequestEmailChange.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ProfileEditor — names", () => {
	it("saves typed names and refreshes", async () => {
		render(<ProfileEditor />);
		fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "Ada" } });
		fireEvent.change(screen.getByLabelText("Last Name"), { target: { value: "Lovelace" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Names" }));
		await waitFor(() =>
			expect(mockUpdateProfile).toHaveBeenCalledWith({ first_name: "Ada", last_name: "Lovelace" }),
		);
		expect(mockAuth.refresh).toHaveBeenCalled();
	});
	it("saves empty names as null", async () => {
		mockAuth.user = makeUser({ first_name: "Ada" });
		render(<ProfileEditor />);
		fireEvent.change(screen.getByLabelText("First Name"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Names" }));
		await waitFor(() =>
			expect(mockUpdateProfile).toHaveBeenCalledWith({ first_name: null, last_name: null }),
		);
	});
});

describe("ProfileEditor — about you (all optional)", () => {
	it("saves with everything empty (never blocks)", async () => {
		render(<ProfileEditor />);
		selectTab("About You");
		fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
		await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled());
		const patch = mockUpdateProfile.mock.calls[0][0];
		expect(patch.city).toBeNull();
		expect(patch.grade_levels).toBeNull();
		expect(screen.queryByText(/must/i)).toBeNull();
	});
	it("round-trips educator role and toggled grade levels", async () => {
		render(<ProfileEditor />);
		selectTab("About You");
		// ClassicyPopUpMenu renders as a <button id=…> + a listbox that mounts on
		// open (classicy quirk: the label isn't htmlFor-associated) — open it by id
		// and click the option's visible label.
		fireEvent.click(document.getElementById("profile-educator-role") as HTMLButtonElement);
		fireEvent.click(within(screen.getByRole("listbox")).getByText("Librarian"));
		fireEvent.click(screen.getByRole("button", { name: "High School" }));
		fireEvent.click(screen.getByRole("button", { name: "College" }));
		fireEvent.click(screen.getByRole("button", { name: "College" })); // toggle back off
		fireEvent.change(screen.getByLabelText("City"), { target: { value: "Memphis" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Profile" }));
		await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled());
		const patch = mockUpdateProfile.mock.calls[0][0];
		expect(patch.educator_role).toBe("librarian");
		expect(patch.grade_levels).toEqual(["high_school"]);
		expect(patch.city).toBe("Memphis");
	});
});

describe("ProfileEditor — email", () => {
	it("blocks mismatched addresses locally", async () => {
		render(<ProfileEditor />);
		selectTab("Email");
		fireEvent.change(screen.getByLabelText("New Email"), { target: { value: "a@b.co" } });
		fireEvent.change(screen.getByLabelText("Confirm New Email"), { target: { value: "b@b.co" } });
		fireEvent.click(screen.getByRole("button", { name: "Send Confirmation Link" }));
		expect(await screen.findByText("Email addresses do not match.")).not.toBeNull();
		expect(mockRequestEmailChange).not.toHaveBeenCalled();
	});
	it("sends the link and shows the sent state", async () => {
		render(<ProfileEditor />);
		selectTab("Email");
		fireEvent.change(screen.getByLabelText("New Email"), { target: { value: "new@x.org" } });
		fireEvent.change(screen.getByLabelText("Confirm New Email"), { target: { value: "new@x.org" } });
		fireEvent.click(screen.getByRole("button", { name: "Send Confirmation Link" }));
		await waitFor(() => expect(mockRequestEmailChange).toHaveBeenCalledWith("new@x.org"));
		expect(screen.getByText("Confirmation link sent — check your new inbox.")).not.toBeNull();
	});
});

describe("ProfileEditor — password", () => {
	it("is hidden for SSO accounts", () => {
		mockAuth.user = makeUser({ provider: "google" });
		render(<ProfileEditor />);
		expect(screen.queryByRole("button", { name: "Set Password" })).toBeNull();
	});
	it("validates locally then saves for default-provider accounts", async () => {
		mockAuth.user = makeUser({ provider: "default" });
		render(<ProfileEditor />);
		selectTab("Password");
		fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "short" } });
		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "short" } });
		fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
		expect(await screen.findByText("Password must be at least 8 characters.")).not.toBeNull();
		expect(mockUpdateProfile).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "longenough1" } });
		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "different1" } });
		fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
		expect(await screen.findByText("Passwords do not match.")).not.toBeNull();

		fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "longenough1" } });
		fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
		await waitFor(() =>
			expect(mockUpdateProfile).toHaveBeenCalledWith({ password: "longenough1" }),
		);
		expect(await screen.findByText("Password updated.")).not.toBeNull();
	});
	it("masks both password inputs", () => {
		mockAuth.user = makeUser({ provider: "default" });
		render(<ProfileEditor />);
		selectTab("Password");
		expect(screen.getByLabelText("New Password").getAttribute("type")).toBe("password");
		expect(screen.getByLabelText("Confirm Password").getAttribute("type")).toBe("password");
	});
});
