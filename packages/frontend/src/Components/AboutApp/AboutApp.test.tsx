import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const helpMenuSpy = vi.fn();
const dispatchSpy = vi.fn();

// Partial classicy mock: ClassicyWindow requires a real
// ClassicyAppManagerProvider tree to render its children (same constraint
// documented in BuddyListWindow.test.tsx/InfoWindow.test.tsx), so it alone is
// stubbed to a plain passthrough div. useClassicyHelpMenu is replaced with a
// spy so registration can be asserted on directly. useAppManagerDispatch is
// replaced with a spy too, so the ClassicyWindowFocus/ClassicyWindowClose
// dispatches (Finding 1/6's fix) can be asserted directly rather than
// inferred from the real module-level zustand store's (unregistered-app,
// so no-op) reducer behavior. Everything else -- notably ClassicyButton,
// which the window's "OK" button renders -- is left real via importActual;
// ChatWindow.test.tsx/MapControls.test.tsx already establish that
// ClassicyButton renders standalone with no provider.
vi.mock("classicy", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("classicy");
	return {
		...actual,
		ClassicyWindow: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
		useClassicyHelpMenu: (appId: string, items: unknown[]) => {
			helpMenuSpy(appId, items);
		},
		useAppManagerDispatch: () => dispatchSpy,
	};
});

import { useAboutApp } from "./AboutApp";

// No RTL auto-cleanup in this project's vitest setup.
afterEach(() => {
	cleanup();
	helpMenuSpy.mockClear();
	dispatchSpy.mockClear();
});

function Harness({ appId = "Weather.app" }: { appId?: string }) {
	const aboutWindow = useAboutApp(appId, "/icons/weather.png");
	return <>{aboutWindow}</>;
}

describe("useAboutApp", () => {
	it("registers one Help item titled after the app", () => {
		render(<Harness />);
		const [appId, items] = helpMenuSpy.mock.calls[0] as [
			string,
			{ id: string; title: string }[],
		];
		expect(appId).toBe("Weather.app");
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("About Weather…");
	});

	// The id must not end in `_about` and the title must not be exactly "About",
	// or Classicy's About-hoist could relocate this item to the Apple menu.
	it("uses an id and title the About-hoist cannot match", () => {
		render(<Harness />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { id: string; title: string }[]];
		expect(items[0].id).toBe("Weather.app_about_data");
		expect(items[0].id.endsWith("_about")).toBe(false);
		expect(items[0].title).not.toBe("About");
	});

	it("renders nothing until the Help item is chosen", () => {
		render(<Harness />);
		expect(screen.queryByText(/NOAA NCEI/)).toBeNull();
	});

	it("shows sources and derivation once opened", async () => {
		render(<Harness appId="FlightTracker.app" />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { onClickFunc: () => void }[]];
		// onClickFunc invokes the hook's setShow(true) state setter directly, so
		// it must be wrapped in act() for React to flush the update -- the
		// brief's "click document.body" line did not accomplish this and is
		// dropped.
		act(() => {
			items[0].onClickFunc();
		});

		expect(await screen.findByText(/Bureau of Transportation Statistics/)).toBeTruthy();
		expect(screen.getByText(/reconstructed, not recorded/)).toBeTruthy();
		expect(screen.getAllByText(/rorovera201305/).length).toBeGreaterThan(0);
	});

	it("opens source links in a new tab without leaking the referrer", async () => {
		render(<Harness />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { onClickFunc: () => void }[]];
		act(() => {
			items[0].onClickFunc();
		});

		const link = await screen.findByRole("link", { name: /NOAA NCEI/ });
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noreferrer noopener");
	});

	// The hook still calls useClassicyHelpMenu unconditionally (skipping the
	// call for an unrecognized appId would be a conditional hook call, which
	// violates react-hooks/rules-of-hooks) -- but with zero items, so an app
	// with no registry entry gets no Help menu entry rather than nothing being
	// published at all.
	it("registers zero items for an app with no registry entry", () => {
		render(<Harness appId="Nope.app" />);
		expect(helpMenuSpy).toHaveBeenCalledWith("Nope.app", []);
	});

	it("renders nothing for an app with no registry entry", () => {
		render(<Harness appId="Nope.app" />);
		expect(screen.queryByText(/About/)).toBeNull();
	});

	// Finding 1: ClassicyWindow's own ClassicyWindowOpen effect (fired by the
	// stubbed ClassicyWindow's real child -- well, the stub above discards it
	// entirely) does not focus an already-registered window, so a reopened
	// About window would render in the background z-index band unless
	// AboutAppWindow focuses itself explicitly on every mount.
	it("dispatches ClassicyWindowFocus for its own window on mount", async () => {
		render(<Harness appId="FlightTracker.app" />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { onClickFunc: () => void }[]];
		act(() => {
			items[0].onClickFunc();
		});
		await screen.findByText(/Bureau of Transportation Statistics/);

		expect(dispatchSpy).toHaveBeenCalledWith({
			type: "ClassicyWindowFocus",
			app: { id: "FlightTracker.app" },
			window: { id: "FlightTracker.app_about_data" },
		});
	});

	// Finding 6: the OK button used to unmount via hideFunc alone, dispatching
	// nothing -- leaving the app's main window unfocused/dimmed. It must go
	// through the same ClassicyWindowClose dispatch as the window's own close
	// box before hiding.
	it("dispatches ClassicyWindowClose before hiding when OK is clicked", async () => {
		render(<Harness appId="FlightTracker.app" />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { onClickFunc: () => void }[]];
		act(() => {
			items[0].onClickFunc();
		});
		const okButton = await screen.findByRole("button", { name: "OK" });

		dispatchSpy.mockClear();
		fireEvent.click(okButton);

		expect(dispatchSpy).toHaveBeenCalledWith({
			type: "ClassicyWindowClose",
			app: { id: "FlightTracker.app" },
			window: { id: "FlightTracker.app_about_data" },
		});
		// hideFunc ran too -- the window's content is gone, not just dimmed.
		expect(screen.queryByText(/Bureau of Transportation Statistics/)).toBeNull();
	});

	// Finding 5: every shipped 3D model is a modified derivative (reoriented,
	// rescaled, decimated) -- disclosed once under "3D models" rather than
	// repeated across all thirteen entries.
	it("discloses the modified-derivative notice under 3D models", async () => {
		render(<Harness appId="FlightTracker.app" />);
		const [, items] = helpMenuSpy.mock.calls[0] as [string, { onClickFunc: () => void }[]];
		act(() => {
			items[0].onClickFunc();
		});

		expect(await screen.findByText(/modified derivative of the linked original/)).toBeTruthy();
		expect(screen.getByText(/CC-BY-SA originals are distributed under CC-BY-SA 3.0/)).toBeTruthy();
	});
});
