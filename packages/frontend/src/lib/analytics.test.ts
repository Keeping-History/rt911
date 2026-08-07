import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test needs a fresh module: initGoogleAnalytics is deliberately
// idempotent via module-level state, so resetModules is how we re-arm it.
async function freshModule() {
	vi.resetModules();
	return import("./analytics");
}

function cleanDom() {
	delete window.dataLayer;
	delete window.gtag;
	document.head.querySelectorAll("script").forEach((s) => s.remove());
}

beforeEach(cleanDom);
afterEach(cleanDom);

describe("initGoogleAnalytics", () => {
	it("injects the gtag.js script for the measurement id", async () => {
		const { initGoogleAnalytics, GA_MEASUREMENT_ID } = await freshModule();
		initGoogleAnalytics();
		const script = document.head.querySelector<HTMLScriptElement>(
			'script[src*="googletagmanager.com/gtag/js"]',
		);
		expect(script).not.toBeNull();
		expect(script!.src).toContain(GA_MEASUREMENT_ID);
		expect(script!.async).toBe(true);
	});

	it("configures the property with send_page_view disabled (SPA routing)", async () => {
		const { initGoogleAnalytics, GA_MEASUREMENT_ID } = await freshModule();
		initGoogleAnalytics();
		const pushed = (window.dataLayer ?? []).map((a) => Array.from(a as IArguments));
		const config = pushed.find((a) => a[0] === "config");
		expect(config).toBeDefined();
		expect(config![1]).toBe(GA_MEASUREMENT_ID);
		expect(config![2]).toEqual({ send_page_view: false });
	});

	it("is idempotent — a second call adds no second tag", async () => {
		const { initGoogleAnalytics } = await freshModule();
		initGoogleAnalytics();
		initGoogleAnalytics();
		expect(
			document.head.querySelectorAll('script[src*="googletagmanager.com"]'),
		).toHaveLength(1);
	});

	it("does nothing when the measurement id is empty", async () => {
		const { initGoogleAnalytics } = await freshModule();
		initGoogleAnalytics("");
		expect(document.head.querySelector("script")).toBeNull();
		expect(window.gtag).toBeUndefined();
	});

	it("pushes an arguments object, not a plain array (gtag.js requires it)", async () => {
		const { initGoogleAnalytics } = await freshModule();
		initGoogleAnalytics();
		const first = (window.dataLayer ?? [])[0];
		expect(Array.isArray(first)).toBe(false);
		expect(Object.prototype.toString.call(first)).toBe("[object Arguments]");
	});
});

describe("trackPageView", () => {
	it("sends a page_view with path, title and location", async () => {
		const { initGoogleAnalytics, trackPageView } = await freshModule();
		initGoogleAnalytics();
		const spy = vi.fn();
		window.gtag = spy;

		trackPageView({ path: "/about", title: "About — 911 Realtime" });

		expect(spy).toHaveBeenCalledWith("event", "page_view", {
			page_path: "/about",
			page_title: "About — 911 Realtime",
			page_location: `${window.location.origin}/about`,
		});
	});

	it("flags a 404 so broken links are distinguishable", async () => {
		const { initGoogleAnalytics, trackPageView } = await freshModule();
		initGoogleAnalytics();
		const spy = vi.fn();
		window.gtag = spy;

		trackPageView({ path: "/nope", title: "911 Realtime", notFound: true });

		expect(spy.mock.calls[0][2]).toMatchObject({ page_not_found: true });
	});

	it("is a no-op before init", async () => {
		const { trackPageView } = await freshModule();
		const spy = vi.fn();
		window.gtag = spy;
		trackPageView({ path: "/about", title: "x" });
		expect(spy).not.toHaveBeenCalled();
	});
});
