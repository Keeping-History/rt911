import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TagDef } from "../../Providers/MediaStream/MediaStreamContext";
import { FilterTree, OPEN_BY_DEFAULT } from "./FilterTree";
import { groupVocabulary, LARGE_NAMESPACES, type TagGroup } from "./tagFilter";

// rt911 has no global test setup, so testing-library does not auto-clean the
// DOM between tests; do it explicitly to keep document-level queries isolated.
afterEach(cleanup);

/** A vocabulary row as the wire delivers it: `namespace:value` split out. */
function def(tag: string): TagDef {
	const i = tag.indexOf(":");
	return { tag, namespace: tag.slice(0, i), value: tag.slice(i + 1) };
}

// All 8 namespaces the corpus actually has, in the order the server sends them.
// Trimmed to a handful of values each — the counts (377/372/339 vs 25/6/5/5/2)
// are what decide large-vs-small, and that decision lives in tagFilter.
const VOCAB = [
	def("topic:hijack"),
	def("topic:scramble"),
	def("facility:zbw"),
	def("facility:zny"),
	def("link:primary"),
	def("link:landline"),
	def("tier:1"),
	def("tier:2"),
	def("aircraft:aal11"),
	def("aircraft:ual175"),
	def("agency:faa"),
	def("agency:neads"),
	def("role:pilot"),
	def("role:controller"),
	def("person:ong"),
];

const GROUPS = groupVocabulary(VOCAB);
const SMALL = GROUPS.filter((g) => !g.large);
const LARGE = GROUPS.filter((g) => g.large);

const onToggle = vi.fn();
const onOpenPicker = vi.fn();
afterEach(() => {
	onToggle.mockReset();
	onOpenPicker.mockReset();
});

function renderTree(
	checked: string[] = [],
	groups: TagGroup[] = GROUPS,
	stale = false,
) {
	render(
		<FilterTree
			groups={groups}
			checked={new Set(checked)}
			onToggle={onToggle}
			onOpenPicker={onOpenPicker}
			stale={stale}
		/>,
	);
}

/**
 * Every control named after a namespace — its row, and nothing else.
 *
 * Rows cannot be counted as "all buttons": classicy wraps each checkbox's label
 * in a `role="button"` div of its own, so a five-value namespace contributes six.
 * The name is matched loosely because a disclosure header also carries the
 * triangle's "Toggle" title, and case-sensitively because namespace labels are
 * capitalised where tag values are not.
 */
const rowsFor = (label: string) =>
	screen.queryAllByRole("button", { name: new RegExp(label) });

/** A namespace's one row, asserting on the way through that it has exactly one. */
const row = (label: string) => {
	const found = rowsFor(label);
	expect(found).toHaveLength(1);
	return found[0];
};
/** The whole disclosure a small namespace's row heads, children included. */
const section = (label: string) => row(label).closest(".classicyDisclosure");
const box = (value: string) => screen.getByLabelText(value) as HTMLInputElement;

