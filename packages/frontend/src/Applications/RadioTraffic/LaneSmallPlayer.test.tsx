import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom has no ResizeObserver; the marquee tests below opt LaneSmallPlayer's
// own useHorizontalOverflow call into actually measuring instead of the
// hook's no-ResizeObserver "report fits" fallback. Same stub as
// radio-core/marquee.test.tsx.
vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

import { LaneSmallPlayer } from "./LaneSmallPlayer";
import { makeItem, makeMeta } from "./tabs/cardTabFixtures";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests.
afterEach(cleanup);

/** The desktop's display offset on 2001-09-11. */
const TZ = -4;

// A day after every fixture's start_date below, so the default render exercises
// the "different day" (date kept) path unless a test overrides currentMs.
const NEXT_DAY_NOW_MS = Date.UTC(2001, 8, 12, 16, 0, 0);

function renderPlayer(
	props: Partial<Parameters<typeof LaneSmallPlayer>[0]> = {},
): HTMLElement {
	const { container } = render(
		<LaneSmallPlayer
			item={props.item ?? makeItem()}
			meta={"meta" in props ? props.meta : makeMeta()}
			tzOffsetHours={props.tzOffsetHours ?? TZ}
				enableMarquee={props.enableMarquee}
			currentMs={"currentMs" in props ? (props.currentMs ?? null) : NEXT_DAY_NOW_MS}
		/>,
	);
	return container;
}

const field = (root: ParentNode, name: string) =>
	root.querySelector(`[data-field="${name}"]`);

describe("LaneSmallPlayer content", () => {
	// Story 027 names five things the collapsed player has to carry. Each of the
	// first five tests is one of them; together they are the difference between
	// a folded lane a listener can still read and the empty strip this replaced.

	it("quotes the subject", () => {
		const container = renderPlayer({
			meta: makeMeta({ subject: "Planes, as in plural." }),
		});
		expect(field(container, "subject")?.textContent).toBe("Planes, as in plural.");
	});

	it("shows every tag as a chip", () => {
		const container = renderPlayer();
		const chips = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
		// makeMeta's three tags, by their human values rather than their keys.
		expect(chips).toEqual(["Hijacking", "ZBW", "AAL11"]);
	});

	it("colours each chip by its namespace", () => {
		// The namespace palette, not a per-chip decision here: mp3_tags.color is
		// NULL on every row today, so a chip that took its colour from the row
		// would render the whole corpus in one grey.
		const container = renderPlayer();
		const chips = Array.from(container.querySelectorAll("li"));
		const colors = chips.map((chip) => (chip as HTMLElement).style.background);
		expect(colors).toEqual([
			"var(--rt-tag-topic)",
			"var(--rt-tag-facility)",
			"var(--rt-tag-aircraft)",
		]);
		// Three namespaces, three different colours — the point of colour-coding.
		expect(new Set(colors).size).toBe(3);
	});

	it("stamps the start with the date, the time and the zone when the clock reads a different day", () => {
		const container = renderPlayer({
			item: makeItem({ start_date: "2001-09-11 12:33:00" }),
			currentMs: NEXT_DAY_NOW_MS,
		});
		expect(field(container, "start")?.textContent).toBe("9/11/2001 8:33 AM ET");
	});

	it("drops the date, keeping the time and zone, when the clock reads the same day (#523)", () => {
		const container = renderPlayer({
			item: makeItem({ start_date: "2001-09-11 12:33:00" }),
			// Later the same display-day: 2001-09-11T16:00Z is noon ET on the 11th.
			currentMs: Date.UTC(2001, 8, 11, 16, 0, 0),
		});
		expect(field(container, "start")?.textContent).toBe("8:33 AM ET");
	});

	it("spells the duration out in seconds", () => {
		const container = renderPlayer({
			item: makeItem({
				start_date: "2001-09-11 12:46:31",
				end_date: "2001-09-11 12:47:39",
			}),
		});
		expect(field(container, "duration")?.textContent).toBe("68 seconds");
	});

	it("names the link type", () => {
		const container = renderPlayer({ meta: makeMeta({ link: "Conference Call" }) });
		expect(field(container, "link")?.textContent).toBe("Conference Call");
	});
});

