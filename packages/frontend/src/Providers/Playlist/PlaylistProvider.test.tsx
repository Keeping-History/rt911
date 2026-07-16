import { cleanup, render, waitFor } from "@testing-library/react";
import type React from "react";
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

	// --- tick-loop scenarios ---------------------------------------------

	const UTC_BASE = "2001-09-11T12:50:00.000Z";
	/** Advance the mock clock to a new virtual UTC instant and rerender. */
	const tickTo = (
		rerender: (ui: React.ReactElement) => void,
		utcIso: string,
	) => {
		const utcMs = new Date(utcIso).getTime();
		mockClock = {
			...mockClock,
			dateTime: utcIso,
			// display value: UTC shifted by tzOffset (-4h)
			localDate: new Date(utcMs + -4 * 3_600_000),
		};
		rerender(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
	};

	const mountWith = async (entries: unknown[]) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							data: {
								title: "T",
								status: "published",
								definition: { version: 1, mode: "annotate", entries },
							},
						}),
						{ status: 200 },
					),
			),
		);
		const utils = render(
			<PlaylistProvider>
				<p>kid</p>
			</PlaylistProvider>,
		);
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		// settle the activation tick
		tickTo(utils.rerender, UTC_BASE);
		return utils;
	};

	it("crossing a jump `at` sets the clock to `to`", async () => {
		const { rerender } = await mountWith([
			{ kind: "jump", at: "2001-09-11T12:51:00", to: "2001-09-11T13:59:00" },
		]);
		tickTo(rerender, "2001-09-11T12:51:00.000Z");
		await waitFor(() =>
			expect(mockClock.setDateTime).toHaveBeenCalledWith(
				new Date("2001-09-11T13:59:00.000Z"),
			),
		);
	});

	it("crossing a file `at` dispatches ClassicyAppFinderOpenFile", async () => {
		const { rerender } = await mountWith([
			{ kind: "file", path: "Documents:Newspapers:x.pdf", at: "2001-09-11T12:51:00" },
		]);
		tickTo(rerender, "2001-09-11T12:51:00.000Z");
		await waitFor(() =>
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyAppFinderOpenFile" &&
						a.path === "Documents:Newspapers:x.pdf",
				),
			).toBe(true),
		);
	});

	it("a >90s move fires nothing but re-arms the trigger", async () => {
		const { rerender } = await mountWith([
			{ kind: "jump", at: "2001-09-11T12:51:00", to: "2001-09-11T13:59:00" },
		]);
		// big forward seek across the trigger: no fire
		tickTo(rerender, "2001-09-11T13:00:00.000Z");
		expect(mockClock.setDateTime).not.toHaveBeenCalled();
		// seek back behind it: re-armed
		tickTo(rerender, "2001-09-11T12:50:30.000Z");
		expect(mockClock.setDateTime).not.toHaveBeenCalled();
		// natural tick across it: fires
		tickTo(rerender, "2001-09-11T12:51:00.000Z");
		await waitFor(() => expect(mockClock.setDateTime).toHaveBeenCalledTimes(1));
	});

	it("crossing a focus start opens the app and dispatches the tune command", async () => {
		const { rerender } = await mountWith([
			{ kind: "media", app: "tv", itemId: "CNN", start: "2001-09-11T12:51:00", focus: "once" },
		]);
		tickTo(rerender, "2001-09-11T12:51:00.000Z");
		await waitFor(() => {
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyAppOpen" &&
						(a.app as { id: string }).id === "TV.app",
				),
			).toBe(true);
			expect(
				dispatched.some(
					(a) => a.type === "ClassicyAppTVTuneChannel" && a.channel === "CNN",
				),
			).toBe(true);
		});
	});

	it("seeds settings at activation and re-merges locked settings on divergence", async () => {
		mockApps = { "TV.app": { open: false, data: { captionsOn: false } } };
		const { rerender } = await mountWith([
			{ kind: "settings", appId: "TV.app", values: { captionsOn: true }, locked: true },
		]);
		await waitFor(() =>
			expect(
				dispatched.filter((a) => a.type === "ClassicyAppPlaylistMergeData").length,
			).toBeGreaterThanOrEqual(1),
		);
		// store diverges (mock store never applied the merge) → tick re-merges
		const before = dispatched.filter((a) => a.type === "ClassicyAppPlaylistMergeData").length;
		tickTo(rerender, "2001-09-11T12:50:01.000Z");
		await waitFor(() =>
			expect(
				dispatched.filter((a) => a.type === "ClassicyAppPlaylistMergeData").length,
			).toBeGreaterThan(before),
		);
	});

	it("opens the Browser at `at` and closes it at `closeAt` (transitions only)", async () => {
		const { rerender } = await mountWith([
			{
				kind: "browser",
				url: "https://example.com/",
				at: "2001-09-11T12:52:00",
				closeAt: "2001-09-11T12:55:00",
			},
		]);
		tickTo(rerender, "2001-09-11T12:52:00.000Z");
		await waitFor(() =>
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyAppOpen" &&
						(a.app as { id: string }).id === "Browser.app",
				),
			).toBe(true),
		);
		tickTo(rerender, "2001-09-11T12:55:00.000Z");
		await waitFor(() =>
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyAppClose" &&
						(a.app as { id: string }).id === "Browser.app",
				),
			).toBe(true),
		);
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
