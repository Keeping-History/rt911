import { cleanup, render, screen } from "@testing-library/react";
import { ClassicyIcons } from "classicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../TV/epgIcons"; // side effect: registers ClassicyIcons.applications.epg
import type { EpgIconNamespace } from "../TV/epgIcons";
import { MediaTvRow, stationLogo, type TvEditorEntry } from "./MediaTvRow";

afterEach(cleanup);

// The registered namespace is the single source — the same address every
// consumer reads. Cast because classicy no longer declares `epg` in its types;
// the key exists at runtime only because epgIcons.ts registers it.
const epg = () => (ClassicyIcons.applications as unknown as { epg: EpgIconNamespace }).epg;

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

	it("registers the full EPG set at the ClassicyIcons address", () => {
		const { channels } = epg();
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
		expect(cards[0].className).not.toContain("playlistMediaCardSelected");
		expect(cards[1].className).toContain("playlistMediaCardSelected");
	});
});