describe("LaneSmallPlayer with incomplete metadata", () => {
	// 59 of 814 items have no row in the mp3_meta frame at all, and a collapsed
	// lane full of blank cards would look broken rather than sparse.

	it("falls back to the clip's title when nothing transcribed a subject", () => {
		const container = renderPlayer({
			item: makeItem({ full_title: "Boston Center — sector 20" }),
			meta: undefined,
		});
		expect(field(container, "subject")?.textContent).toBe("Boston Center — sector 20");
	});

	it("ignores a whitespace-only subject rather than quoting nothing", () => {
		const container = renderPlayer({
			item: makeItem({ full_title: "Boston Center — sector 20" }),
			meta: makeMeta({ subject: "   " }),
		});
		expect(field(container, "subject")?.textContent).toBe("Boston Center — sector 20");
	});

	it("still prints the timings for an item with no metadata", () => {
		// A clip always has a start, whether or not anything transcribed it.
		const container = renderPlayer({ meta: undefined });
		expect(field(container, "start")).not.toBeNull();
		expect(field(container, "duration")).not.toBeNull();
	});

	it("drops the chip row entirely rather than leaving an empty list", () => {
		const container = renderPlayer({ meta: makeMeta({ tags: [] }) });
		expect(container.querySelector("ul")).toBeNull();
	});

	it("drops the link line when the row has none", () => {
		const container = renderPlayer({ meta: makeMeta({ link: "  " }) });
		expect(field(container, "link")).toBeNull();
	});

	it("drops the duration when the clip has no end", () => {
		// An absent end is a fact about the ROW, not about the recording — so the
		// line goes rather than printing a length nobody knows.
		const container = renderPlayer({
			item: makeItem({ end_date: "" }),
			meta: undefined,
		});
		expect(field(container, "duration")).toBeNull();
	});
});

describe("LaneSmallPlayer chrome", () => {
	it("tags itself with the item it is showing", () => {
		// The shell renders these through a lane slot keyed by the same id; the
		// attribute is what lets a test — and a debugger — tell them apart.
		const container = renderPlayer({ item: makeItem({ id: 42 }) });
		expect(container.querySelector("[data-small-player]")?.getAttribute("data-small-player"))
			.toBe("42");
	});

	it("carries no transport, mute or waveform", () => {
		// The design's collapsed player is a reference, not an instrument. Every
		// control it drops is one expand away, and a half-working transport on a
		// card with no waveform to seek would be worse than none.
		const container = renderPlayer();
		expect(container.querySelector("button")).toBeNull();
		expect(container.querySelector("canvas")).toBeNull();
	});
});

describe("LaneSmallPlayer marquee (issue #522)", () => {
	// UPCOMING and PREVIOUS opt into scrolling a chip row too wide to fit,
	// rather than clipping the rest of a curator's tags away with no way to
	// ever see them. LIVE never sets `enableMarquee`, so it keeps the plain,
	// clipped row exercised by the "shows every tag as a chip" test above.

	it("renders the plain chip list, no marquee, when the tags fit", () => {
		// jsdom reports scrollWidth/clientWidth as 0 by default, so
		// useHorizontalOverflow's own "fits" arithmetic (0 > 0 + 1) holds even
		// with a live ResizeObserver — nothing needs to be forced here.
		const container = renderPlayer({ enableMarquee: true });
		expect(container.querySelector(".rfm-marquee-container")).toBeNull();
		const chips = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
		expect(chips).toEqual(["Hijacking", "ZBW", "AAL11"]);
	});

	it("wraps an overflowing chip row in the marquee, keeping every chip present", () => {
		// Force the row wider than its wrapper: override scrollWidth/clientWidth
		// on the element prototype so useHorizontalOverflow's synchronous first
		// measure (on mount, before any real resize) already sees overflow.
		Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
			configurable: true,
			get: () => 900,
		});
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get: () => 300,
		});
		try {
			const container = renderPlayer({ enableMarquee: true });
			expect(container.querySelector(".rfm-marquee-container")).not.toBeNull();
			// react-fast-marquee duplicates its children for a seamless loop, so
			// each chip appears more than once — assert presence, not count.
			const chipTexts = new Set(
				Array.from(container.querySelectorAll("li")).map((li) => li.textContent),
			);
			expect(chipTexts).toEqual(new Set(["Hijacking", "ZBW", "AAL11"]));
		} finally {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
			Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
		}
	});
});
