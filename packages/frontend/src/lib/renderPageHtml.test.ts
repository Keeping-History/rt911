import { describe, expect, it } from "vitest";
import { isAllowedEmbedSrc, renderPageHtml, TABLE_WRAPPER_CLASS } from "./renderPageHtml";

/**
 * These carry the security weight of the CMS pages feature, so each assertion is
 * written to fail if the allowlist is loosened — a test that passes both before
 * and after a rule is removed proves nothing.
 */

const YT_EMBED = "https://www.youtube-nocookie.com/embed/abc123";

describe("isAllowedEmbedSrc", () => {
	it("accepts an allowlisted host on its required path", () => {
		expect(isAllowedEmbedSrc(YT_EMBED)).toBe(true);
		expect(isAllowedEmbedSrc("https://player.vimeo.com/video/12345")).toBe(true);
		expect(isAllowedEmbedSrc("https://archive.org/embed/some-item")).toBe(true);
	});

	it("rejects an off-allowlist host", () => {
		expect(isAllowedEmbedSrc("https://evil.example.com/pwn")).toBe(false);
	});

	// The check is host AND path. Host-only would admit arbitrary YouTube pages.
	it("rejects an allowlisted host on a non-embed path", () => {
		expect(isAllowedEmbedSrc("https://www.youtube.com/watch?v=abc123")).toBe(false);
		expect(isAllowedEmbedSrc("https://player.vimeo.com/channels/staffpicks")).toBe(false);
	});

	// A lookalike registered by an attacker must not pass a substring test.
	it("rejects hosts that merely contain an allowlisted name", () => {
		expect(isAllowedEmbedSrc("https://www.youtube.com.evil.example/embed/x")).toBe(false);
		expect(isAllowedEmbedSrc("https://evilyoutube.com/embed/x")).toBe(false);
	});

	it("rejects non-https schemes, including ones that parse cleanly", () => {
		// javascript: does NOT throw in the URL parser, so the protocol check is
		// load-bearing rather than redundant with the try/catch.
		expect(isAllowedEmbedSrc("javascript:alert(1)")).toBe(false);
		expect(isAllowedEmbedSrc("http://www.youtube-nocookie.com/embed/x")).toBe(false);
		expect(isAllowedEmbedSrc("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
	});

	it("rejects unparseable, relative and protocol-relative sources", () => {
		expect(isAllowedEmbedSrc("//www.youtube-nocookie.com/embed/x")).toBe(false);
		expect(isAllowedEmbedSrc("/embed/x")).toBe(false);
		expect(isAllowedEmbedSrc("not a url")).toBe(false);
		expect(isAllowedEmbedSrc(null)).toBe(false);
		expect(isAllowedEmbedSrc("")).toBe(false);
	});
});

describe("renderPageHtml", () => {
	it("keeps ordinary prose and formatting", () => {
		const out = renderPageHtml("<h2>Title</h2><p>Body <strong>bold</strong></p>");
		expect(out).toContain("<h2>Title</h2>");
		expect(out).toContain("<strong>bold</strong>");
	});

	it("keeps an allowlisted embed", () => {
		const out = renderPageHtml(`<p><iframe src="${YT_EMBED}" allowfullscreen></iframe></p>`);
		expect(out).toContain("<iframe");
		expect(out).toContain(YT_EMBED);
	});

	it("strips an iframe pointing off the allowlist", () => {
		const out = renderPageHtml('<iframe src="https://evil.example.com/pwn"></iframe>');
		expect(out).not.toContain("<iframe");
		expect(out).not.toContain("evil.example.com");
	});

	it("strips an iframe on an allowlisted host but a non-embed path", () => {
		const out = renderPageHtml('<iframe src="https://www.youtube.com/watch?v=abc"></iframe>');
		expect(out).not.toContain("<iframe");
	});

	// srcdoc carries its own inline document, so it would sidestep a check that
	// only inspects src. What matters is that the srcdoc content never survives —
	// not that the whole element goes. DOMPurify drops the attribute before our
	// pass runs, leaving the frame's legitimate src intact, which is the correct
	// outcome.
	it("never lets srcdoc content survive", () => {
		const out = renderPageHtml(
			`<iframe src="${YT_EMBED}" srcdoc="<h1>bypass</h1>"></iframe>`,
		);
		expect(out).not.toContain("srcdoc");
		expect(out).not.toContain("bypass");
	});

	// An iframe stripped of srcdoc and carrying no usable src has nothing left to
	// render, so it should not be emitted at all.
	it("strips an iframe whose only content source was srcdoc", () => {
		const out = renderPageHtml('<iframe srcdoc="<h1>bypass</h1>"></iframe>');
		expect(out).not.toContain("<iframe");
		expect(out).not.toContain("bypass");
	});

	it("strips script tags and inline event handlers", () => {
		const out = renderPageHtml(
			'<p>ok</p><script>alert(1)</script><img src="x" onerror="alert(2)">',
		);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("onerror");
		expect(out).toContain("<p>ok</p>");
	});

	it("strips javascript: hrefs but keeps ordinary links", () => {
		const out = renderPageHtml(
			'<a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>',
		);
		expect(out).not.toContain("javascript:");
		expect(out).toContain("https://example.com");
	});

	it("keeps images, which is how authored uploads render", () => {
		const out = renderPageHtml(
			'<img src="https://api.911realtime.org/assets/abc" alt="demo">',
		);
		expect(out).toContain("<img");
		expect(out).toContain("/assets/abc");
	});

	it("removes only the offending frame when several are mixed together", () => {
		const out = renderPageHtml(
			`<iframe src="${YT_EMBED}"></iframe><iframe src="https://evil.example.com/x"></iframe>`,
		);
		expect(out.match(/<iframe/g) ?? []).toHaveLength(1);
		expect(out).toContain("youtube-nocookie.com");
		expect(out).not.toContain("evil.example.com");
	});

	it("returns an empty string for empty input", () => {
		expect(renderPageHtml("")).toBe("");
		expect(renderPageHtml(null)).toBe("");
		expect(renderPageHtml(undefined)).toBe("");
	});
});

/**
 * The wrapper is what lets the stylesheet keep tables as real tables (banded,
 * full-column-width) while wide ones scroll instead of widening the page.
 */
describe("renderPageHtml table wrapping", () => {
	/** Parse the output so assertions are about structure, not string shape. */
	function parse(html: string): HTMLElement {
		const host = document.createElement("div");
		host.innerHTML = html;
		return host;
	}

	it("wraps an authored table in a scroll container", () => {
		const host = parse(renderPageHtml("<table><tr><td>a</td></tr></table>"));

		const wrapper = host.querySelector(`.${TABLE_WRAPPER_CLASS}`);
		expect(wrapper).not.toBeNull();
		// The table must be *inside* the wrapper — a sibling would leave the
		// overflow container empty and the table unclipped.
		expect(wrapper?.firstElementChild?.tagName).toBe("TABLE");
		expect(host.querySelectorAll("table")).toHaveLength(1);
	});

	it("wraps each of several tables", () => {
		const host = parse(
			renderPageHtml("<table><tr><td>a</td></tr></table><p>x</p><table><tr><td>b</td></tr></table>"),
		);
		expect(host.querySelectorAll(`.${TABLE_WRAPPER_CLASS}`)).toHaveLength(2);
	});

	// A nested table already scrolls with its ancestor; a wrapper of its own
	// would nest a second scrollbar inside the first.
	it("wraps only the outermost table when tables are nested", () => {
		const host = parse(
			renderPageHtml("<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>"),
		);
		expect(host.querySelectorAll(`.${TABLE_WRAPPER_CLASS}`)).toHaveLength(1);
		expect(host.querySelectorAll("table")).toHaveLength(2);
		expect(host.querySelector("td .pageTableScroll")).toBeNull();
	});

	it("does not re-wrap a table an author already wrapped", () => {
		const host = parse(
			renderPageHtml(
				`<div class="${TABLE_WRAPPER_CLASS}"><table><tr><td>a</td></tr></table></div>`,
			),
		);
		expect(host.querySelectorAll(`.${TABLE_WRAPPER_CLASS}`)).toHaveLength(1);
	});

	it("leaves the table's own content untouched", () => {
		const host = parse(
			renderPageHtml("<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>"),
		);
		expect(host.querySelector("th")?.textContent).toBe("Name");
		expect(host.querySelector("tbody td")?.textContent).toBe("a");
	});

	it("leaves bodies with no table alone", () => {
		expect(renderPageHtml("<p>plain</p>")).not.toContain(TABLE_WRAPPER_CLASS);
	});
});
