import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Captures the props ClassicyApp is rendered with so the test can assert the
// Apple-menu/no-desktop-icon contract without classicy's desktop chrome.
const appProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({
		children,
		...props
	}: { children?: React.ReactNode } & Record<string, unknown>) => {
		appProps.current = props;
		return <div>{children}</div>;
	},
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	useAppManagerDispatch: () => vi.fn(),
	useClassicyAboutMenu: () => ({
		aboutMenuItem: { id: "about" },
		aboutWindow: null,
	}),
	useClassicyWindowClose: () => vi.fn(),
}));

import { AlertsManager } from "./AlertsManager";
import { getAlertsEnabled, resetAlertsSettingsForTests, setAlertsEnabled } from "./alertsSettings";

afterEach(() => {
	cleanup();
	window.localStorage.clear();
	resetAlertsSettingsForTests();
});

describe("Alerts Manager control panel", () => {
	it("registers as an Apple-menu app with no desktop icon", () => {
		render(<AlertsManager />);
		expect(appProps.current.id).toBe("AlertsManager.app");
		expect(appProps.current.noDesktopIcon).toBe(true);
		expect(appProps.current.addSystemMenu).toBe(true);
	});

	it("shows the checkbox checked while alerts are enabled", () => {
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
	});

	it("reflects a persisted disabled state", () => {
		setAlertsEnabled(false);
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts") as HTMLInputElement;
		expect(checkbox.checked).toBe(false);
	});

	it("toggling the checkbox flips and persists the store", () => {
		render(<AlertsManager />);
		const checkbox = screen.getByLabelText("Show Alerts");

		act(() => {
			fireEvent.click(checkbox);
		});
		expect(getAlertsEnabled()).toBe(false);
		expect(window.localStorage.getItem("rt911AlertsEnabled")).toBe("false");

		act(() => {
			fireEvent.click(checkbox);
		});
		expect(getAlertsEnabled()).toBe(true);
	});
});
