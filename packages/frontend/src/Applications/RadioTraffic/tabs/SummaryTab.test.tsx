import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { SummaryTab, summaryText } from "./SummaryTab";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

/** The desktop's seeded display offset (2001-09-11, UTC-4). */
const TZ = -4;

describe("summaryText", () => {
	it("reads the item's subject", () => {
		expect(summaryText(makeMeta())).toBe("Boston Center loses contact with American 11");
	});

	it("is undefined for an item with no metadata at all", () => {
		// 59 of the 814 mp3 items have no row in the mp3_meta frame.
		expect(summaryText(undefined)).toBeUndefined();
	});

	it("treats a blank subject as no summary", () => {
		// A subject of spaces is a tab that opens onto nothing — the whole reason
		// the card asks this question rather than checking for the field.
		expect(summaryText(makeMeta({ subject: "   " }))).toBeUndefined();
		expect(summaryText(makeMeta({ subject: undefined }))).toBeUndefined();
	});

	it("trims what it returns, so the panel and the tab agree on the text", () => {
		expect(summaryText(makeMeta({ subject: "  Ground stop  " }))).toBe("Ground stop");
	});
});

describe("SummaryTab", () => {
	it("renders the subject under its own heading", () => {
		const { container, getByText } = render(
			<SummaryTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(getByText("Summary")).toBeTruthy();
		expect(container.querySelector('[data-field="subject"]')?.textContent).toBe(
			"Boston Center loses contact with American 11",
		);
	});

	it("marks itself as the summary panel, matching its row in CARD_TABS", () => {
		// The card looks its panel up by id and the panel stamps the same string;
		// a drift between the two is a tab that renders the wrong content.
		const { container } = render(
			<SummaryTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(container.querySelector('[data-tab="summary"]')).not.toBeNull();
	});

	it("says so rather than painting an empty box when there is no summary", () => {
		// Not a state the card routinely shows — it hides the tab instead — but a
		// panel that renders nothing at all is indistinguishable from a broken one.
		const { getByText } = render(<SummaryTab item={makeItem()} tzOffsetHours={TZ} />);
		expect(getByText("No summary.")).toBeTruthy();
	});
});
