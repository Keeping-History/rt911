import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Station } from "../../Applications/RadioScanner/stationGrouping";
import { ScreenNavContext } from "../WheelContext";
import { RadioScreen } from "./RadioScreen";

afterEach(cleanup);
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const NOW = Date.parse("2001-09-11T12:40:00.000Z");
const onAir = (key: string): Station => ({
	key,
	label: key,
	items: [
		{
			id: 1, title: key, full_title: key, source: key,
			start_date: "2001-09-11T12:30:00", end_date: "2001-09-11T13:30:00",
			url: "https://example.test/a.mp3", format: "mp3",
			approved: 1, mute: 0, volume: 1, jump: 0, trim: 0,
		},
	],
});
const offAir = (key: string): Station => ({ key, label: key, items: [] });

describe("RadioScreen", () => {
	it("lists stations with on-air stations before offline ones", () => {
		render(
			<RadioScreen
				stations={[offAir("KYW"), onAir("WINS")]}
				nowMs={NOW}
				activeStationKey=""
				onTune={vi.fn()}
			/>,
		);
		const labels = screen.getAllByRole("listitem").map((li) => li.textContent);
		expect(labels[0]).toContain("WINS");
		expect(labels[labels.length - 1]).toContain("KYW");
		expect(screen.getByText("offline")).toBeTruthy();
	});

	it("tapping a station tunes it and opens Now Playing", () => {
		const onTune = vi.fn();
		const push = vi.fn();
		render(
			<ScreenNavContext.Provider value={{ push, pop: vi.fn() }}>
				<RadioScreen
					stations={[onAir("WINS")]}
					nowMs={NOW}
					activeStationKey=""
					onTune={onTune}
				/>
			</ScreenNavContext.Provider>,
		);
		fireEvent.click(screen.getByText("WINS"));
		expect(onTune).toHaveBeenCalledWith("WINS");
		expect(push).toHaveBeenCalledWith("nowPlaying");
	});

	it("keeps the highlight on the same station when the sort order reshuffles", () => {
		// Non-pinned stations (WINS/WCBS are pinned): both start on-air, so the
		// incoming order [KYW, WBZ] is the display order. Selecting WBZ (index 1)
		// then taking KYW off-air flips the sort to [WBZ, KYW] — the highlight
		// must follow WBZ, not stay glued to index 1 (now KYW).
		const props = {
			nowMs: NOW,
			activeStationKey: "",
			onTune: vi.fn(), // clicking selects AND activates; irrelevant here
		};
		const { rerender } = render(
			<RadioScreen {...props} stations={[onAir("KYW"), onAir("WBZ")]} />,
		);
		fireEvent.click(screen.getByText("WBZ"));
		rerender(
			<RadioScreen {...props} stations={[offAir("KYW"), onAir("WBZ")]} />,
		);
		const selected = screen
			.getAllByRole("listitem")
			.find((li) => li.className.includes("selected"));
		expect(selected?.textContent).toContain("WBZ");
	});
});
