import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShadowContent } from "./Browser";

afterEach(cleanup);

const getShadow = (container: HTMLElement): ShadowRoot => {
	const host = container.querySelector(".browserPage") as HTMLElement;
	if (!host?.shadowRoot) throw new Error("shadow root not attached");
	return host.shadowRoot;
};

const clickInShadow = (el: Element) => {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
};

describe("ShadowContent link interception", () => {
	it("intercepts clicks on <a> links", () => {
		const onLinkClick = vi.fn();
		const { container } = render(
			<ShadowContent
				html={`<a href="http://www.apple.com/macosx/">Mac OS X</a>`}
				onLinkClick={onLinkClick}
			/>,
		);
		const anchor = getShadow(container).querySelector("a")!;
		clickInShadow(anchor);
		expect(onLinkClick).toHaveBeenCalledTimes(1);
		expect(onLinkClick.mock.calls[0][0].rawHref).toBe(
			"http://www.apple.com/macosx/",
		);
	});

	it("intercepts clicks on <area> image-map links", () => {
		const onLinkClick = vi.fn();
		const { container } = render(
			<ShadowContent
				html={`<img src="nav.gif" usemap="#m"><map name="m"><area shape="rect" coords="0,0,50,50" href="http://www.apple.com/education/"></map>`}
				onLinkClick={onLinkClick}
			/>,
		);
		const area = getShadow(container).querySelector("area")!;
		clickInShadow(area);
		expect(onLinkClick).toHaveBeenCalledTimes(1);
		expect(onLinkClick.mock.calls[0][0].rawHref).toBe(
			"http://www.apple.com/education/",
		);
	});

	it("marks visited links and provides a default visited color", () => {
		const onLinkClick = vi.fn();
		const isVisited = (_href: string, rawHref: string) =>
			rawHref === "http://www.apple.com/education/";
		const { container } = render(
			<ShadowContent
				html={`<a href="http://www.apple.com/education/">Education</a><a href="http://www.apple.com/store/">Store</a>`}
				onLinkClick={onLinkClick}
				isVisited={isVisited}
			/>,
		);
		const shadow = getShadow(container);
		const [edu, store] = Array.from(shadow.querySelectorAll("a"));
		expect(edu.classList.contains("browserVisited")).toBe(true);
		expect(store.classList.contains("browserVisited")).toBe(false);
		// Default visited color is emitted even when the page declares no vlink.
		expect(shadow.querySelector("style")?.textContent).toContain(
			".browserVisited",
		);
	});

	it("recreates the page's <body> link/vlink/alink colors as a stylesheet", () => {
		const { container } = render(
			<ShadowContent
				html={`<html><body link="#0000ff" vlink="#551a8b" alink="#ff0000"><a href="/x">x</a></body></html>`}
				onLinkClick={vi.fn()}
				isVisited={() => false}
			/>,
		);
		const style = getShadow(container).querySelector("style")?.textContent ?? "";
		expect(style).toContain("a:link,area:link{color:#0000ff}");
		expect(style).toContain("a.browserVisited,area.browserVisited{color:#551a8b}");
		expect(style).toContain("a:active,area:active{color:#ff0000}");
	});
});
