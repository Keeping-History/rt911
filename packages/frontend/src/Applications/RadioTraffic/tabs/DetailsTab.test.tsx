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
	it("renders a single Details column, and no Tags or Summary", () => {
		// Summary is a tab of its own (story 035); Tags moved to the Mentions
		// tab (issue #521), so Details is down to the one column it has left.
		const { container, getByText, queryByText } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(column(container, "call-details")).not.toBeNull();
		expect(column(container, "tags")).toBeNull();
		expect(column(container, "summary")).toBeNull();
		expect(getByText("Details")).toBeTruthy();
		expect(queryByText("Tags")).toBeNull();
		expect(queryByText("Summary")).toBeNull();
	});

	it("keeps the timings in Details and never prints the subject", () => {
		const { container, queryByText } = render(
			<DetailsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(column(container, "call-details")?.querySelector('[data-field="start"]')).not.toBeNull();
		expect(container.querySelector('[data-field="subject"]')).toBeNull();
		expect(queryByText(makeMeta().subject as string)).toBeNull();
	});

	it("keeps the Details column, saying so, when nothing is timeable", () => {
		// A collapsed column would leave cards in a lane misaligned with each
		// other, and an empty box reads as a broken tab rather than an untimed
		// clip.
		const { container, getByText } = render(
			<DetailsTab
				item={makeItem({ start_date: "not-a-date", end_date: undefined, calc_duration: undefined })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(column(container, "call-details")).not.toBeNull();
		expect(getByText("No timings.")).toBeTruthy();
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

	it("omits the link for an item with no metadata", () => {
		const { container } = render(<DetailsTab item={makeItem()} tzOffsetHours={TZ} />);
		expect(container.querySelector('[data-field="link"]')).toBeNull();
		// The times come off the item itself, so they survive the metadata gap.
		expect(field(container, "start")).toMatch(/^8:46:31\sAM$/);
	});
});
