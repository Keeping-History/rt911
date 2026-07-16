import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial classicy mock — full replacement breaks on transitive imports.
const dispatched: Array<Record<string, unknown>> = [];
let mockApps: Record<string, { open?: boolean; data?: Record<string, unknown> }> = {};
let mockClock = {
	dateTime: "2001-09-11T12:50:00.000Z",
	// localDate is the DISPLAY value: UTC shifted by tzOffset (-4).
	localDate: new Date("2001-09-11T08:50:00.000Z"),
	tzOffset: -4,
	setDateTime: vi.fn(),
};
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useAppManagerDispatch: () => (a: Record<string, unknown>) => dispatched.push(a),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({ System: { Manager: { Applications: { apps: mockApps }, DateAndTime: {} } } }),
	useClassicyDateTime: () => mockClock,
}));

import { PlaylistProvider } from "./PlaylistProvider";
import { PERMISSION_DENIED } from "./playlistApps";

const definition = {
	version: 1,
	mode: "annotate",
	entries: [{ kind: "app", appId: "TimeMachine.app", disabled: true }],
};
const row = { data: { title: "Test", status: "published", definition } };

describe("PlaylistProvider", () => {
	beforeEach(() => {
		dispatched.length = 0;
		mockApps = {};
		mockClock = {
			dateTime: "2001-09-11T12:50:00.000Z",
			localDate: new Date("2001-09-11T08:50:00.000Z"),
			tzOffset: -4,
			setDateTime: vi.fn(),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(row), { status: 200 })),
		);
		window.history.replaceState(null, "", "/?playlist=abc-123");
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		window.history.replaceState(null, "", "/");
	});

	it("without ?playlist renders children and fetches nothing", () => {
		window.history.replaceState(null, "", "/");
		const { getByText } = render(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		expect(getByText("kid")).toBeTruthy();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("force-closes a stale-open disabled app silently at activation", async () => {
		mockApps = { "TimeMachine.app": { open: true } };
		render(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		await waitFor(() =>
			expect(dispatched.some((a) => a.type === "ClassicyAppClose")).toBe(true),
		);
		expect(dispatched.some((a) => a.type === "ClassicyDesktopShowErrorDialog")).toBe(false);
	});

	it("closes + shows the permission dialog when a disabled app opens later", async () => {
		mockApps = { "TimeMachine.app": { open: false } };
		const { rerender } = render(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		// Let the silent boot sweep run against the closed app first.
		await waitFor(() =>
			expect(dispatched.some((a) => a.type === "ClassicyAppClose")).toBe(false),
		);
		mockApps = { "TimeMachine.app": { open: true } };
		rerender(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		await waitFor(() => {
			expect(dispatched.some((a) => a.type === "ClassicyAppClose")).toBe(true);
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyDesktopShowErrorDialog" && a.message === PERMISSION_DENIED,
				),
			).toBe(true);
		});
	});

	it("shows a load-failure dialog and stays fail-open", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 404 })));
		render(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		await waitFor(() =>
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyDesktopShowErrorDialog" &&
						a.message === "This playlist could not be loaded.",
				),
			).toBe(true),
		);
	});
});
