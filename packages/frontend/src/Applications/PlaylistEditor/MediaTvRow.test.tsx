import { cleanup, render, screen } from "@testing-library/react";
import { ClassicyIcons } from "classicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_LOGOS, EPG_ICONS } from "../TV/epgIcons";
import { MediaTvRow, stationLogo, type TvEditorEntry } from "./MediaTvRow";

afterEach(cleanup);

const tvEntry = (uid: string, itemId: string): TvEditorEntry => ({
	uid,
	entry: { kind: "media", app: "tv", itemId },
});

describe("stationLogo", () => {
	it("maps a channel slug (case-insensitively) to its repo-owned logo", () => {
		expect(stationLogo("CNN")).toBe(CHANNEL_LOGOS.cnn);
		expect(stationLogo("cnn")).toBe(CHANNEL_LOGOS.cnn);
		expect(CHANNEL_LOGOS.cnn).toBeTruthy();
	});

	it("re-injects the logos at their old ClassicyIcons address", () => {
		// TV/epgIcons.ts registers into the shared registry so generic
		// consumers keep finding them where classicy used to bundle them.
		// Reached via an index cast: classicy no longer declares `epg` in its
		// types — the key exists at runtime only because epgIcons.ts registers it.
		const epg = (ClassicyIcons.applications as Record<string, unknown>).epg as Record<
			string,
			string | Record<string, string>
		>;
		const channels = epg.channels as Record<string, string>;
		expect(channels.cnn).toBe(CHANNEL_LOGOS.cnn);
		expect(Object.keys(channels)).toHaveLength(25);
		expect(epg.cc).toBe(EPG_ICONS.cc);
	});

	it("falls back to the generic TV glyph for a channel with no logo", () => {
		expect(stationLogo("no-such-channel")).toBe(EPG_ICONS.tv);
	});
});

describe("MediaTvRow", () => {
	it("renders one card per entry with logo and slug label", () => {
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn"), tvEntry("e2", "bbc")]}
				selectedUid={null}
				onEdit={vi.fn()}
				onRemove={vi.fn()}
			/>,
		);
		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		expect(screen.getByText("CNN")).not.toBeNull();
		expect(screen.getByText("BBC")).not.toBeNull();
		// The logo img is decorative (empty alt); the slug text carries the name.
		expect(cards[0].querySelector("img.playlistMediaTvLogo")).not.toBeNull();
	});

	it("edit button reports the entry's uid", () => {
		const onEdit = vi.fn();
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn")]}
				selectedUid={null}
				onEdit={onEdit}
				onRemove={vi.fn()}
			/>,
		);
		screen.getByRole("button", { name: "Edit CNN" }).click();
		expect(onEdit).toHaveBeenCalledWith("e1");
	});

	it("remove button reports the entry's uid", () => {
		const onRemove = vi.fn();
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn")]}
				selectedUid={null}
				onEdit={vi.fn()}
				onRemove={onRemove}
			/>,
		);
		screen.getByRole("button", { name: "Remove CNN" }).click();
		expect(onRemove).toHaveBeenCalledWith("e1");
	});

	it("highlights only the selected entry's card", () => {
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn"), tvEntry("e2", "bbc")]}
				selectedUid="e2"
				onEdit={vi.fn()}
				onRemove={vi.fn()}
			/>,
		);
		const cards = screen.getAllByRole("listitem");
		expect(cards[0].className).not.toContain("playlistMediaTvCardSelected");
		expect(cards[1].className).toContain("playlistMediaTvCardSelected");
	});
});
