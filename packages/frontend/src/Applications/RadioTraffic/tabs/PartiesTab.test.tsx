import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeItem, makeMeta } from "./cardTabFixtures";
import { PartiesTab } from "./PartiesTab";

afterEach(cleanup);

const TZ = -4;

const parties = (root: HTMLElement) =>
	Array.from(root.querySelectorAll<HTMLElement>("[data-participant]"));

const field = (party: HTMLElement, name: string) =>
	party.querySelector(`[data-field="${name}"]`)?.textContent ?? null;

const badge = (party: HTMLElement) =>
	party.querySelector<HTMLElement>("[data-confidence]");

describe("PartiesTab", () => {
	it("renders one column per participant", () => {
		const { container } = render(
			<PartiesTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		expect(parties(container)).toHaveLength(2);
	});

	it("renders each participant's person, facility and role", () => {
		const { container } = render(
			<PartiesTab item={makeItem()} meta={makeMeta()} tzOffsetHours={TZ} />,
		);
		const [first, second] = parties(container);
		expect(field(first, "person")).toBe("Pete Zalewski");
		expect(field(first, "facility")).toBe("ZBW");
		expect(field(first, "role")).toBe("controller");
		expect(field(second, "person")).toBe("John Ogonowski");
		expect(field(second, "facility")).toBe("AAL11");
		expect(field(second, "role")).toBe("pilot");
	});

	it("badges each participant with its own confidence level", () => {
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({
					participants: [
						{ person: "A", confidence: "high" },
						{ person: "B", confidence: "medium" },
						{ person: "C", confidence: "low" },
					],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		const levels = parties(container).map((p) => badge(p)?.dataset.confidence);
		expect(levels).toEqual(["high", "medium", "low"]);
	});

	it("gives high, medium and low visually distinct badges", () => {
		// The badge is how a reader knows whether to trust the attribution, so
		// the three levels must not collapse into one indistinguishable chip.
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({
					participants: [
						{ person: "A", confidence: "high" },
						{ person: "B", confidence: "medium" },
						{ person: "C", confidence: "low" },
					],
				})}
				tzOffsetHours={TZ}
			/>,
		);
		const classes = parties(container).map((p) => badge(p)?.className ?? "");
		expect(classes.every((c) => c.length > 0)).toBe(true);
		expect(new Set(classes).size).toBe(3);
	});

	it("normalises the level the derivation wrote, whatever its casing", () => {
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({ participants: [{ person: "A", confidence: " High " }] })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(badge(parties(container)[0])?.dataset.confidence).toBe("high");
	});

	it("still shows an unrecognised confidence rather than dropping it", () => {
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({ participants: [{ person: "A", confidence: "speculative" }] })}
				tzOffsetHours={TZ}
			/>,
		);
		const chip = badge(parties(container)[0]);
		expect(chip?.dataset.confidence).toBe("other");
		expect(chip?.textContent).toBe("speculative");
	});

	it("carries no badge for a participant the derivation graded not at all", () => {
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({ participants: [{ person: "A" }] })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(badge(parties(container)[0])).toBeNull();
		expect(field(parties(container)[0], "person")).toBe("A");
	});

	it("omits the fields a participant has no value for", () => {
		const { container } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({ participants: [{ facility: "ZBW" }] })}
				tzOffsetHours={TZ}
			/>,
		);
		const party = parties(container)[0];
		expect(field(party, "facility")).toBe("ZBW");
		expect(party.querySelector('[data-field="person"]')).toBeNull();
		expect(party.querySelector('[data-field="role"]')).toBeNull();
	});

	it("says nobody was identified rather than showing an empty grid", () => {
		const { container, getByText } = render(
			<PartiesTab
				item={makeItem()}
				meta={makeMeta({ participants: [] })}
				tzOffsetHours={TZ}
			/>,
		);
		expect(parties(container)).toHaveLength(0);
		expect(getByText(/no parties identified/i)).toBeTruthy();
	});

	it("says nobody was identified for an item with no metadata", () => {
		const { container, getByText } = render(
			<PartiesTab item={makeItem()} tzOffsetHours={TZ} />,
		);
		expect(parties(container)).toHaveLength(0);
		expect(getByText(/no parties identified/i)).toBeTruthy();
	});
});
