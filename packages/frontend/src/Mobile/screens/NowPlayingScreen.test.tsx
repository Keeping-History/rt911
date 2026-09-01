import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Station } from "../../Applications/radio-core/stationGrouping";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { NowPlayingScreen } from "./NowPlayingScreen";

// The screen resolves station artwork through this Directus-backed hook;
// tests supply the map directly instead of hitting the network.
vi.mock("../../Applications/radio-core/stationLogos", () => ({
	useStationLogos: () => ({ WCBS: "https://example.test/wcbs-logo.png" }),
}));

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

const tvChannel: MediaItem = {
	id: 42,
	// title deliberately differs from source so getByText("WABC") proves the
	// screen shows `source`, not the `title` fallback.
	title: "Channel 7",
	full_title: "WABC 7 New York",
	source: "WABC",
	start_date: "2001-09-11T12:30:00",
	url: "https://example.test/wabc.m3u8",
	format: "m3u8",
	approved: 1,
	mute: 0,
	volume: 1,
	jump: 0,
	trim: 0,
};

describe("NowPlayingScreen", () => {
	it("shows station, clip title, and the virtual clock", () => {
		render(
			<NowPlayingScreen station={station} tvChannel={null} nowMs={NOW} tzOffset={-4} clockPaused={false} />,
		);
		expect(screen.getByText("WINS")).toBeTruthy();
		expect(screen.getByText("1010 WINS full coverage")).toBeTruthy();
		expect(screen.getByText("8:40:00 AM")).toBeTruthy(); // 12:40 UTC at -4
	});

	it("shows off-air when the station has no current segment", () => {
		render(
			<NowPlayingScreen
				station={{ key: "KYW", label: "KYW", items: [] }}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(screen.getByText(/off air/i)).toBeTruthy();
	});

	it("prompts to pick a station when none is tuned", () => {
		render(<NowPlayingScreen station={null} tvChannel={null} nowMs={NOW} tzOffset={-4} clockPaused={false} />);
		expect(screen.getByText(/choose a station/i)).toBeTruthy();
	});

	it("shows the channel and clock when a TV channel is tuned", () => {
		render(
			<NowPlayingScreen
				station={null}
				tvChannel={tvChannel}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(screen.getByText("WABC")).toBeTruthy();
		expect(screen.getByText("8:40:00 AM")).toBeTruthy();
	});

	it("notes when the clock is paused while watching TV", () => {
		render(
			<NowPlayingScreen
				station={null}
				tvChannel={tvChannel}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused
			/>,
		);
		expect(screen.getByText("paused")).toBeTruthy();
	});
});

// The station's artwork shows above the title, resolved exactly as on the
// desktop RadioTuner: a streaming item's image first, else the station's own
// logo from the Directus map (mocked above).
describe("NowPlayingScreen station logo", () => {
	it("shows the streaming item's image when the station carries one", () => {
		const withImage: Station = {
			...station,
			items: [{ ...station.items[0], image: "https://example.test/wins-art.png" }],
		};
		const { container } = render(
			<NowPlayingScreen
				station={withImage}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		const img = container.querySelector("img.ipodStationLogo") as HTMLImageElement;
		expect(img).toBeTruthy();
		expect(img.getAttribute("src")).toBe("https://example.test/wins-art.png");
	});

	it("falls back to the station's Directus logo when nothing is streaming", () => {
		const dark: Station = { key: "WCBS", label: "WCBS", items: [] };
		const { container } = render(
			<NowPlayingScreen
				station={dark}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		const img = container.querySelector("img.ipodStationLogo") as HTMLImageElement;
		expect(img).toBeTruthy();
		expect(img.getAttribute("src")).toBe("https://example.test/wcbs-logo.png");
	});

	it("hides the station name when a logo is shown (the artwork is the identity)", () => {
		const withImage: Station = {
			...station,
			items: [{ ...station.items[0], image: "https://example.test/wins-art.png" }],
		};
		render(
			<NowPlayingScreen
				station={withImage}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(screen.queryByText("WINS")).toBeNull();
	});

	it("keeps the station name when there is no artwork", () => {
		render(
			<NowPlayingScreen
				station={{ key: "KNOWN-NOWHERE", label: "X", items: [] }}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(screen.getByText("X")).toBeTruthy();
	});

	it("renders no logo element when the station has no artwork at all", () => {
		const dark: Station = { key: "KNOWN-NOWHERE", label: "X", items: [] };
		const { container } = render(
			<NowPlayingScreen
				station={dark}
				tvChannel={null}
				nowMs={NOW}
				tzOffset={-4}
				clockPaused={false}
			/>,
		);
		expect(container.querySelector("img.ipodStationLogo")).toBeNull();
	});
});
