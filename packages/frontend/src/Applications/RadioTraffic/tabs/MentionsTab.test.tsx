import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { MentionsTab } from "./MentionsTab";

afterEach(cleanup);

const TZ = -4;

// Excludes the tags section's own `data-column="tags"` — a fifth,
// differently-shaped section (issue #521), not one of the four mentions
// columns this helper is naming.
const columnNames = (root: HTMLElement) =>
	Array.from(root.querySelectorAll('[data-column]:not([data-column="tags"])')).map((c) =>
		c.getAttribute("data-column"),
	);

const columnValues = (root: HTMLElement, name: string) =>
	Array.from(root.querySelectorAll(`[data-column="${name}"] li`)).map(
		(li) => li.textContent,
	);

const tagsSection = (root: HTMLElement) => root.querySelector('[data-column="tags"]');

const tagGroupEls = (root: HTMLElement) => [...root.querySelectorAll("[data-tag-group]")];

describe("MentionsTab", () => {
	it("renders four columns: facilities, aircraft, people and topics", () => {
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(columnNames(container)).toEqual([
			"facilities",
			"aircraft",
			"people",
			"topics",
		]);
	});

	it("reads the first three columns from the structured mentions fields", () => {
		// Not from tags: tags.py emits facility: for both a participant's own
		// facility and a merely-mentioned one, so a tag cannot say which a
		// facility was. Only mentions.* can.
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(columnValues(container, "facilities")).toEqual(["ZNY", "Otis ANGB"]);
		expect(columnValues(container, "aircraft")).toEqual(["UAL175"]);
		expect(columnValues(container, "people")).toEqual(["Betty Ong"]);
	});

	it("reads the topics column from topic: tags, there being no topics field", () => {
		// topics[] is a closed 25-value vocabulary already fully represented by
		// the topic: namespace; a separate field would be a second copy that can
		// disagree with the filter tree about the same recording.
		const { container } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					tags: [
						{ tag: "topic:hijacking", namespace: "topic", value: "Hijacking" },
						{ tag: "facility:zbw", namespace: "facility", value: "ZBW" },
						{ tag: "topic:handoff", namespace: "topic", value: "Handoff" },
					],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(columnValues(container, "topics")).toEqual(["Hijacking", "Handoff"]);
	});

	it("omits a column the recording has nothing for", () => {
		const { container } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					mentions: { facilities: ["ZNY"], aircraft: [], people: [] },
					tags: [],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(columnNames(container)).toEqual(["facilities"]);
	});

	it("says nobody else was named rather than showing an empty grid", () => {
		const { container, getByText } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					mentions: { facilities: [], aircraft: [], people: [] },
					tags: [],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(columnNames(container)).toEqual([]);
		expect(getByText(/nothing else named/i)).toBeTruthy();
	});

	it("renders nothing named for an item with no metadata", () => {
		const { container, getByText } = render(
			<MentionsTab item={makeItem()} tzOffsetHours={TZ} />,
		);
		expect(columnNames(container)).toEqual([]);
		expect(getByText(/nothing else named/i)).toBeTruthy();
	});

	it("survives a mentions object missing a list the derivation always writes", () => {
		// Mentions types all three as required because the derivation always
		// writes all three — but the wire is the authority, not the type.
		const { container } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					mentions: { facilities: ["ZNY"] } as never,
					tags: [],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(columnNames(container)).toEqual(["facilities"]);
	});
});

// The tags section — moved here from the Details tab's Tags column (issue
// #521), which had no vertical scroll and clipped a clip with many tags.
// Mentions already scrolls the way Transcript does, so the chips read in
// full here instead.
describe("MentionsTab tags section", () => {
	it("renders a fifth section, appended after the four mentions columns", () => {
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(columnNames(container)).toEqual(["facilities", "aircraft", "people", "topics"]);
		expect(tagsSection(container)).not.toBeNull();
	});

	it("groups chips into a labelled row per namespace, in vocabulary order", () => {
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const groups = tagGroupEls(container);
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

	it("renders one chip per tag, labelled by its vocabulary value", () => {
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const chips = [...(tagsSection(container)?.querySelectorAll("li") ?? [])];
		expect(chips.map((li) => li.textContent)).toEqual(["Hijacking", "ZBW", "AAL11"]);
	});

	it("colours chips by namespace, because mp3_tags.color is null on every row", () => {
		const { container } = render(
			<MentionsTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const chips = [
			...(tagsSection(container)?.querySelectorAll<HTMLLIElement>("li") ?? []),
		];
		const backgrounds = chips.map((li) => li.style.background);
		expect(backgrounds.every((b) => b.length > 0)).toBe(true);
		expect(new Set(backgrounds).size).toBe(3);
	});

	it("lets a curator's colour win when one is ever set", () => {
		const { container } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					tags: [
						{ tag: "facility:zbw", namespace: "facility", value: "ZBW", color: "rgb(1, 2, 3)" },
					],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		const chip = tagsSection(container)?.querySelector<HTMLLIElement>("li");
		expect(chip?.style.background).toBe("rgb(1, 2, 3)");
	});

	it("files a tag from an unknown namespace under Other rather than dropping it", () => {
		// mp3_tags.namespace is NOT NULL, so a ninth namespace means a curator
		// added one. Hiding their tag would look exactly like the tag not
		// existing.
		const { container, getByText } = render(
			<MentionsTab
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

	it("omits the tags section — not a \"No tags.\" line — for an item with no tags", () => {
		// Consistent with the four mentions columns' own empty behaviour: an
		// absent value drops its section rather than printing that it is absent.
		const { container, queryByText } = render(
			<MentionsTab
				item={makeItem()}
				meta={makeMeta({
					mentions: { facilities: ["ZNY"], aircraft: [], people: [] },
					tags: [],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		expect(tagsSection(container)).toBeNull();
		expect(queryByText("No tags.")).toBeNull();
		expect(queryByText("Tags")).toBeNull();
	});

	it("omits the tags section for an item with no metadata at all", () => {
		const { container } = render(<MentionsTab item={makeItem()} tzOffsetHours={TZ} />);
		expect(tagsSection(container)).toBeNull();
	});
});
