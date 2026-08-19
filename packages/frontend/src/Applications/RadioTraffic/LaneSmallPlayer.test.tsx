import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LaneSmallPlayer } from "./LaneSmallPlayer";
import { makeItem, makeMeta } from "./tabs/cardTabFixtures";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests.
afterEach(cleanup);

/** The desktop's display offset on 2001-09-11. */
const TZ = -4;

function renderPlayer(
	props: Partial<Parameters<typeof LaneSmallPlayer>[0]> = {},
): HTMLElement {
	const { container } = render(
		<LaneSmallPlayer
			item={props.item ?? makeItem()}
			meta={"meta" in props ? props.meta : makeMeta()}
			tzOffsetHours={props.tzOffsetHours ?? TZ}
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
		expect(field(container, "subject")?.textContent).toBe("“Planes, as in plural.”");
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

	it("stamps the start with the date, the time and the zone", () => {
		const container = renderPlayer({
			item: makeItem({ start_date: "2001-09-11 12:33:00" }),
		});
		expect(field(container, "start")?.textContent).toBe("9/11/2001 8:33 AM ET");
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
		expect(field(container, "subject")?.textContent).toBe("“Boston Center — sector 20”");
	});

	it("ignores a whitespace-only subject rather than quoting nothing", () => {
		const container = renderPlayer({
			item: makeItem({ full_title: "Boston Center — sector 20" }),
			meta: makeMeta({ subject: "   " }),
		});
		expect(field(container, "subject")?.textContent).toBe("“Boston Center — sector 20”");
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
