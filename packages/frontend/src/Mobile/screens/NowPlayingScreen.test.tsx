import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Station } from "../../Applications/RadioScanner/stationGrouping";
import { NowPlayingScreen } from "./NowPlayingScreen";

afterEach(cleanup);

const NOW = Date.parse("2001-09-11T12:40:00.000Z");
const station: Station = {
	key: "WINS",
	label: "WINS",
	items: [
		{
			id: 1,
			title: "1010 WINS coverage",
			full_title: "1010 WINS full coverage",
			source: "WINS",
			start_date: "2001-09-11T12:30:00",
			end_date: "2001-09-11T13:30:00",
			url: "https://example.test/a.mp3",
			format: "mp3",
			approved: 1,
			mute: 0,
			volume: 1,
			jump: 0,
			trim: 0,
		},
	],
};

describe("NowPlayingScreen", () => {
	it("shows station, clip title, and the virtual clock", () => {
		render(
			<NowPlayingScreen station={station} nowMs={NOW} tzOffset={-4} clockPaused={false} />,
		);
		expect(screen.getByText("WINS")).toBeTruthy();
		expect(screen.getByText("1010 WINS full coverage")).toBeTruthy();
		expect(screen.getByText("8:40:00 AM")).toBeTruthy(); // 12:40 UTC at -4
	});

	it("shows off-air when the station has no current segment", () => {
		render(
			<NowPlayingScreen
				station={{ key: "KYW", label: "KYW", items: [] }}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(screen.getByText(/off air/i)).toBeTruthy();
	});

	it("prompts to pick a station when none is tuned", () => {
		render(<NowPlayingScreen station={null} nowMs={NOW} tzOffset={-4} clockPaused={false} />);
		expect(screen.getByText(/choose a station/i)).toBeTruthy();
	});
});
