import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import { LargeNamespaceButtons } from "./LargeNamespaceButtons";
import { groupVocabulary, LARGE_NAMESPACES, type TagGroup } from "./tagFilter";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

/** A vocabulary row as the wire delivers it: `namespace:value` split out. */
function def(tag: string): TagDef {
	const i = tag.indexOf(":");
	return { tag, namespace: tag.slice(0, i), value: tag.slice(i + 1) };
}

// The three large namespaces the corpus has, trimmed to a handful of values
// each — the counts (377/372/339) are what decide large-vs-small, and that
// decision lives in tagFilter.
const VOCAB = [
	def("aircraft:aal11"),
	def("aircraft:ual175"),
	def("facility:zbw"),
	def("facility:zny"),
	def("person:ong"),
];

const GROUPS = groupVocabulary(VOCAB);

const onOpenPicker = vi.fn();
afterEach(() => {
	onOpenPicker.mockReset();
});

function renderButtons(checked: string[] = [], groups: TagGroup[] = GROUPS) {
	render(
		<LargeNamespaceButtons
			groups={groups}
			checked={new Set(checked)}
			onOpenPicker={onOpenPicker}
		/>,
	);
}

/**
 * Every control named after a namespace — its row, and nothing else. Matched
 * loosely and case-sensitively for the same reason FilterTree.test.tsx's
 * `rowsFor` is: namespace labels are capitalised where tag values are not.
 */
const rowsFor = (label: string) =>
	screen.queryAllByRole("button", { name: new RegExp(label) });

/** A namespace's one row, asserting on the way through that it has exactly one. */
const row = (label: string) => {
	const found = rowsFor(label);
	expect(found).toHaveLength(1);
	return found[0];
};

describe("LargeNamespaceButtons", () => {
	it("renders exactly one row per large namespace", () => {
		renderButtons();
		expect(GROUPS.map((g) => g.namespace).sort()).toEqual([...LARGE_NAMESPACES].sort());

		for (const group of GROUPS) expect(row(group.label)).not.toBeNull();
	});

	it("opens the picker for a namespace when its row is clicked", () => {
		renderButtons();

		for (const group of GROUPS) {
			fireEvent.click(row(group.label));
			expect(onOpenPicker).toHaveBeenLastCalledWith(group.namespace);
		}
		expect(onOpenPicker).toHaveBeenCalledTimes(GROUPS.length);
	});

	it("shows a namespace's checked count, which is all the row can show", () => {
		renderButtons(["aircraft:aal11", "aircraft:ual175", "facility:zbw"]);

		expect(row("Aircraft").textContent).toContain("2");
		expect(row("Facility").textContent).toContain("1");
		// A row with nothing checked stays quiet rather than reading "(0)".
		expect(row("Person").textContent).not.toMatch(/\d/);
	});

	it("counts only tags the namespace actually has", () => {
		// A checked tag the vocabulary no longer carries has no box in the picker
		// either, so counting it would advertise a filter the user cannot clear.
		renderButtons(["aircraft:aal11", "aircraft:retired"]);
		expect(row("Aircraft").textContent).toContain("1");
	});

	it("omits a namespace with no values", () => {
		// Nothing for a picker to list — the row would be a dead end.
		const withEmpty: TagGroup[] = [
			{ namespace: "aircraft", label: "Aircraft", values: [def("aircraft:aal11")], large: true },
			{ namespace: "person", label: "Person", values: [], large: true },
		];
		renderButtons([], withEmpty);

		expect(row("Aircraft")).not.toBeNull();
		expect(rowsFor("Person")).toEqual([]);
	});

	it("renders nothing when there are no large namespaces to show", () => {
		const { container } = render(
			<LargeNamespaceButtons groups={[]} checked={new Set()} onOpenPicker={onOpenPicker} />,
		);
		expect(container.firstChild).toBeNull();
	});
});
