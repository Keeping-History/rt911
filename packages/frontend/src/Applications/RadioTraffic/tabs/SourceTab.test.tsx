import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { SourceTab } from "./SourceTab";

afterEach(cleanup);

const TZ = -4;

const rows = (root: HTMLElement) =>
	Array.from(root.querySelectorAll("[data-row]")).map((r) => [
		r.querySelector("dt")?.textContent,
		r.querySelector("dd")?.textContent,
	]);

describe("SourceTab", () => {
	it("renders the provenance the derivation published", () => {
		const { container } = render(
			<SourceTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(rows(container)).toEqual([
			["Title", "9/11 Commission Report"],
			["Source", "NARA"],
			["Stamp", "ch.1 n.44"],
			["Subject", "transcript"],
			["Generated", "2026-08-14T09:12:00Z"],
		]);
	});

	it("says where the recording is unaccounted for rather than showing nothing", () => {
		const { container, getByText } = render(
			<SourceTab
				item={makeItem()}
				meta={makeMeta({ provenance: undefined })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(rows(container)).toEqual([]);
		expect(getByText(/no provenance recorded/i)).toBeTruthy();
	});

	it("renders the placeholder for an item with no metadata", () => {
		const { container, getByText } = render(
			<SourceTab item={makeItem()} tzOffsetHours={TZ} />,
		);
		expect(rows(container)).toEqual([]);
		expect(getByText(/no provenance recorded/i)).toBeTruthy();
	});

	it("degrades to the placeholder when provenance is not the shape we expect", () => {
		// ItemMeta types provenance as `unknown`: a producer that changes its
		// shape must cost a blank panel, never a thrown render inside a card.
		const { container, getByText } = render(
			<SourceTab
				item={makeItem()}
				meta={makeMeta({ provenance: "unexpected" })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(rows(container)).toEqual([]);
		expect(getByText(/no provenance recorded/i)).toBeTruthy();
	});
});
