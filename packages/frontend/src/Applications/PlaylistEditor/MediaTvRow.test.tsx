import { cleanup, render, screen } from "@testing-library/react";
import { resolveClassicyAsset } from "@classicy/classicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { epgIcons } from "../TV/epgIcons";
import { MediaTvRow, stationLogo, type TvEditorEntry } from "./MediaTvRow";

afterEach(cleanup);

// epgIcons is the single source every consumer reads.
const epg = () => epgIcons;

const tvEntry = (uid: string, itemId: string): TvEditorEntry => ({
	uid,
	entry: { kind: "media", app: "tv", itemId },
});

describe("stationLogo", () => {
	it("maps a channel slug (case-insensitively) to its registered logo", () => {
		expect(stationLogo("CNN")).toBe(epg().channels.cnn);
		expect(stationLogo("cnn")).toBe(epg().channels.cnn);
		expect(epg().channels.cnn).toBeTruthy();
	});

	it("registers the full EPG set in Classicy's icon registry", () => {
		const { channels } = epg();
		// The exported namespace is the one registered at applications.epg.
		expect(resolveClassicyAsset("icons", "applications.epg.channels.cnn")).toBe(channels.cnn);
		// 25 stations + the cctv3 alias for the CCTV-4 artwork.
		expect(Object.keys(channels)).toHaveLength(26);
		expect(channels.cctv3).toBe(channels.cctv4);
		// Annotation badges (guide `icons[]` keys) live on the flat namespace.
		expect(epg().cc).toBeTruthy();
		expect(epg().mpaaG).toBeTruthy();
	});

	it("falls back to the generic TV glyph for a channel with no logo", () => {
		expect(stationLogo("no-such-channel")).toBe(epg().tv);
	});
});

describe("MediaTvRow", () => {
	it("renders one card per entry with logo and slug label", () => {
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn"), tvEntry("e2", "bbc")]}
				selectedUid={null}
				onSelect={vi.fn()}
				onEdit={vi.fn()}
				onRemove={vi.fn()}
			/>,
		);
		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		expect(screen.getByText("CNN")).not.toBeNull();
		expect(screen.getByText("BBC")).not.toBeNull();
		// The logo img is decorative (empty alt); the slug text carries the name.
		expect(cards[0].querySelector("img.playlistMediaCardLogo")).not.toBeNull();
	});

	it("edit button reports the entry's uid", () => {
		const onEdit = vi.fn();
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn")]}
				selectedUid={null}
				onSelect={vi.fn()}
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
				onSelect={vi.fn()}
				onEdit={vi.fn()}
				onRemove={onRemove}
			/>,
		);
		screen.getByRole("button", { name: "Remove CNN" }).click();
		expect(onRemove).toHaveBeenCalledWith("e1");
	});

	it("clicking the card reports the entry's uid via onSelect", () => {
		const onSelect = vi.fn();
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn")]}
				selectedUid={null}
				onSelect={onSelect}
				onEdit={vi.fn()}
				onRemove={vi.fn()}
			/>,
		);
		screen.getByRole("listitem").click();
		expect(onSelect).toHaveBeenCalledWith("e1");
	});

	it("highlights only the selected entry's card", () => {
		render(
			<MediaTvRow
				entries={[tvEntry("e1", "cnn"), tvEntry("e2", "bbc")]}
				selectedUid="e2"
				onSelect={vi.fn()}
				onEdit={vi.fn()}
				onRemove={vi.fn()}
			/>,
		);
		const cards = screen.getAllByRole("listitem");
		expect(cards[0].className).not.toContain("playlistMediaCardSelected");
		expect(cards[1].className).toContain("playlistMediaCardSelected");
	});
});
