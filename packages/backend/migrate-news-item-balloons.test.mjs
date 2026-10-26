// Run: pnpm test:scripts   (or: node --test packages/backend/migrate-news-item-balloons.test.mjs)
//
// Pins the sanitising half of migrate-news-item-balloons.mjs. GitHub code
// scanning (js/incomplete-multi-character-sanitization) flagged the original
// single-pass replace() calls: one removal can leave behind — or re-form —
// exactly the thing it removed, so stripping must run to a fixpoint.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	cleanBalloonText,
	escapeAttr,
	rewriteAnchorTag,
	rewriteContent,
} from "./migrate-news-item-balloons.mjs";

const NO_HANDLERS = /\bon[a-z]+\s*=/i;
const NO_TAGS = /<[^>]*>/;

describe("cleanBalloonText", () => {
	it("decodes double-escaped entities and strips leftover markup", () => {
		assert.equal(cleanBalloonText("Bush &amp;lt;em&amp;gt;said&amp;lt;/em&amp;gt; so"), "Bush said so");
	});

	it("unescapes the JS string it was extracted from", () => {
		assert.equal(cleanBalloonText("O\\'Neill \\\"quoted\\\""), "O'Neill \"quoted\"");
	});

	it("leaves no tag behind, however the markup nests, and is idempotent", () => {
		const nasty = [
			"<scr<b>ipt>alert(1)</scr</b>ipt>",
			"<<script>script>alert(1)<</script>/script>",
			"&lt;&lt;script&gt;script&gt;x&lt;/script&gt;",
			"a <b>bold <i>nested</i></b> tail",
			"lone < less-than and > greater-than",
		];
		for (const input of nasty) {
			const out = cleanBalloonText(input);
			assert.doesNotMatch(out, NO_TAGS, `tag survived in ${JSON.stringify(out)}`);
			assert.equal(cleanBalloonText(out), out, `not idempotent for ${JSON.stringify(input)}`);
		}
	});
});

describe("escapeAttr", () => {
	it("escapes every attribute-breaking character", () => {
		assert.equal(escapeAttr(`a&b"c<d>e`), "a&amp;b&quot;c&lt;d&gt;e");
	});
});

describe("rewriteAnchorTag", () => {
	const titles = new Map([[42, "Target Title"]]);
	const plain = `<a href="https://cnn.com/x" onmouseover="return OL('CNN &amp;amp; friends')" onmouseout="return nd()">`;

	it("replaces the dead OL()/nd() pair with a balloon title", () => {
		const { tag, resolution } = rewriteAnchorTag(plain, titles);
		assert.equal(resolution, "external-citation");
		assert.doesNotMatch(tag, NO_HANDLERS);
		assert.equal(tag, `<a href="https://cnn.com/x" data-balloon-title="CNN &amp; friends">`);
	});

	it("uses the target row's title for internal cross-references", () => {
		const internal = `<a href="#/news-item/42" onmouseover="return OL('stale preview')" onmouseout="return nd()">`;
		const { tag, resolution } = rewriteAnchorTag(internal, titles);
		assert.equal(resolution, "internal-title");
		assert.equal(tag, `<a href="#/news-item/42" data-balloon-title="Target Title">`);
	});

	it("leaves anchors without an OL() call untouched", () => {
		const { tag, resolution } = rewriteAnchorTag(`<a href="x" class="y">`, titles);
		assert.equal(resolution, null);
		assert.equal(tag, `<a href="x" class="y">`);
	});

	it("strips the attribute entirely when the text cleans to nothing", () => {
		const { tag, resolution } = rewriteAnchorTag(
			`<a href="x" onmouseover="return OL('<em></em>')" onmouseout="return nd()">`,
			titles,
		);
		assert.equal(resolution, "empty");
		assert.doesNotMatch(tag, NO_HANDLERS);
		assert.doesNotMatch(tag, /data-balloon-title/);
	});

	it("strips every copy of a repeated handler, not just the first", () => {
		const doubled =
			`<a href="x" onmouseover="return OL('one')" onmouseover="return OL('two')"` +
			` onmouseout="return nd()" onmouseout="return nd()">`;
		const { tag } = rewriteAnchorTag(doubled, titles);
		assert.doesNotMatch(tag, NO_HANDLERS, tag);
		assert.match(tag, /data-balloon-title="one"/);
	});

	it("strips a handler that only forms once an inner one is removed", () => {
		// Removing the inner onmouseover="…" leaves the outer halves touching,
		// which is a brand-new onmouseover="…" — the case a single pass misses.
		const nested =
			`<a href="x" onmouseonmouseover="return OL('inner')"over="return OL('outer')"` +
			` onmouseout="return nd()">`;
		const { tag } = rewriteAnchorTag(nested, titles);
		assert.doesNotMatch(tag, NO_HANDLERS, tag);
	});

	it("is idempotent: a second pass over its own output changes nothing", () => {
		const once = rewriteAnchorTag(plain, titles).tag;
		assert.deepEqual(rewriteAnchorTag(once, titles), { tag: once, resolution: null });
	});
});

describe("rewriteContent", () => {
	it("rewrites every anchor in a document and reports per-resolution counts", () => {
		const titles = new Map([[7, "Seven"]]);
		const content =
			`<p>See <a href="#/news-item/7" onmouseover="return OL('x')" onmouseout="return nd()">this</a>` +
			` and <a href="https://nyt.com" onmouseover="return OL('NYT')" onmouseout="return nd()">that</a>` +
			` and <a href="https://plain.example">plain</a>.</p>`;
		const { content: out, stats } = rewriteContent(content, titles);
		assert.deepEqual(stats, { "internal-title": 1, "external-citation": 1, empty: 0 });
		assert.doesNotMatch(out, NO_HANDLERS);
		assert.match(out, /data-balloon-title="Seven"/);
		assert.match(out, /data-balloon-title="NYT"/);
		assert.match(out, /<a href="https:\/\/plain.example">plain<\/a>/);
	});

	it("reports null stats and the same content when nothing needed rewriting", () => {
		const content = `<p><a href="https://plain.example">plain</a></p>`;
		assert.deepEqual(rewriteContent(content, new Map()), { content, stats: null });
	});
});
