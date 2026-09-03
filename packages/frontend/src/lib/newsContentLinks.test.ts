import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NEWS_ITEM_HASH_PREFIX,
	handleNewsContentClick,
	parseBalloonTitle,
	parseNewsItemHref,
} from "./newsContentLinks";

describe("parseNewsItemHref", () => {
	it("extracts the id from an internal cross-reference hash", () => {
		expect(parseNewsItemHref(`${NEWS_ITEM_HASH_PREFIX}42`)).toBe(42);
	});

	it("returns null for an external URL", () => {
		expect(parseNewsItemHref("https://web.archive.org/web/2015/http://x")).toBeNull();
	});

	it("returns null for a non-numeric id", () => {
		expect(parseNewsItemHref(`${NEWS_ITEM_HASH_PREFIX}abc`)).toBeNull();
	});

	it("returns null for a missing href", () => {
		expect(parseNewsItemHref(null)).toBeNull();
	});
});

describe("parseBalloonTitle", () => {
	function anchor(attrs: Record<string, string>): HTMLAnchorElement {
		const a = document.createElement("a");
		for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
		return a;
	}

	it("reads the data-balloon-title attribute", () => {
		expect(
			parseBalloonTitle(anchor({ "data-balloon-title": "Oklahoma City Bombing" })),
		).toBe("Oklahoma City Bombing");
	});

	it("returns null when the attribute is absent", () => {
		expect(parseBalloonTitle(anchor({ href: "https://x" }))).toBeNull();
	});

	it("returns null for a blank attribute", () => {
		expect(parseBalloonTitle(anchor({ "data-balloon-title": "   " }))).toBeNull();
	});
});

describe("handleNewsContentClick", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function clickOn(container: HTMLElement, selector: string) {
		const el = container.querySelector(selector) as HTMLElement;
		const event = {
			target: el,
			preventDefault: vi.fn(),
		};
		return { el, event };
	}

	it("opens the target article in-app for an internal cross-reference link, without opening a window", () => {
		const container = document.createElement("div");
		container.innerHTML = `<p><a href="${NEWS_ITEM_HASH_PREFIX}7">see also</a></p>`;
		const onOpenNewsItem = vi.fn();
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

		const { event } = clickOn(container, "a");
		handleNewsContentClick(event, onOpenNewsItem);

		expect(event.preventDefault).toHaveBeenCalled();
		expect(onOpenNewsItem).toHaveBeenCalledWith(7);
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("opens an external link in a new window instead of navigating in place", () => {
		const container = document.createElement("div");
		container.innerHTML = `<p><a href="https://web.archive.org/web/2015/http://historycommons.org/x">source</a></p>`;
		const onOpenNewsItem = vi.fn();
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

		const { event } = clickOn(container, "a");
		handleNewsContentClick(event, onOpenNewsItem);

		expect(event.preventDefault).toHaveBeenCalled();
		expect(openSpy).toHaveBeenCalledWith(
			"https://web.archive.org/web/2015/http://historycommons.org/x",
			"_blank",
			"noopener,noreferrer",
		);
		expect(onOpenNewsItem).not.toHaveBeenCalled();
	});

	it("does nothing when the click did not land on a link", () => {
		const container = document.createElement("div");
		container.innerHTML = `<p>plain text</p>`;
		const onOpenNewsItem = vi.fn();
		const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

		const { event } = clickOn(container, "p");
		handleNewsContentClick(event, onOpenNewsItem);

		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(onOpenNewsItem).not.toHaveBeenCalled();
		expect(openSpy).not.toHaveBeenCalled();
	});

	it("resolves a click on a child element (e.g. bold text) inside the link", () => {
		const container = document.createElement("div");
		container.innerHTML = `<p><a href="${NEWS_ITEM_HASH_PREFIX}3"><strong>bold link</strong></a></p>`;
		const onOpenNewsItem = vi.fn();

		const { event } = clickOn(container, "strong");
		handleNewsContentClick(event, onOpenNewsItem);

		expect(onOpenNewsItem).toHaveBeenCalledWith(3);
	});
});
