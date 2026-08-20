import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import type { AuthUser } from "../../Providers/Auth/authApi";

const mockDeleteMyData = vi.hoisted(() => vi.fn());
const mockDeleteMyAccount = vi.hoisted(() => vi.fn());
const mockClearLocalSettings = vi.hoisted(() => vi.fn());
const mockReloadDesktop = vi.hoisted(() => vi.fn());

vi.mock("../../Providers/Auth/accountApi", () => ({
	deleteMyData: mockDeleteMyData,
	deleteMyAccount: mockDeleteMyAccount,
	clearLocalSettings: mockClearLocalSettings,
	reloadDesktop: mockReloadDesktop,
}));

const mockAuth = vi.hoisted(() => ({ user: null as AuthUser | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	// Renders label, message and ALL buttons with their disabled state, so
	// tests can drive the typed-confirm gate without classicy's window chrome.
	ClassicyAlert: ({
		label,
		message,
		buttons,
	}: {
		label: string;
		message?: React.ReactNode;
		buttons?: { label: string; disabled?: boolean; onClick?: () => void }[];
	}) => (
		<div role="alertdialog" aria-label={label}>
			<span>{label}</span>
			{message}
			{buttons?.map((b) => (
				<button key={b.label} type="button" disabled={b.disabled} onClick={b.onClick}>
					{b.label}
				</button>
			))}
		</div>
	),
}));

import { SpecialTab } from "./SpecialTab";

const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
	id: "1", email: "t@x.org", username: "mrbyrd", first_name: null, last_name: null,
	avatar: null, provider: "google", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});

beforeEach(() => {
	mockAuth.user = makeUser();
	mockDeleteMyData.mockReset().mockResolvedValue({ deleted: {}, failed: [] });
	mockDeleteMyAccount.mockReset().mockResolvedValue({ deleted: {}, failed: [] });
	mockClearLocalSettings.mockReset();
	mockReloadDesktop.mockReset();
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SpecialTab — delete my data", () => {
	it("shows a confirmation before touching the network", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		expect(screen.getByRole("alertdialog")).toBeTruthy();
		expect(mockDeleteMyData).not.toHaveBeenCalled();
	});

	it("cancelling issues no request", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(mockDeleteMyData).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("confirming deletes, clears settings, then reloads", async () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(mockReloadDesktop).toHaveBeenCalled());
		expect(mockDeleteMyData).toHaveBeenCalled();
		expect(mockClearLocalSettings).toHaveBeenCalled();
	});

	it("does not clear settings or reload when the server fails", async () => {
		mockDeleteMyData.mockRejectedValue(new Error("Could not delete your data."));
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.getByText("Could not delete your data.")).toBeTruthy());
		expect(mockClearLocalSettings).not.toHaveBeenCalled();
		expect(mockReloadDesktop).not.toHaveBeenCalled();
	});
});

describe("SpecialTab — delete my account", () => {
	const openAccountAlert = () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Account" }));
	};

	it("keeps Delete disabled until the screen name matches exactly", () => {
		openAccountAlert();
		const del = () => screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
		expect(del().disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyr" },
		});
		expect(del().disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		expect(del().disabled).toBe(false);
	});

	it("falls back to the email when the account has no screen name", () => {
		mockAuth.user = makeUser({ username: null });
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "t@x.org" },
		});
		expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	it("deletes, clears settings, then reloads on confirm", async () => {
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(mockReloadDesktop).toHaveBeenCalled());
		expect(mockDeleteMyAccount).toHaveBeenCalled();
		expect(mockClearLocalSettings).toHaveBeenCalled();
	});

	it("does not clear settings or reload when the account delete fails", async () => {
		mockDeleteMyAccount.mockRejectedValue(new Error("Could not delete your account."));
		openAccountAlert();
		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.getByText("Could not delete your account.")).toBeTruthy());
		expect(mockClearLocalSettings).not.toHaveBeenCalled();
		expect(mockReloadDesktop).not.toHaveBeenCalled();
	});
});
