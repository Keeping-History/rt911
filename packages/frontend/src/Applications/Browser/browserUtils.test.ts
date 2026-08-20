import { describe, expect, it } from "vitest";
import {
	buildLinkStyle,
	extractLinkColors,
	isValidCssColor,
	normalizeUrl,
	resolveLinkTarget,
	stripProxyUrl,
} from "./browserUtils";

const HOST = "timemachine.911realtime.org";

describe("stripProxyUrl", () => {
	it("strips the TimeMachine /web/<url> path wrapper", () => {
		expect(
			stripProxyUrl(
				"https://timemachine.911realtime.org/web/http://www.cnn.com/WEATHER/",
				HOST,
			),
		).toBe("http://www.cnn.com/WEATHER/");
	});

	it("strips an archive.org-style /web/<timestamp>/<url> wrapper", () => {
		expect(
			stripProxyUrl(
				"https://timemachine.911realtime.org/web/20010912000000/http://www.cnn.com/",
				HOST,
			),
		).toBe("http://www.cnn.com/");
	});

	it("extracts the original from the ?url= query form", () => {
		expect(
			stripProxyUrl(
				`https://timemachine.911realtime.org/?url=${encodeURIComponent("http://www.cnn.com/WEATHER/")}&time=20010912000000`,
				HOST,
			),
		).toBe("http://www.cnn.com/WEATHER/");
	});

	it("leaves a non-proxy URL unchanged", () => {
		expect(stripProxyUrl("http://www.cnn.com/WEATHER/", HOST)).toBe(
			"http://www.cnn.com/WEATHER/",
		);
	});

	it("leaves a proxy-host URL with no embedded target unchanged", () => {
		expect(stripProxyUrl("https://timemachine.911realtime.org/about", HOST)).toBe(
			"https://timemachine.911realtime.org/about",
		);
	});

	it("returns non-URL input unchanged", () => {
		expect(stripProxyUrl("not a url", HOST)).toBe("not a url");
	});

	it("preserves query strings and fragments on the original URL", () => {
		expect(
			stripProxyUrl(
				"https://timemachine.911realtime.org/web/http://www.cnn.com/search?q=news#top",
				HOST,
			),
		).toBe("http://www.cnn.com/search?q=news#top");
	});
});

describe("normalizeUrl", () => {
	it("drops www and trailing slash", () => {
		expect(normalizeUrl("http://www.cnn.com/")).toBe("http://cnn.com");
	});
});

describe("resolveLinkTarget", () => {
	const CURRENT = "http://www.apple.com/education/";

	it("de-proxies a /web/<url> wrapper to the original target", () => {
		expect(
			resolveLinkTarget(
				`https://${HOST}/web/http://www.apple.com/store/`,
				"/web/http://www.apple.com/store/",
				CURRENT,
				HOST,
			),
		).toBe("http://www.apple.com/store/");
	});

	it("resolves a relative href against the current page", () => {
		expect(
			resolveLinkTarget("", "../macosx/", CURRENT, HOST),
		).toBe("http://www.apple.com/macosx/");
	});

	it("returns an absolute href as-is", () => {
		expect(
			resolveLinkTarget(
				"http://www.apple.com/ipod/",
				"http://www.apple.com/ipod/",
				CURRENT,
				HOST,
			),
		).toBe("http://www.apple.com/ipod/");
	});

	it("returns null for non-navigable schemes", () => {
		expect(
			resolveLinkTarget("mailto:tim@apple.com", "mailto:tim@apple.com", CURRENT, HOST),
		).toBeNull();
	});
});

describe("isValidCssColor", () => {
	it("accepts hex colors", () => {
		expect(isValidCssColor("#551A8B")).toBe(true);
		expect(isValidCssColor("#abc")).toBe(true);
	});
	it("accepts named colors", () => {
		expect(isValidCssColor("purple")).toBe(true);
	});
	it("rejects junk", () => {
		expect(isValidCssColor("not a color")).toBe(false);
		expect(isValidCssColor("")).toBe(false);
	});
});

describe("extractLinkColors", () => {
	it("reads link/vlink/alink from the raw body tag", () => {
		expect(
			extractLinkColors(
				`<html><body bgcolor="#fff" link="#0000FF" vlink="#551A8B" alink="red">x</body></html>`,
			),
		).toEqual({ link: "#0000FF", visited: "#551A8B", active: "red" });
	});
	it("normalizes a bare hex value with a leading #", () => {
		expect(extractLinkColors(`<body vlink=551A8B>`).visited).toBe("#551A8B");
	});
	it("returns nulls when body declares no colors", () => {
		expect(extractLinkColors(`<body bgcolor="#fff">`)).toEqual({
			link: null,
			visited: null,
			active: null,
		});
	});
	it("returns nulls when there is no body tag", () => {
		expect(extractLinkColors(`<a href="/x">x</a>`)).toEqual({
			link: null,
			visited: null,
			active: null,
		});
	});
});

describe("buildLinkStyle", () => {
	it("emits a rule per declared color in link → visited → active order", () => {
		expect(
			buildLinkStyle({ link: "#00f", visited: "#551A8B", active: "red" }),
		).toBe(
			"a:link,area:link{color:#00f}\n" +
				"a.browserVisited,area.browserVisited{color:#551A8B}\n" +
				"a:active,area:active{color:red}",
		);
	});
	it("omits rules for absent colors", () => {
		expect(buildLinkStyle({ link: null, visited: "#551A8B", active: null })).toBe(
			"a.browserVisited,area.browserVisited{color:#551A8B}",
		);
	});
});
