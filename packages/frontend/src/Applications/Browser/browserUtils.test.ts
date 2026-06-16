import { describe, expect, it } from "vitest";
import { normalizeUrl, stripProxyUrl } from "./browserUtils";

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
