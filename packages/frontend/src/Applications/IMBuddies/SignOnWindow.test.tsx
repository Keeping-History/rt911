import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../Providers/Auth/authApi";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";

// This repo has no RTL auto-cleanup — every test file must do this itself.
afterEach(cleanup);

// --- Mutable state the mocked hooks below read from, set per-test by
// renderSignOn(). Hoisted so the vi.mock() factories (which run before the
// rest of this module) can close over them.
const authState = vi.hoisted(() => ({ user: null as AuthUser | null }));
const imState = vi.hoisted(() => ({
	reason: "ok" as ChatStateReason,
	signOn: vi.fn(),
}));
// Captures the app id ClassicyAppOpen actions are dispatched for, unwrapped
// from the full action shape so tests can assert on the id directly.
const openAppSpy = vi.hoisted(() => vi.fn());

vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => ({ user: authState.user }),
}));

vi.mock("./IMBuddiesProvider", () => ({
	useIMBuddies: () => ({ reason: imState.reason, signOn: imState.signOn }),
}));

vi.mock("classicy", () => ({
	ClassicySoundActionTypes: { ClassicySoundPlay: "ClassicySoundPlay" },
	useSoundDispatch: () => () => {},
	useAppManagerDispatch: () => (action: Record<string, unknown>) => {
		if (action.type !== "ClassicyAppOpen") return;
		const app = action.app as { id: string } | undefined;
		if (app) openAppSpy(app.id);
	},
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
	ClassicyCheckbox: (props: { label?: string; checked?: boolean; disabled?: boolean }) => (
		<input
			type="checkbox"
			aria-label={props.label}
			checked={props.checked}
			disabled={props.disabled}
			readOnly
		/>
	),
}));

import { SignOnWindow } from "./SignOnWindow";

function renderSignOn(overrides: { user?: AuthUser | null; reason?: ChatStateReason } = {}) {
	authState.user = "user" in overrides ? overrides.user ?? null : ({ username: "me" } as AuthUser);
	imState.reason = overrides.reason ?? "ok";
	imState.signOn = vi.fn();
	openAppSpy.mockClear();
	render(<SignOnWindow />);
	return { signOn: imState.signOn, openApp: openAppSpy };
}

describe("SignOnWindow", () => {
	it("shows the student's screen name", () => {
		renderSignOn({ user: { username: "skaterboi1988" } as AuthUser });
		expect(screen.getByText("skaterboi1988")).toBeTruthy();
	});

	it("connects when Sign On is pressed", () => {
		const { signOn } = renderSignOn({ user: { username: "me" } as AuthUser });
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		expect(signOn).toHaveBeenCalled();
	});

	it("opens the Account app instead of connecting when not signed in", () => {
		// The one place real credentials are handled. Pretending to authenticate
		// here would be the costume lying about what it is.
		const { signOn, openApp } = renderSignOn({ user: null, reason: "not_signed_in" });
		// Labelled "Sign In" while signed out: it is the only live control on
		// this window then, and what it does is open the Account app rather
		// than sign on to chat. Calling it "Sign On" would promise the thing it
		// cannot do.
		fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
		expect(signOn).not.toHaveBeenCalled();
		expect(openApp).toHaveBeenCalledWith("Account.app");
	});

	it("signs on for a signed-in student even though chatReason is still not_signed_in", () => {
		// The streamer only emits chat_state in reply to a `subscribe`, and the
		// client only subscribes after signOn() — so at the moment Sign On is
		// pressed, chatReason is ALWAYS its "not_signed_in" initial value. A
		// gate on chatReason therefore sent every student to the Account app
		// and made signing on impossible; the local auth session is the only
		// thing that can answer "is there a Directus session" here.
		const { signOn, openApp } = renderSignOn({
			user: { username: "me" } as AuthUser,
			reason: "not_signed_in",
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		expect(signOn).toHaveBeenCalled();
		expect(openApp).not.toHaveBeenCalled();
	});

	it("submits nothing from the password field", () => {
		// It is theatre: fixed bullets over a value nobody typed, read by nothing.
		const { signOn } = renderSignOn({ user: { username: "me" } as AuthUser });
		const pw = screen.getByLabelText("Password") as HTMLInputElement;
		expect(pw.readOnly || pw.disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
		expect(signOn).toHaveBeenCalledWith();
	});
});
