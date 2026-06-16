import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import type { PagerItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { PagerDecoderSettings } from "./PagerDecoderContext";
import { DEFAULT_PAGER_SETTINGS } from "./PagerDecoderContext";
import { usePagerPlayback } from "./usePagerPlayback";

vi.mock("classicy", () => ({
	registerAppEventHandler: vi.fn(),
}));

let idSeq = 1;

function makePagerItem(
	message: string,
	utcTimestamp = "2001-09-11T07:00:00.000Z",
	provider = "Metrocall",
	overrides: Partial<PagerItem> = {},
): PagerItem {
	return {
		id:           idSeq++,
		start_date:   utcTimestamp,
		provider,
		recipient_id: "0001234",
		id_type:      "capcode",
		channel:      "B",
		mode:         "ALPHA",
		message,
		approved:     1,
		...overrides,
	};
}

function makeSettings(overrides: Partial<PagerDecoderSettings> = {}): PagerDecoderSettings {
	return { ...DEFAULT_PAGER_SETTINGS, ...overrides };
}

/** Build a context wrapper that provides the given pager items. */
function makeWrapper(pagerItems: PagerItem[]) {
	const subscribePager   = vi.fn();
	const unsubscribePager = vi.fn();
	return {
		wrapper: ({ children }: { children: React.ReactNode }) =>
			createElement(MediaStreamContext.Provider, {
				value: {
					items: [],
					pagerItems,
					mp3Items: [],
					connected: true,
					addItems: vi.fn(),
					subscribeFormats: vi.fn(),
					unsubscribeFormats: vi.fn(),
					subscribePager,
					unsubscribePager,
					subscribeMp3: vi.fn(),
					unsubscribeMp3: vi.fn(),
					newsItems: [],
					subscribeNews: vi.fn(),
					unsubscribeNews: vi.fn(),
				},
				children,
			}),
		subscribePager,
		unsubscribePager,
	};
}

describe("usePagerPlayback", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		idSeq = 1;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns empty state with no items", () => {
		const { wrapper } = makeWrapper([]);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });
		expect(result.current.lines).toHaveLength(0);
		expect(result.current.streamingText).toBe("");
		expect(result.current.streamingMeta).toBeNull();
	});

	it("subscribes to the pager channel on mount and unsubscribes on unmount", () => {
		const { wrapper, subscribePager, unsubscribePager } = makeWrapper([]);
		const { unmount } = renderHook(() => usePagerPlayback(), { wrapper });
		expect(subscribePager).toHaveBeenCalledWith("PagerDecoder.app");
		unmount();
		expect(unsubscribePager).toHaveBeenCalledWith("PagerDecoder.app");
	});

	it("enqueues and streams a message when a pager item appears", () => {
		const item = makePagerItem("Hello world foo");
		const { wrapper } = makeWrapper([item]);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });

		act(() => {
			vi.advanceTimersByTime(1); // first stream tick picks up the queued item
		});

		expect(result.current.streamingMeta).not.toBeNull();
		expect(result.current.streamingMeta?.provider).toBe("Metrocall");
		expect(result.current.streamingText).toBe("Hello");
	});

	it("streams message words one at a time", () => {
		const item = makePagerItem("Hello world foo");
		const { wrapper } = makeWrapper([item]);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });

		act(() => { vi.advanceTimersByTime(1); });
		expect(result.current.streamingText).toBe("Hello");

		act(() => { vi.advanceTimersByTime(1); });
		expect(result.current.streamingText).toBe("Hello world");
	});

	it("moves completed line to lines[] and clears streamingMeta", () => {
		const item = makePagerItem("Hi there");
		const { wrapper } = makeWrapper([item]);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });

		act(() => { vi.advanceTimersByTime(2); }); // 2 words → complete

		expect(result.current.lines).toHaveLength(1);
		expect(result.current.lines[0].text).toBe("Hi there");
		expect(result.current.streamingMeta).toBeNull();
		expect(result.current.streamingText).toBe("");
	});

	it("does not process the same item twice when items array updates", () => {
		const item = makePagerItem("Hello");
		const { wrapper } = makeWrapper([item]);
		const { result, rerender } = renderHook(() => usePagerPlayback(), { wrapper });

		act(() => { vi.advanceTimersByTime(5); }); // complete first item

		expect(result.current.lines).toHaveLength(1);

		// Re-render with the same item (simulates context update with same item)
		rerender();
		act(() => { vi.advanceTimersByTime(5); });

		expect(result.current.lines).toHaveLength(1); // no duplicate
	});

	it("respects retentionLines setting", () => {
		const items = Array.from({ length: 4 }, (_, i) => makePagerItem(`Msg${i}`));
		const { wrapper } = makeWrapper(items);
		const settings = makeSettings({ retentionLines: 3 });
		const { result } = renderHook(() => usePagerPlayback(settings), { wrapper });

		act(() => { vi.advanceTimersByTime(4 + 10); });

		expect(result.current.lines.length).toBe(3);
		expect(result.current.lines[0].text).toBe("Msg1");
	});

	it("retentionLines=0 keeps all lines (unlimited)", () => {
		const items = Array.from({ length: 5 }, (_, i) => makePagerItem(`Msg${i}`));
		const { wrapper } = makeWrapper(items);
		const settings = makeSettings({ retentionLines: 0 });
		const { result } = renderHook(() => usePagerPlayback(settings), { wrapper });

		act(() => { vi.advanceTimersByTime(5 + 10); });

		expect(result.current.lines.length).toBe(5);
	});

	it("filters records by provider", () => {
		const r1 = makePagerItem("From Metrocall", "2001-09-11T07:00:00.000Z", "Metrocall");
		const r2 = makePagerItem("From Arch", "2001-09-11T07:00:01.000Z", "Arch");
		const { wrapper } = makeWrapper([r1, r2]);
		const settings = makeSettings({
			filter: { ...DEFAULT_PAGER_SETTINGS.filter, provider: "Arch" },
		});
		const { result } = renderHook(() => usePagerPlayback(settings), { wrapper });

		act(() => { vi.advanceTimersByTime(10); });

		expect(result.current.lines.length).toBe(1);
		expect(result.current.lines[0].text).toBe("From Arch");
	});

	it("does not stream messages when paused", () => {
		const item = makePagerItem("Hello world");
		const { wrapper } = makeWrapper([item]);
		const { result } = renderHook(() => usePagerPlayback(DEFAULT_PAGER_SETTINGS, true), { wrapper });

		act(() => { vi.advanceTimersByTime(2000); });

		expect(result.current.streamingText).toBe("");
		expect(result.current.streamingMeta).toBeNull();
	});

	it("builds unique provider values from seen items", () => {
		const items = [
			makePagerItem("Msg A", "2001-09-11T07:00:00.000Z", "Arch"),
			makePagerItem("Msg B", "2001-09-11T07:00:01.000Z", "Skytel"),
		];
		const { wrapper } = makeWrapper(items);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });

		expect(result.current.uniqueValues.provider).toContain("Arch");
		expect(result.current.uniqueValues.provider).toContain("Skytel");
	});

	it("derives ET time key from UTC start_date", () => {
		// 2001-09-11T07:00:00Z = 03:00:00 EDT
		const item = makePagerItem("Test", "2001-09-11T07:00:00.000Z");
		const { wrapper } = makeWrapper([item]);
		const { result } = renderHook(() => usePagerPlayback(), { wrapper });

		act(() => { vi.advanceTimersByTime(5); }); // complete message

		expect(result.current.lines[0].timeKey).toBe("03:00:00");
	});
});
