import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpodList, type IpodListItem } from "./IpodList";

afterEach(cleanup);

// jsdom has no scrollIntoView.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const items: IpodListItem[] = [
	{ key: "radio", label: "Radio", arrow: true },
	{ key: "tt", label: "Time Travel", arrow: true },
	{ key: "np", label: "Now Playing", disabled: true },
];

describe("IpodList", () => {
	it("highlights the selected row", () => {
		render(
			<IpodList items={items} selectedIndex={1} onSelectedIndexChange={vi.fn()} onActivate={vi.fn()} />,
		);
		expect(screen.getByText("Time Travel").closest("li")?.className).toContain("selected");
		expect(screen.getByText("Radio").closest("li")?.className).not.toContain("selected");
	});

	it("tapping a row selects and activates it", () => {
		const onSelectedIndexChange = vi.fn();
		const onActivate = vi.fn();
		render(
			<IpodList items={items} selectedIndex={0} onSelectedIndexChange={onSelectedIndexChange} onActivate={onActivate} />,
		);
		fireEvent.click(screen.getByText("Time Travel"));
		expect(onSelectedIndexChange).toHaveBeenCalledWith(1);
		expect(onActivate).toHaveBeenCalledWith(1);
	});

	it("tapping a disabled row does nothing", () => {
		const onActivate = vi.fn();
		render(
			<IpodList items={items} selectedIndex={0} onSelectedIndexChange={vi.fn()} onActivate={onActivate} />,
		);
		fireEvent.click(screen.getByText("Now Playing"));
		expect(onActivate).not.toHaveBeenCalled();
	});

	it("renders value text and submenu arrows", () => {
		render(
			<IpodList
				items={[{ key: "w", label: "WINS", value: "offline", arrow: true }]}
				selectedIndex={0}
				onSelectedIndexChange={vi.fn()}
				onActivate={vi.fn()}
			/>,
		);
		expect(screen.getByText("offline")).toBeTruthy();
		expect(screen.getByText(">")).toBeTruthy();
	});
});
