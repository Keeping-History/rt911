import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Transcript panel is the only one that reaches classicy; stub the parser
// so this suite is about the card, not about fetching a VTT. The stub echoes
// the second it was asked about, which is what lets a test below see which
// position the card handed the panel.
vi.mock("classicy", () => ({
	useQuickTimeSubtitles: () => ({ activeCueText: (seconds: number) => `cue@${seconds}` }),
	registerApp: () => {},
}));

// The <audio> elements live in the coordinator, not in the card, and Step 16
// deliberately made positionMs answer for items that are not rendered. Stubbing
// it is how this suite pins what the card DOES with that number.
const audio = vi.hoisted(() => ({ positionMs: undefined as number | undefined }));
vi.mock("./audioCoordinator", () => ({
	positionMs: () => audio.positionMs,
	subscribe: () => () => {},
}));

import type { ItemMeta, MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import type { Lane } from "./cardStatus";
import { CARD_TABS } from "./CardTabBar";
import { makeItem, makeMeta } from "./tabs/cardTabFixtures";
import { TrafficCard } from "./TrafficCard";

afterEach(cleanup);

/** The fixture clip runs 12:46:31 → 12:49:44 UTC: 193 seconds. */
const START_MS = Date.parse("2001-09-11T12:46:31Z");
const DURATION_MS = 193_000;

function renderCard(
	props: {
		item?: MediaItem;
		meta?: ItemMeta;
		lane?: Lane;
		nowMs?: number;
		seeking?: boolean;
		userPlaying?: boolean;
		muted?: boolean;
		paused?: boolean;
		onTogglePause?: () => void;
	} = {},
) {
	return render(
		<TrafficCard
			item={props.item ?? makeItem()}
			meta={props.meta}
			lane={props.lane ?? "live"}
			tzOffsetHours={-4}
			nowMs={props.nowMs ?? START_MS}
			seeking={props.seeking}
			userPlaying={props.userPlaying}
			muted={props.muted}
			paused={props.paused}
			onTogglePause={props.onTogglePause ?? (() => {})}
		/>,
	);
}

function headerText(container: HTMLElement): string {
	return container.querySelector("[data-card-title]")?.textContent ?? "";
}

function badgeText(container: HTMLElement): string | null {
	return container.querySelector("[data-badge]")?.textContent ?? null;
}

beforeEach(() => {
	audio.positionMs = undefined;
	// PeaksWaveform's effect calls getContext on the way to bailing out (jsdom
	// lays nothing out, so there is no width to draw into), and jsdom's
	// unimplemented one writes a "Not implemented" line to stderr every time.
	// Same stub PeaksWaveform.test.tsx uses to keep its own output clean.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		{ fillStyle: "", clearRect: () => {}, fillRect: () => {} } as unknown as CanvasRenderingContext2D,
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TrafficCard header", () => {
	it("shows the subject when the item has metadata", () => {
		const { container } = renderCard({ meta: makeMeta() });
		expect(headerText(container)).toBe(makeMeta().subject);
	});

	it("falls back to full_title for an item with no metadata", () => {
		// 59 of the 814 mp3 items are absent from the mp3_meta frame entirely.
		// They are not an error state — they are 7% of the corpus.
		const { container } = renderCard({ meta: undefined });
		expect(headerText(container)).toBe(makeItem().full_title);
	});

	it("falls back to full_title when the subject is present but blank", () => {
		const { container } = renderCard({ meta: makeMeta({ subject: "   " }) });
		expect(headerText(container)).toBe(makeItem().full_title);
	});
});

describe("TrafficCard badge", () => {
	it("counts down on an UPCOMING card", () => {
		const { container } = renderCard({ lane: "upcoming", nowMs: START_MS - 4_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("countdown");
		expect(badgeText(container)).toBe("4s");
	});

	it("reads in sync on a LIVE card whose audio is where the clock says", () => {
		audio.positionMs = 60_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("in-sync");
	});

	it("reports signed drift on a LIVE card whose audio lags", () => {
		audio.positionMs = 54_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000 });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("drift");
		expect(badgeText(container)).toBe("-6s");
	});

	it("shows SEEKING on a LIVE card mid-seek, in place of the drift noise", () => {
		audio.positionMs = 0;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 60_000, seeking: true });
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("seeking");
	});

	it("shows no badge at all on an idle PREVIOUS card", () => {
		// badgeFor returns null here on purpose: every variant would assert
		// something untrue about a clip that is neither playing nor tracking.
		const { container } = renderCard({ lane: "previous", nowMs: START_MS + DURATION_MS + 5_000 });
		expect(container.querySelector("[data-badge]")).toBeNull();
	});

	it("shows PLAYING on a PREVIOUS card the listener started", () => {
		const { container } = renderCard({
			lane: "previous",
			nowMs: START_MS + DURATION_MS + 5_000,
			userPlaying: true,
		});
		expect(container.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("playing");
	});
});

