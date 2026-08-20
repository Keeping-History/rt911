// Companion to SpecialTab.test.tsx, which mocks ClassicyAlert away in order to
// drive the buttons. That mock is file-scoped, so this separate file exists to
// exercise the REAL alert — the part those tests structurally cannot reach.
//
// What it protects: the account confirmation puts a ClassicyInput inside the
// alert's `message`, which the component's own docs describe as icon/text/
// buttons only. If a classicy release ever stops rendering rich message nodes,
// or stops honouring `disabled` on a button, the typed-confirm gate silently
// becomes either unusable or absent — and every mocked test would still pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AuthUser } from "../../Providers/Auth/authApi";

const mockDeleteMyAccount = vi.hoisted(() => vi.fn());

vi.mock("../../Providers/Auth/accountApi", () => ({
	deleteMyData: vi.fn(),
	deleteMyAccount: mockDeleteMyAccount,
	clearLocalSettings: vi.fn(),
	reloadDesktop: vi.fn(),
}));

const mockAuth = vi.hoisted(() => ({ user: null as AuthUser | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));

// Deliberately no vi.mock("classicy") — that is the entire point of this file.

import { SpecialTab } from "./SpecialTab";

const makeUser = (over: Partial<AuthUser> = {}): AuthUser => ({
	id: "1", email: "t@x.org", username: "mrbyrd", first_name: null, last_name: null,
	avatar: null, provider: "google", city: null, state: null, country: null,
	school_name: null, educator_role: null, grade_levels: null, subjects: null,
	...over,
});

beforeEach(() => {
	mockAuth.user = makeUser();
	mockDeleteMyAccount.mockReset().mockResolvedValue({ deleted: {}, failed: [] });
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SpecialTab against the real ClassicyAlert", () => {
	it("renders the risk copy in the data alert", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Data" }));
		expect(screen.getByText("This cannot be undone.")).toBeTruthy();
	});

	it("renders an interactive confirmation input inside the alert message", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Account" }));
		const input = screen.getByLabelText("Type your screen name to confirm") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "mrbyrd" } });
		expect(input.value).toBe("mrbyrd");
	});

	it("gates the real Delete button on an exact screen-name match", () => {
		render(<SpecialTab />);
		fireEvent.click(screen.getByRole("button", { name: "Delete My Account" }));
		const del = () => screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
		expect(del().disabled).toBe(true);

		fireEvent.change(screen.getByLabelText("Type your screen name to confirm"), {
			target: { value: "mrbyrd" },
		});
		expect(del().disabled).toBe(false);

		fireEvent.click(del());
		expect(mockDeleteMyAccount).toHaveBeenCalled();
	});
});
