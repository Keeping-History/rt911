import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rt911 has no global test setup for testing-library, so the DOM is not
// auto-cleaned between tests; do it explicitly to keep the role queries below
// isolated.
afterEach(cleanup);

import { CARD_TABS, CardTabBar } from "./CardTabBar";

/**
 * vitest.setup.ts installs an INERT global ResizeObserver, so
 * useHorizontalOverflow constructs one and never hears from it again — which is
 * why "does not overflow" is the default in every other suite. This stub
 * records the measure callback so a test can drive it, and jsdom reports 0 for
 * every width, so the widths are stamped on directly.
 */
class ResizeObserverStub {
	static instances: ResizeObserverStub[] = [];
	callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverStub.instances.push(this);
	}
	observe() {}
	unobserve() {}
	disconnect() {}
}

/** Make the strip wider/narrower than its viewport and re-run the measurement. */
function setOverflow(container: HTMLElement, overflowing: boolean) {
	const viewport = container.querySelector("[data-tab-viewport]") as HTMLElement;
	const strip = container.querySelector('[role="tablist"]') as HTMLElement;
	Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
	Object.defineProperty(strip, "scrollWidth", {
		configurable: true,
		value: overflowing ? 300 : 50,
	});
	const observer = ResizeObserverStub.instances.at(-1);
	if (!observer) throw new Error("the tab bar never constructed a ResizeObserver");
	act(() => observer.callback([], observer as unknown as ResizeObserver));
}

function renderBar(overrides: Partial<Parameters<typeof CardTabBar>[0]> = {}) {
	return render(
		<CardTabBar
			tabs={CARD_TABS}
			active={overrides.active ?? CARD_TABS[0].id}
			onSelect={overrides.onSelect ?? (() => {})}
		/>,
	);
}

describe("CardTabBar", () => {
	beforeEach(() => {
		ResizeObserverStub.instances = [];
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exposes five tabs", () => {
		// Five is the card's contract, not an incidental count: the five panels
		// Step 13 built are the five things a listener can ask a clip about.
		expect(CARD_TABS).toHaveLength(5);
		const { getAllByRole } = renderBar();
		expect(getAllByRole("tab")).toHaveLength(5);
	});

	it("marks exactly the active tab selected", () => {
		for (const tab of CARD_TABS) {
			cleanup();
			const { getAllByRole } = renderBar({ active: tab.id });
			const selected = getAllByRole("tab").filter(
				(el) => el.getAttribute("aria-selected") === "true",
			);
			expect(selected).toHaveLength(1);
			expect(selected[0].textContent).toBe(tab.label);
		}
	});

	it("reports the tab the listener picked", () => {
		const onSelect = vi.fn();
		const { getByRole } = renderBar({ onSelect });
		fireEvent.click(getByRole("tab", { name: CARD_TABS[2].label }));
		expect(onSelect).toHaveBeenCalledWith(CARD_TABS[2].id);
	});

	it("shows no arrows while the strip fits", () => {
		const { container, queryByRole } = renderBar();
		setOverflow(container, false);
		expect(queryByRole("button", { name: "Previous tab" })).toBeNull();
		expect(queryByRole("button", { name: "Next tab" })).toBeNull();
	});

	it("shows arrows once the strip overflows", () => {
		const { container, queryByRole } = renderBar();
		setOverflow(container, true);
		expect(queryByRole("button", { name: "Previous tab" })).not.toBeNull();
		expect(queryByRole("button", { name: "Next tab" })).not.toBeNull();
	});

	it("hides the arrows again when the strip is given room", () => {
		// Cards are resized by the lane they sit in (Step 18), so this is a live
		// transition, not just a mount-time choice.
		const { container, queryByRole } = renderBar();
		setOverflow(container, true);
		expect(queryByRole("button", { name: "Next tab" })).not.toBeNull();
		setOverflow(container, false);
		expect(queryByRole("button", { name: "Next tab" })).toBeNull();
	});

	it("pages to the next and previous tab", () => {
		const onSelect = vi.fn();
		const { container, getByRole } = renderBar({ active: CARD_TABS[1].id, onSelect });
		setOverflow(container, true);
		fireEvent.click(getByRole("button", { name: "Next tab" }));
		expect(onSelect).toHaveBeenCalledWith(CARD_TABS[2].id);
		fireEvent.click(getByRole("button", { name: "Previous tab" }));
		expect(onSelect).toHaveBeenCalledWith(CARD_TABS[0].id);
	});

	it("cannot page past either end", () => {
		const { container, getByRole } = renderBar({ active: CARD_TABS[0].id });
		setOverflow(container, true);
		expect(getByRole("button", { name: "Previous tab" })).toHaveProperty("disabled", true);
		expect(getByRole("button", { name: "Next tab" })).toHaveProperty("disabled", false);

		cleanup();
		const last = renderBar({ active: CARD_TABS[CARD_TABS.length - 1].id });
		setOverflow(last.container, true);
		expect(last.getByRole("button", { name: "Previous tab" })).toHaveProperty("disabled", false);
		expect(last.getByRole("button", { name: "Next tab" })).toHaveProperty("disabled", true);
	});
});
