import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { DetailsTab } from "./DetailsTab";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

/** The desktop's seeded display offset (2001-09-11, UTC-4). */
const TZ = -4;

const field = (root: HTMLElement, name: string) =>
	root.querySelector(`[data-field="${name}"] dd`)?.textContent ?? null;

const column = (root: HTMLElement, name: string) =>
	root.querySelector(`[data-column="${name}"]`);

describe("DetailsTab layout", () => {
	it("renders Figma's three columns: Call Details, Tags and Summary", () => {
		const { container, getByText } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(column(container, "call-details")).not.toBeNull();
		expect(column(container, "tags")).not.toBeNull();
		expect(column(container, "summary")).not.toBeNull();
		for (const heading of ["Call Details", "Tags", "Summary"]) {
			expect(getByText(heading)).toBeTruthy();
		}
	});

	it("keeps the timings in Call Details and the subject in Summary", () => {
		// Which column a fact lands in is the whole point of the redesign — a
		// panel that renders all three headings but files the subject under Tags
		// would pass a heading-only check.
		const { container } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(column(container, "call-details")?.querySelector('[data-field="start"]')).not.toBeNull();
		expect(column(container, "summary")?.querySelector('[data-field="subject"]')).not.toBeNull();
		expect(column(container, "tags")?.querySelectorAll("li").length).toBe(3);
	});

	it("groups chips into a labelled row per namespace, in vocabulary order", () => {
		const { container } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const groups = [...container.querySelectorAll("[data-tag-group]")];
		expect(groups.map((g) => g.getAttribute("data-tag-group"))).toEqual([
			"topic",
			"facility",
			"aircraft",
		]);
		expect(groups.map((g) => g.querySelector("dt")?.textContent)).toEqual([
			"Topics",
			"Facilities",
			"Aircraft",
		]);
	});

	it("files a tag from an unknown namespace under Other rather than dropping it", () => {
		// mp3_tags.namespace is NOT NULL, so a ninth namespace means a curator
		// added one. Hiding their tag would look exactly like the tag not existing.
		const { container, getByText } = render(
			<DetailsTab
				item={makeItem()}
				meta={makeMeta({
					tags: [{ tag: "weather:vfr", namespace: "weather", value: "VFR" }],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(container.querySelector('[data-tag-group="other"]')).not.toBeNull();
		expect(getByText("VFR")).toBeTruthy();
	});

	it("keeps all three columns, each saying so, for an item with no metadata", () => {
		// Columns that collapsed would leave cards in a lane misaligned with each
		// other, and an empty box reads as a broken tab rather than an untagged clip.
		const { container, getByText } = render(
			<DetailsTab item={makeItem()} tzOffsetHours={TZ} />,
		);
		expect(column(container, "call-details")).not.toBeNull();
		expect(column(container, "tags")).not.toBeNull();
		expect(column(container, "summary")).not.toBeNull();
		expect(getByText("No tags.")).toBeTruthy();
		expect(getByText("No summary.")).toBeTruthy();
	});
});

describe("DetailsTab", () => {
	it("renders the clip's start, end, duration and link", () => {
		const { container } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(field(container, "start")).toMatch(/^8:46:31\sAM$/);
		expect(field(container, "end")).toMatch(/^8:49:44\sAM$/);
		expect(field(container, "duration")).toBe("03:13");
		expect(field(container, "link")).toBe("ZBW ↔ AAL11");
	});

	it("renders the subject", () => {
		const { getByText } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(
			getByText("Boston Center loses contact with American 11"),
		).toBeTruthy();
	});

	it("renders one chip per tag, labelled by its vocabulary value", () => {
		const { getAllByRole } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual([
			"Hijacking",
			"ZBW",
			"AAL11",
		]);
	});

	it("colours chips by namespace, because mp3_tags.color is null on every row", () => {
		const { getAllByRole } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const backgrounds = getAllByRole("listitem").map((li) => li.style.background);
		expect(backgrounds.every((b) => b.length > 0)).toBe(true);
		expect(new Set(backgrounds).size).toBe(3);
	});

	it("lets a curator's colour win when one is ever set", () => {
		const { getAllByRole } = render(
			<DetailsTab
				item={makeItem()}
				meta={makeMeta({
					tags: [
						{ tag: "facility:zbw", namespace: "facility", value: "ZBW", color: "rgb(1, 2, 3)" },
					],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(getAllByRole("listitem")[0].style.background).toBe("rgb(1, 2, 3)");
	});

	it("shifts the clock with the display offset rather than the browser's zone", () => {
		const { container } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={0} />,
		);
		expect(field(container, "start")).toMatch(/^12:46:31\sPM$/);
	});

	it("omits the end and duration for a clip with no known end", () => {
		// An item with neither end_date nor calc_duration has no known end — the
		// lane predicates keep it live indefinitely, so the panel must not
		// invent a finish time the rest of the app disagrees with.
		const { container } = render(
			<DetailsTab
				item={makeItem({ end_date: undefined, calc_duration: undefined })}
				meta={makeMeta()}
				tzOffsetHours={TZ}
			/>,
		);
		expect(field(container, "start")).toMatch(/^8:46:31\sAM$/);
		expect(container.querySelector('[data-field="end"]')).toBeNull();
		expect(container.querySelector('[data-field="duration"]')).toBeNull();
	});

	it("omits the link, subject and chips for an item with no metadata", () => {
		const { container, queryAllByRole } = render(
			<DetailsTab item={makeItem()} tzOffsetHours={TZ} />,
		);
		expect(container.querySelector('[data-field="link"]')).toBeNull();
		expect(container.querySelector('[data-field="subject"]')).toBeNull();
		expect(queryAllByRole("listitem")).toHaveLength(0);
		// The times come off the item itself, so they survive the metadata gap.
		expect(field(container, "start")).toMatch(/^8:46:31\sAM$/);
	});
});
