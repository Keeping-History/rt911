import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MediaStreamContext,
	type MediaItem,
	type MediaStreamContextValue,
} from "../../Providers/MediaStream/MediaStreamContext";

// News.tsx needs a live ClassicyAppManagerProvider tree to render ClassicyApp/
// ClassicyWindow for real (same constraint documented in Account.test.tsx and
// Weather.test.tsx), so those two are stubbed as plain wrapper divs. Everything
// else (ClassicyButton, ClassicyPopUpMenu, ClassicyIcons, quitMenuItemHelper)
// renders for real via importOriginal.
const dispatchMock = vi.hoisted(() => vi.fn());
const mockState = vi.hoisted(() => ({
	value: {
		System: {
			Manager: {
				DateAndTime: { dateTime: "2001-09-11T12:40:00.000Z", timeZoneOffset: "-4" },
				Applications: {
					apps: {
						"News.app": { open: true, windows: [] as unknown[], data: {} },
					},
				},
				Appearance: {
					activeTheme: { measurements: { window: { paddingSize: 8 } } },
				},
			},
		},
	},
}));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	useAppManager: (selector: (s: unknown) => unknown) => selector(mockState.value),
	useAppManagerDispatch: () => dispatchMock,
}));

vi.mock("../../openreplay", () => ({ trackAppToggle: () => {} }));

import { News } from "./News";

// Two days before the mocked dateTime — comfortably clears the
// tzOffset-adjusted "has this article aired yet" filter regardless of the
// test runner's local timezone, so entries always land in the visible list.
const PAST = "2001-09-09T08:00:00";

function makeItem(over: Partial<MediaItem> & { id: number; title: string }): MediaItem {
	return {
		full_title: over.title,
		start_date: PAST,
		url: "",
		format: "news",
		approved: 1,
		mute: 0,
		volume: 100,
		jump: 0,
		trim: 0,
		content: "",
		...over,
	};
}

function makeCtxValue(
	overrides: Partial<MediaStreamContextValue>,
): MediaStreamContextValue {
	return {
		items: [],
		pagerItems: [],
		mp3Items: [],
		mp3History: [],
		newsItems: [],
		alertItems: [],
		subscribeAlerts: () => {},
		unsubscribeAlerts: () => {},
		usenetItems: [],
		usenetBodies: {},
		usenetBodyErrors: {},
		requestUsenetBody: () => {},
		newsBodies: {},
		newsBodyErrors: {},
		requestNewsBody: () => {},
		sources: { video: [], audio: [], pager: [], usenet: [] },
		connected: false,
		addItems: () => {},
		subscribeFormats: () => {},
		unsubscribeFormats: () => {},
		subscribePager: () => {},
		unsubscribePager: () => {},
		subscribeMp3: () => {},
		unsubscribeMp3: () => {},
		getUpcomingMp3Items: () => [],
		subscribeNews: () => {},
		unsubscribeNews: () => {},
		subscribeUsenet: () => {},
		unsubscribeUsenet: () => {},
		setUsenetGroups: () => {},
		requestUsenetOlder: () => {},
		flightPositions: [],
		subscribeFlights: () => {},
		unsubscribeFlights: () => {},
		subscribeFlightsAnon: () => {},
		unsubscribeFlightsAnon: () => {},
		flightsHistory: [],
		flightsHistoryDone: false,
		flightsSeed: [],
		requestFlightsHistory: () => {},
		clearFlightsHistory: () => {},
		weatherObservations: {},
		weatherForecastByZone: {},
		subscribeWeather: () => {},
		unsubscribeWeather: () => {},
		requestWeatherForecast: () => {},
		clockForced: false,
		roomCommand: null,
		chatBuddies: [],
		chatEnabled: false,
		chatReason: "not_signed_in",
		chatMessages: [],
		chatTypingProfile: null,
		subscribeChat: () => {},
		unsubscribeChat: () => {},
		sendChat: () => {},
		requestChatHistory: () => {},
		appendLocalChatMessage: () => {},
		clearChatData: () => {},
		...overrides,
	};
}

function renderWithContext(overrides: Partial<MediaStreamContextValue> = {}) {
	return render(
		<MediaStreamContext.Provider value={makeCtxValue(overrides)}>
			<News />
		</MediaStreamContext.Provider>,
	);
}

