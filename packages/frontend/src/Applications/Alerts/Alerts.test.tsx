import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "../../Providers/MediaStream/MediaStreamContext";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";

// Seeded Alerts.app data handed to useAppManager; toggled per test to exercise
// the subscribe-on-mount gate (mirrors News.tsx's isRunning gate).
const mockAppRunning = vi.hoisted(() => ({ value: true }));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	// Minimal ClassicyAlert stand-in: renders the label, the rich `message`
	// node (so image/caption/HTML content are exercised), the severity as a
	// data attribute, and an OK button that fires the default button's
	// onClick, mirroring the real modal's contract without needing classicy's
	// window chrome.
	ClassicyAlert: ({
		label,
		alertType,
		message,
		buttons,
	}: {
		label: string;
		alertType?: string;
		message?: React.ReactNode;
		buttons?: { label: string; onClick?: () => void }[];
	}) => (
		<div role="alertdialog" data-alert-type={alertType}>
			<span>{label}</span>
			{message}
			<button type="button" onClick={() => buttons?.[0]?.onClick?.()}>
				{buttons?.[0]?.label ?? "OK"}
			</button>
		</div>
	),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					Applications: {
						apps: mockAppRunning.value ? { "Alerts.app": { open: true } } : {},
					},
				},
			},
		}),
}));

import { Alerts } from "./Alerts";

afterEach(() => {
	cleanup();
	mockAppRunning.value = true;
});

const mk = (
	id: number,
	title: string,
	start: string,
	severity?: AlertItem["severity"],
): AlertItem => ({
	id,
	title,
	full_title: title,
	start_date: start,
	severity,
	url: "",
	format: "",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
});

function renderWithAlerts(alertItems: AlertItem[]) {
	const subscribeAlerts = vi.fn();
	const unsubscribeAlerts = vi.fn();
	const value = {
		alertItems,
		subscribeAlerts,
		unsubscribeAlerts,
	} as unknown as React.ContextType<typeof MediaStreamContext>;
	const utils = render(
		<MediaStreamContext.Provider value={value}>
			<Alerts />
		</MediaStreamContext.Provider>,
	);
	return { ...utils, subscribeAlerts, unsubscribeAlerts };
}

describe("Alerts extension", () => {
	it("shows only the earliest alert, hiding later ones", () => {
		renderWithAlerts([
			mk(1, "First", "2001-09-11T12:41:00Z"),
			mk(2, "Second", "2001-09-11T12:40:00Z"),
		]);
		// "Second" has the earlier start_date despite arriving later in the array.
		expect(screen.getByText("Second")).not.toBeNull();
		expect(screen.queryByText("First")).toBeNull();
	});

	it("advances to the next alert after OK, and never re-shows a dismissed one", () => {
		renderWithAlerts([
			mk(1, "First", "2001-09-11T12:40:00Z"),
			mk(2, "Second", "2001-09-11T12:41:00Z"),
		]);
		expect(screen.getByText("First")).not.toBeNull();
		expect(screen.queryByText("Second")).toBeNull();

		fireEvent.click(screen.getByText("OK"));
		expect(screen.queryByText("First")).toBeNull();
		expect(screen.getByText("Second")).not.toBeNull();
	});

	it("renders no alertdialog once every alert has been dismissed", () => {
		renderWithAlerts([mk(1, "Only", "2001-09-11T12:40:00Z")]);
		expect(screen.getByRole("alertdialog")).not.toBeNull();

		fireEvent.click(screen.getByText("OK"));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("subscribes on mount while the app is loaded, and unsubscribes on unmount", () => {
		const { unmount, subscribeAlerts, unsubscribeAlerts } = renderWithAlerts([]);
		expect(subscribeAlerts).toHaveBeenCalledWith("Alerts.app");
		unmount();
		expect(unsubscribeAlerts).toHaveBeenCalledWith("Alerts.app");
	});

	it("does not subscribe when the app entry isn't loaded yet", () => {
		mockAppRunning.value = false;
		const { subscribeAlerts } = renderWithAlerts([]);
		expect(subscribeAlerts).not.toHaveBeenCalled();
	});

	it("renders the rich message: severity, image, caption, and HTML content", () => {
		const item: AlertItem = {
			...mk(1, "Evacuation Notice", "2001-09-11T12:40:00Z", "caution"),
			image: "https://example.com/alert.jpg",
			image_caption: "Smoke over lower Manhattan",
			content: "<p>Evacuate <b>now</b></p>",
		};
		const { container } = renderWithAlerts([item]);

		expect(screen.getByRole("alertdialog").getAttribute("data-alert-type")).toBe(
			"caution",
		);

		// The image is decorative (alt=""), so it has no accessible "img" role;
		// query the DOM directly instead.
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		expect(image?.getAttribute("src")).toBe("https://example.com/alert.jpg");

		expect(screen.getByText("Smoke over lower Manhattan")).not.toBeNull();

		expect(screen.getByText("now").tagName).toBe("B");
		expect(screen.getByText(/Evacuate/)).not.toBeNull();
	});
});