describe("TrafficCard waveform", () => {
	it("passes the scrubbers 0..1 fractions, not percentages", () => {
		// The load-bearing units bug: PeaksWaveform clamps to 0..1, so a 0..100
		// percentage parks both markers hard against the right edge and the card
		// silently stops reporting position at all.
		audio.positionMs = DURATION_MS / 4;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + DURATION_MS / 2 });
		expect(container.querySelector('[data-scrubber="live"]')?.getAttribute("data-pct")).toBe("0.5");
		expect(container.querySelector('[data-scrubber="current"]')?.getAttribute("data-pct")).toBe(
			"0.25",
		);
	});

	it("puts both scrubbers inside the waveform slot", () => {
		// PeaksWaveform renders a bare fragment and positions its scrubbers
		// absolutely, so the containing block is the card's job. If the slot is
		// not their offset parent the markers land against the card frame and
		// report the wrong instant.
		audio.positionMs = 1_000;
		const { container } = renderCard({ lane: "live", nowMs: START_MS + 1_000 });
		const slot = container.querySelector("[data-card-waveform]");
		expect(slot?.querySelector('[data-scrubber="live"]')).not.toBeNull();
		expect(slot?.querySelector('[data-scrubber="current"]')).not.toBeNull();
		expect(slot?.querySelector("canvas")).not.toBeNull();
	});

	it("draws no live marker on an UPCOMING card", () => {
		// Nothing has played yet, and a marker pinned at 0 would claim otherwise.
		const { container } = renderCard({ lane: "upcoming", nowMs: START_MS - 30_000 });
		expect(container.querySelector('[data-scrubber="live"]')).toBeNull();
	});
});

describe("TrafficCard tabs", () => {
	it("exposes five tabs and opens Details first", () => {
		const { getAllByRole, container } = renderCard({ meta: makeMeta() });
		expect(getAllByRole("tab")).toHaveLength(5);
		expect(container.querySelector('[data-tab="details"]')).not.toBeNull();
	});

	it("swaps the panel when another tab is picked", () => {
		const { getByRole, container } = renderCard({ meta: makeMeta() });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		expect(container.querySelector('[data-tab="transcript"]')).not.toBeNull();
		expect(container.querySelector('[data-tab="details"]')).toBeNull();
	});

	it("hands the transcript panel the element's own position", () => {
		// The cue shown must follow the <audio> element, not the virtual clock:
		// a drifting card would otherwise caption words it is not saying.
		audio.positionMs = 42_000;
		const { getByRole, container } = renderCard({ meta: makeMeta() });
		fireEvent.click(getByRole("tab", { name: "Transcript" }));
		expect(container.querySelector('[data-tab="transcript"]')?.textContent).toContain("cue@42");
	});
});

describe("TrafficCard control bar", () => {
	it("toggles the pause button", () => {
		const onTogglePause = vi.fn();
		const { getByRole, rerender } = renderCard({ paused: false, onTogglePause });
		fireEvent.click(getByRole("button", { name: "Pause" }));
		expect(onTogglePause).toHaveBeenCalledTimes(1);

		rerender(
			<TrafficCard
				item={makeItem()}
				lane="live"
				tzOffsetHours={-4}
				nowMs={START_MS}
				paused
				onTogglePause={onTogglePause}
			/>,
		);
		fireEvent.click(getByRole("button", { name: "Play" }));
		expect(onTogglePause).toHaveBeenCalledTimes(2);
	});

	it("reports whether the card is in the mix", () => {
		const audible = renderCard({ muted: false });
		expect(
			audible.container.querySelector("[data-muted]")?.getAttribute("data-muted"),
		).toBe("false");
		cleanup();
		const silent = renderCard({ muted: true });
		expect(silent.container.querySelector("[data-muted]")?.getAttribute("data-muted")).toBe("true");
	});
});

describe("TrafficCard, for an item with no metadata", () => {
	it("renders as a real card on every tab", () => {
		const { container, getByRole } = renderCard({ meta: undefined });
		expect(container.querySelector("[data-lane]")).not.toBeNull();
		for (const tab of CARD_TABS) {
			fireEvent.click(getByRole("tab", { name: tab.label }));
			// Not merely "did not throw": a card whose panel paints an empty box
			// is a dead tab, and 7% of the corpus lands here.
			const panel = container.querySelector(`[data-tab="${tab.id}"]`);
			expect(panel?.textContent?.trim().length).toBeGreaterThan(0);
		}
	});

	it("still marks the lane it sits in", () => {
		const { container } = renderCard({ meta: undefined, lane: "previous" });
		expect(container.querySelector("[data-lane]")?.getAttribute("data-lane")).toBe("previous");
	});
});
