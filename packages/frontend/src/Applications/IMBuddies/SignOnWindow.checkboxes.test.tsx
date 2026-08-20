import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// Partial classicy mock — ClassicyWindow requires a real
// ClassicyAppManagerProvider tree to render its children (it bails out to an
// empty shell without one, same as every other app-shell test in this repo —
// see Account.test.tsx/Weather.test.tsx). ClassicyButton/ClassicyInput/
// ClassicyPopUpMenu are stubbed too, purely to keep this file's blast radius
// to the one thing under test. ClassicyCheckbox is deliberately left
// UNMOCKED (via importOriginal) — this file exists specifically because
// SignOnWindow.test.tsx's wholesale-mocked ClassicyCheckbox stub hardcoded
// readOnly and so could never have caught the real component's internal
// useState toggling on click regardless of the `disabled` prop.
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyButton: (props: {
		children?: React.ReactNode;
		disabled?: boolean;
		onClickFunc?: () => void;
	}) => (
		<button type="button" disabled={props.disabled} onClick={props.onClickFunc}>
			{props.children}
		</button>
	),
	ClassicyInput: (props: {
		id: string;
		labelTitle?: string;
		type?: string;
		prefillValue?: string;
		disabled?: boolean;
	}) => (
		<input
			id={props.id}
			aria-label={props.labelTitle}
			type={props.type}
			defaultValue={props.prefillValue}
			disabled={props.disabled}
		/>
	),
	ClassicyPopUpMenu: (props: {
		label?: string;
		options: Array<{ value: string; label: string }>;
		selected?: string;
		onChangeFunc?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
	}) => (
		<select aria-label={props.label} value={props.selected} onChange={props.onChangeFunc}>
			{props.options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>
	),
	useAppManagerDispatch: () => () => {},
	useSoundDispatch: () => () => {},
	ClassicySoundActionTypes: { ClassicySoundPlay: "ClassicySoundPlay" },
	// ClassicyCheckbox: intentionally not overridden — the real component.
}));

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: { username: "me" } as AuthUser }),
}));

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => ({ reason: "ok", signOn: vi.fn() }),
}));

import { SignOnWindow } from "./SignOnWindow";

describe("SignOnWindow checkboxes (real ClassicyCheckbox)", () => {
	it("does not let Save password/Auto-login actually toggle on click", () => {
		render(<SignOnWindow />);
		const savePassword = screen.getByLabelText("Save password") as HTMLInputElement;
		const autoLogin = screen.getByLabelText("Auto-login") as HTMLInputElement;

		expect(savePassword.disabled).toBe(true);
		expect(autoLogin.disabled).toBe(true);
		expect(savePassword.checked).toBe(true);
		expect(autoLogin.checked).toBe(false);

		fireEvent.click(savePassword);
		fireEvent.click(autoLogin);

		// A disabled checkbox does not accept the click — same invariant as
		// the password field: it looks interactive but nothing changes when a
		// student clicks it, and nothing reads its value either way.
		expect(savePassword.checked).toBe(true);
		expect(autoLogin.checked).toBe(false);
	});
});
