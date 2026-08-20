import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { MentionsTab } from "./MentionsTab";

afterEach(cleanup);

const TZ = -4;

const columnNames = (root: HTMLElement) =>
	Array.from(root.querySelectorAll("[data-column]")).map((c) =>
		c.getAttribute("data-column"),
	);

const columnValues = (root: HTMLElement, name: string) =>
	Array.from(root.querySelectorAll(`[data-column="${name}"] li`)).map(
		(li) => li.textContent,
	);

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
