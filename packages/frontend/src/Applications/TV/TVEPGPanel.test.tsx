/**
 * The EPG must not offer a channel the user switched off in Settings.
 *
 * epgVisibility.test.ts pins the rule; this pins the WIRING — that the panel
 * reads the blacklist from the store and that the filtered list is the one the
 * grid actually renders. The two are separate failures: filtering the wrong
 * memo would leave this suite green and the panel wrong.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	current: {
		System: {
			Manager: {
				DateAndTime: { dateTime: "2001-09-11T12:40:00.000Z", timeZoneOffset: "-4" },
				Applications: { apps: { "TV.app": { data: {} as Record<string, unknown> } } },
			},
		},
	},
}));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	// Serve whatever selector the component passes, against our fake store.
	useAppManager: (sel: (s: unknown) => unknown) => sel(store.current),
	useAppManagerDispatch: () => vi.fn(),
}));

import { TVEPGPanel } from "./TVEPGPanel";

const GUIDE = [
	{ name: "CNN", number: "1", callSign: "CNN", location: "Atlanta", icon: "cnn", grid: [] },
	{ name: "BBC", number: "2", callSign: "BBC", location: "London", icon: "bbc", grid: [] },
	{ name: "WNYW", number: "3", callSign: "WNYW", location: "New York", icon: "wnyw", grid: [] },
];

const setDisabled = (slugs: string[] | undefined) => {
	store.current.System.Manager.Applications.apps["TV.app"].data =
		slugs === undefined ? {} : { disabledChannels: slugs };
};

beforeEach(() => {
	setDisabled(undefined);
	vi.stubGlobal("fetch", vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => GUIDE,
	})));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const channelCell = (name: string) => screen.queryByTitle(`Watch ${name} on TV`);

describe("TVEPGPanel channel visibility", () => {
	it("lists every channel when none are disabled", async () => {
		render(<TVEPGPanel onClose={vi.fn()} />);
		await waitFor(() => expect(channelCell("CNN")).not.toBeNull());
		expect(channelCell("BBC")).not.toBeNull();
		expect(channelCell("WNYW")).not.toBeNull();
	});

	it("hides a channel switched off in Settings", async () => {
		setDisabled(["BBC"]);
		render(<TVEPGPanel onClose={vi.fn()} />);
		await waitFor(() => expect(channelCell("CNN")).not.toBeNull());
		expect(channelCell("BBC")).toBeNull();
		expect(channelCell("WNYW")).not.toBeNull();
	});

	it("hides regardless of the case the slug is stored in", async () => {
		// guide.json and the streamer's source list agree on case only by
		// coincidence; the panel must not depend on that.
		setDisabled(["cnn"]);
		render(<TVEPGPanel onClose={vi.fn()} />);
		await waitFor(() => expect(channelCell("BBC")).not.toBeNull());
		expect(channelCell("CNN")).toBeNull();
	});

	it("keeps a guide channel that no source provides", async () => {
		// WNYW cannot appear in Settings, so it can never be switched back on.
		setDisabled(["CNN", "BBC", "CCTV4"]);
		render(<TVEPGPanel onClose={vi.fn()} />);
		await waitFor(() => expect(channelCell("WNYW")).not.toBeNull());
		expect(channelCell("CNN")).toBeNull();
		expect(channelCell("BBC")).toBeNull();
	});
});