/** Opens a document's detail window by clicking its title button in the list. */
function openDoc(title: string) {
	fireEvent.click(screen.getByRole("button", { name: title }));
}

describe("News detail window body rendering", () => {
	afterEach(() => {
		cleanup();
		dispatchMock.mockClear();
		mockState.value.System.Manager.Applications.apps["News.app"] = {
			open: true,
			windows: [],
			data: {},
		};
	});

	it("a live-arriving article (truthy content, id absent from newsBodies) renders instantly with no loading flash", () => {
		const item = makeItem({ id: 1, title: "Plane hits tower", content: "<p>Breaking.</p>" });
		renderWithContext({ newsItems: [item] });
		openDoc("Plane hits tower");
		expect(screen.getByText("Breaking.")).toBeTruthy();
		expect(screen.queryByText("Loading…")).toBeNull();
	});

	it("a backlog article awaiting fetch (content: \"\", id absent from newsBodies) shows Loading…", () => {
		const item = makeItem({ id: 2, title: "Backlog headline", content: "" });
		renderWithContext({ newsItems: [item] });
		openDoc("Backlog headline");
		expect(screen.getByText("Loading…")).toBeTruthy();
	});

	it("a failed fetch (id present in newsBodyErrors) renders the error, not Loading…", () => {
		const item = makeItem({ id: 3, title: "Unapproved article", content: "" });
		renderWithContext({
			newsItems: [item],
			newsBodyErrors: { 3: "Article not available." },
		});
		openDoc("Unapproved article");
		expect(screen.getByText("Article not available.")).toBeTruthy();
		expect(screen.queryByText("Loading…")).toBeNull();
	});

	it("a legitimately empty fetched body (id present in newsBodies with value \"\") shows no Loading…", () => {
		const item = makeItem({ id: 4, title: "Empty body article", content: "" });
		renderWithContext({
			newsItems: [item],
			newsBodies: { 4: "" },
		});
		openDoc("Empty body article");
		expect(screen.queryByText("Loading…")).toBeNull();
	});

	it("opening a document requests its body", () => {
		const requestNewsBody = vi.fn();
		const item = makeItem({ id: 5, title: "Requestable article", content: "" });
		renderWithContext({ newsItems: [item], requestNewsBody });
		openDoc("Requestable article");
		expect(requestNewsBody).toHaveBeenCalledWith(5);
	});

	// Regression coverage for the future-article-reappears-after-rewind bug:
	// a detail window is opened while its item is in newsItems, then a backward
	// seek (simulated here by re-rendering with the item removed from
	// newsItems) evicts it from the catalogue while a stale body sits in the
	// newsBodies cache. The server applies no time gating to news_body, so
	// that cache entry is exactly the future article text that must never
	// come back on screen.
	it("a document evicted from newsItems by a backward seek does not render its cached body", () => {
		const item = makeItem({ id: 6, title: "Future article", content: "" });
		const { rerender } = renderWithContext({
			newsItems: [item],
			newsBodies: { 6: "Body fetched before the rewind." },
		});
		openDoc("Future article");
		expect(screen.getByText("Body fetched before the rewind.")).toBeTruthy();

		rerender(
			<MediaStreamContext.Provider
				value={makeCtxValue({
					newsItems: [],
					newsBodies: { 6: "Body fetched before the rewind." },
				})}
			>
				<News />
			</MediaStreamContext.Provider>,
		);

		expect(screen.queryByText("Body fetched before the rewind.")).toBeNull();
	});

	it("a document evicted from newsItems by a backward seek does not trigger requestNewsBody", () => {
		const requestNewsBody = vi.fn();
		const item = makeItem({ id: 7, title: "Another future article", content: "" });
		const { rerender } = renderWithContext({ newsItems: [item], requestNewsBody });
		openDoc("Another future article");
		requestNewsBody.mockClear();

		rerender(
			<MediaStreamContext.Provider
				value={makeCtxValue({ newsItems: [], requestNewsBody })}
			>
				<News />
			</MediaStreamContext.Provider>,
		);

		expect(requestNewsBody).not.toHaveBeenCalled();
	});
});