describe("FilterTree", () => {
	it("renders exactly one row per namespace", () => {
		renderTree();
		expect(GROUPS).toHaveLength(8);
		// `row` fails if a namespace renders none or more than one — a large
		// namespace that also expanded inline would show up here.
		for (const group of GROUPS) expect(row(group.label)).not.toBeNull();
	});

	it("expands the five small namespaces inline, a checkbox per value", () => {
		renderTree();
		expect(SMALL.map((g) => g.namespace)).toEqual([
			"topic",
			"link",
			"tier",
			"agency",
			"role",
		]);

		for (const group of SMALL) {
			const inline = section(group.label);
			expect(inline).not.toBeNull();
			for (const tag of group.values) {
				// Inside the namespace's own disclosure, not merely somewhere on the page.
				expect(inline?.contains(box(tag.value as string))).toBe(true);
			}
		}
	});

	it("collapses and re-expands a small namespace when its row is clicked", () => {
		renderTree();
		const header = row("Topic");
		const before = header.getAttribute("aria-expanded");

		fireEvent.click(header);
		expect(header.getAttribute("aria-expanded")).not.toBe(before);
		fireEvent.click(header);
		expect(header.getAttribute("aria-expanded")).toBe(before);
	});

	it("opens the picker for a large namespace instead of expanding it", () => {
		renderTree();
		expect(LARGE.map((g) => g.namespace).sort()).toEqual([
			...LARGE_NAMESPACES,
		].sort());

		for (const group of LARGE) {
			// 377 checkboxes do not belong in a 141px sidebar — the row is a door.
			expect(section(group.label)).toBeNull();
			for (const tag of group.values) {
				expect(screen.queryByLabelText(tag.value as string)).toBeNull();
			}

			fireEvent.click(row(group.label));
			expect(onOpenPicker).toHaveBeenLastCalledWith(group.namespace);
		}
		expect(onOpenPicker).toHaveBeenCalledTimes(LARGE.length);
	});

	it("shows a large namespace's checked count, which is all the row can show", () => {
		renderTree(["aircraft:aal11", "aircraft:ual175", "facility:zbw"]);

		expect(row("Aircraft").textContent).toContain("2");
		expect(row("Facility").textContent).toContain("1");
		// A row with nothing checked stays quiet rather than reading "(0)".
		expect(row("Person").textContent).not.toMatch(/\d/);
	});

	it("counts only tags the namespace actually has", () => {
		// A checked tag the vocabulary no longer carries has no box in the picker
		// either, so counting it would advertise a filter the user cannot clear.
		renderTree(["aircraft:aal11", "aircraft:retired"]);
		expect(row("Aircraft").textContent).toContain("1");
	});

	it("reports the tag string, not the display value, when a value is checked", () => {
		renderTree();
		fireEvent.click(box("hijack"));
		expect(onToggle).toHaveBeenCalledWith("topic:hijack");
	});

	it("reports a tick and an untick alike, leaving the set to its owner", () => {
		// The tree is fully controlled: it reports the tag either way and the app
		// shell decides. A tree that only reported ticks could not be unticked.
		renderTree(["topic:hijack"]);
		fireEvent.click(box("hijack"));
		expect(onToggle).toHaveBeenCalledWith("topic:hijack");
	});

	it("renders a checked value as checked", () => {
		renderTree(["topic:hijack", "tier:2"]);
		expect(box("hijack").checked).toBe(true);
		expect(box("2").checked).toBe(true);
		expect(box("scramble").checked).toBe(false);
	});

	it("omits a namespace with no values", () => {
		// Nothing to tick and nothing for a picker to list — the row would be a
		// dead end either way.
		const empty: TagGroup[] = [
			{ namespace: "topic", label: "Topic", values: [def("topic:hijack")], large: false },
			{ namespace: "role", label: "Role", values: [], large: false },
			{ namespace: "person", label: "Person", values: [], large: true },
		];
		renderTree([], empty);

		expect(row("Topic")).not.toBeNull();
		expect(rowsFor("Role")).toEqual([]);
		expect(rowsFor("Person")).toEqual([]);
	});

	it("boots the namespaces that fit already open, which ClassicyDisclosure cannot", () => {
		// The whole reason for the repo-local Disclosure: `defaultOpen`. classicy's
		// own disclosure always boots closed, so every row below would read
		// aria-expanded="false" and the sidebar would open as eight dead headers.
		renderTree();
		expect(OPEN_BY_DEFAULT.size).toBeGreaterThan(0);

		for (const group of SMALL) {
			expect(row(group.label).getAttribute("aria-expanded")).toBe(
				String(OPEN_BY_DEFAULT.has(group.namespace)),
			);
		}
		// A large namespace has no disclosure to open, so listing one would be a
		// default that never applies.
		for (const namespace of OPEN_BY_DEFAULT) {
			expect(LARGE_NAMESPACES.has(namespace)).toBe(false);
		}
	});

	it("renders a stale vocabulary in full, saying so rather than blanking", () => {
		// Decision 5: tag filtering IS the navigation here, so the last-known-good
		// copy stays usable when GET /mp3/tags fails. An empty tree is feature loss.
		renderTree(["topic:hijack"], GROUPS, true);

		for (const group of GROUPS) expect(row(group.label)).not.toBeNull();
		expect(box("hijack").checked).toBe(true);
		expect(screen.getByRole("status").textContent).toMatch(/out of date/i);
	});

	it("says nothing about staleness when the vocabulary is fresh", () => {
		renderTree();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says the vocabulary is unavailable when there has never been one", () => {
		// The one case with genuinely nothing to render: no good copy was ever
		// fetched. Better an explanation than a blank 141px column.
		renderTree([], [], true);
		expect(screen.queryAllByRole("button")).toEqual([]);
		expect(screen.getByText(/unavailable/i)).not.toBeNull();
	});
});
