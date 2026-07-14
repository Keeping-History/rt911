import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import {
	MediaStreamContext,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";

// Stub the playback-heavy children — this suite only asserts the schedule
// (Coming Up / Previous) chrome around them.
vi.mock("./StationPlayer", () => ({
	StationPlayer: () => <div data-testid="station-player" />,
}));
vi.mock("./NowPlayingList", () => ({
	NowPlayingList: () => <div data-testid="now-playing" />,
}));
vi.mock("./FocusedItemPlayer", () => ({
	FocusedItemPlayer: () => <div data-testid="focused-player" />,
}));
vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
}));

const mockAppData = vi.hoisted(
	() => ({ current: {} as Record<string, unknown> }),
);

vi.mock("classicy", () => ({
	ClassicyApp: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	ClassicyButton: ({
		children,
		onClickFunc,
	}: {
		children?: React.ReactNode;
		onClickFunc?: () => void;
	}) => (
		<button type="button" onClick={onClickFunc}>
			{children}
		</button>
	),
	ClassicyIcons: {
		applications: { radio: { app: "radio.png" } },
		controlPanels: { soundManager: { sound33: "sound.png" } },
	},
	quitMenuItemHelper: () => ({}),
	registerAppEventHandler: () => {},
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({
			System: {
				Manager: {
					Applications: {
						apps: {
							"RadioScanner.app": {
								open: true,
								data: mockAppData.current,
							},
						},
					},
				},
			},
		}),
	useAppManagerDispatch: () => () => {},
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:40:00.000Z",
		paused: true,
	}),
}));

import { RadioScanner } from "./RadioScanner";

const NOW = "2001-09-11T12:40:00.000Z";

function item(id: number, source: string, start: string): MediaItem {
	return {
		id,
		title: `${source} clip ${id}`,
		full_title: `${source} clip ${id}`,
		source,
		start_date: start,
		calc_duration: 3600,
		url: `https://example.test/${id}.mp3`,
		format: "mp3",
		approved: 1,
		mute: 0,
		volume: 1,
		jump: 0,
		trim: 0,
	};
}

function renderScanner(activeStation: string): void {
	mockAppData.current = { activeStation };
	const ctx: Partial<MediaStreamContextValue> = {
		mp3Items: [
			item(1, "WINS", "2001-09-11T12:30:00.000Z"),
			item(2, "WCBS", "2001-09-11T12:30:00.000Z"),
			item(3, "ATC", "2001-09-11T12:30:00.000Z"),
		],
		mp3History: [],
		sources: {
			video: [],
			audio: ["WINS", "WCBS", "ATC"],
			pager: [],
			usenet: [],
		},
		subscribeMp3: () => {},
		unsubscribeMp3: () => {},
		// Every station has a pending item, so any Coming Up section that
		// renders would have content — the label's presence is purely the
		// continuous-station gate under test.
		getUpcomingMp3Items: () => [
			item(11, "WINS", "2001-09-11T12:45:00.000Z"),
			item(12, "WCBS", "2001-09-11T12:45:00.000Z"),
			item(13, "ATC", "2001-09-11T12:45:00.000Z"),
		],
	};
	render(
		<MediaStreamContext.Provider value={ctx as MediaStreamContextValue}>
			<RadioScanner />
		</MediaStreamContext.Provider>,
	);
}

describe("RadioScanner schedule visibility", () => {
	afterEach(cleanup);

	it(`shows Coming Up for a scheduled station (now=${NOW})`, () => {
		renderScanner("ATC");
		expect(screen.getByText("Coming Up")).toBeTruthy();
	});

	it("hides Coming Up on WINS (continuous broadcast)", () => {
		renderScanner("WINS");
		expect(screen.queryByText("Coming Up")).toBeNull();
	});

	it("hides Coming Up on WCBS (continuous broadcast)", () => {
		renderScanner("WCBS");
		expect(screen.queryByText("Coming Up")).toBeNull();
	});
});
