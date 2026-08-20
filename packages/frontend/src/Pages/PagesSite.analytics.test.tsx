import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The surface under test only needs to resolve a slug to a title here, so the
// data hook is stubbed; the analytics module is spied on rather than executed.
const initSpy = vi.hoisted(() => vi.fn());
const viewSpy = vi.hoisted(() => vi.fn());
vi.mock("../lib/analytics", () => ({
	initGoogleAnalytics: initSpy,
	trackPageView: viewSpy,
	GA_MEASUREMENT_ID: "G-TEST",
}));

const state = vi.hoisted(() => ({
	loading: false,
	notFound: false,
	/** Slug whose data the hook currently holds; mirrors the real hook lagging
	 *  behind the requested slug for a render after a navigation. */
	resolved: null as string | null,
	/** When set, the hook reports data for THIS slug no matter what was asked
	 *  for — the stale window that produced a wrongly-titled duplicate hit. */
	stuckOn: null as string | null,
}));
vi.mock("./usePages", () => ({
	usePages: (slug: string) => {
		const held = state.stuckOn ?? slug;
		return {
			nav: [],
			page: state.notFound ? null : { title: `Page ${held}`, slug: held, body: "<p>hi</p>" },
			loading: state.loading,
			notFound: state.notFound,
			error: null,
			resolvedSlug: state.resolved === undefined ? held : (state.resolved ?? held),
		};
	},
}));

import PagesSite from "./PagesSite";

beforeEach(() => {
	initSpy.mockClear();
	viewSpy.mockClear();
	state.loading = false;
	state.notFound = false;
	state.resolved = null;
	state.stuckOn = null;
	window.history.pushState({}, "", "/about");
});
afterEach(cleanup);

describe("PagesSite analytics", () => {
	it("initialises Google Analytics on mount", () => {
		render(<PagesSite />);
		expect(initSpy).toHaveBeenCalled();
	});

	it("sends a page_view for the landing slug, with the page title", async () => {
		render(<PagesSite />);
		await waitFor(() => expect(viewSpy).toHaveBeenCalled());
		expect(viewSpy).toHaveBeenCalledWith({
			path: "/about",
			title: "Page about — 911 Realtime",
			notFound: false,
		});
		expect(viewSpy).toHaveBeenCalledTimes(1);
	});

	it("sends another page_view on client-side navigation", async () => {
		render(<PagesSite />);
		await waitFor(() => expect(viewSpy).toHaveBeenCalledTimes(1));

		// Same path the in-app links take: pushState + a slug change. popstate is
		// the observable seam for that without clicking through the menu bar.
		window.history.pushState({}, "", "/team");
		window.dispatchEvent(new PopStateEvent("popstate"));

		await waitFor(() =>
			expect(viewSpy).toHaveBeenCalledWith({
				path: "/team",
				title: "Page team — 911 Realtime",
				notFound: false,
			}),
		);
		// Exactly one hit per page — no stale-title duplicate.
		expect(viewSpy).toHaveBeenCalledTimes(2);
	});

	it("does not send a view while the page is still loading", () => {
		state.loading = true;
		state.resolved = "";
		render(<PagesSite />);
		expect(viewSpy).not.toHaveBeenCalled();
	});

	// Regression: gating on `loading` alone let a render through where the slug
	// had changed but the hook still held the PREVIOUS page, sending a second
	// page_view for the new path carrying the old page's title.
	it("sends no view while the held data still describes the previous slug", () => {
		state.stuckOn = "about";
		state.resolved = "about";
		window.history.pushState({}, "", "/team");
		render(<PagesSite />);
		const forTeam = viewSpy.mock.calls.filter((c) => c[0].path === "/team");
		expect(forTeam).toHaveLength(0);
	});

	it("reports a 404 as a view carrying notFound", async () => {
		state.notFound = true;
		state.resolved = "about";
		render(<PagesSite />);
		await waitFor(() => expect(viewSpy).toHaveBeenCalled());
		expect(viewSpy).toHaveBeenCalledWith({
			path: "/about",
			title: "911 Realtime",
			notFound: true,
		});
	});

	it("keeps document.title and the reported title identical", async () => {
		render(<PagesSite />);
		await waitFor(() => expect(viewSpy).toHaveBeenCalled());
		expect(viewSpy.mock.calls[0][0].title).toBe(document.title);
	});
});
