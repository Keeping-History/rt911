import { cleanup, render, screen } from "@testing-library/react";
import { ClassicyIcons } from "classicy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaRadioRow, type RadioEditorEntry } from "./MediaRadioRow";

afterEach(cleanup);

// The slug → artwork map is a Directus read; stub the hook so the suite never
// touches the network and can drive the map directly.
const mockStationLogos = vi.hoisted(
	() => ({ current: {} as Record<string, string> }),
);
vi.mock("../radio-core/stationLogos", () => ({
	useStationLogos: () => mockStationLogos.current,
}));

afterEach(() => {
	mockStationLogos.current = {};
});

const radioEntry = (uid: string, itemId: string): RadioEditorEntry => ({
	uid,
	entry: { kind: "media", app: "radio", itemId },
});

const row = (entries: RadioEditorEntry[], props: Partial<{
	selectedUid: string | null;
	onSelect: (uid: string) => void;
	onEdit: (uid: string) => void;
	onRemove: (uid: string) => void;
}> = {}) =>
	render(
		<MediaRadioRow
			entries={entries}
			selectedUid={props.selectedUid ?? null}
			onSelect={props.onSelect ?? vi.fn()}
			onEdit={props.onEdit ?? vi.fn()}
			onRemove={props.onRemove ?? vi.fn()}
		/>,
	);

const WINS_LOGO = "https://files.911realtime.org/images/radio/wins.png";

describe("MediaRadioRow", () => {
	it("renders one card per entry with the station's artwork and call sign", () => {
		mockStationLogos.current = { WINS: WINS_LOGO };
		row([radioEntry("e1", "WINS"), radioEntry("e2", "WCBS")]);

		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		expect(screen.getByText("WINS")).not.toBeNull();
		expect(screen.getByText("WCBS")).not.toBeNull();
		// The logo img is decorative (empty alt); the call sign carries the name.
		const logo = cards[0].querySelector("img.playlistMediaCardLogo");
		expect(logo?.getAttribute("src")).toBe(WINS_LOGO);
	});

	// The entry's itemId is the streamer's source name; the map is keyed by the
	// Directus source slug, and the two disagree on case for some stations.
	it("matches the artwork map case-insensitively", () => {
		mockStationLogos.current = { wins: WINS_LOGO };
		row([radioEntry("e1", "WINS")]);
		expect(
			screen
				.getAllByRole("listitem")[0]
				.querySelector("img.playlistMediaCardLogo")
				?.getAttribute("src"),
		).toBe(WINS_LOGO);
	});

	// The map is {} until the Directus read resolves (and stays {} if it fails),
	// so a card must still identify its station.
	it("falls back to the generic radio glyph when the map has no artwork", () => {
		row([radioEntry("e1", "WTOP")]);
		const logo = screen
			.getAllByRole("listitem")[0]
			.querySelector("img.playlistMediaCardLogo");
		expect(logo?.getAttribute("src")).toBe(
			ClassicyIcons.applications.radio.app,
		);
		expect(screen.getByText("WTOP")).not.toBeNull();
	});

	it("edit button reports the entry's uid", () => {
		const onEdit = vi.fn();
		row([radioEntry("e1", "WINS")], { onEdit });
		screen.getByRole("button", { name: "Edit WINS" }).click();
		expect(onEdit).toHaveBeenCalledWith("e1");
	});

	it("remove button reports the entry's uid", () => {
		const onRemove = vi.fn();
		row([radioEntry("e1", "WINS")], { onRemove });
		screen.getByRole("button", { name: "Remove WINS" }).click();
		expect(onRemove).toHaveBeenCalledWith("e1");
	});

	it("clicking the card reports the entry's uid via onSelect", () => {
		const onSelect = vi.fn();
		row([radioEntry("e1", "WINS")], { onSelect });
		screen.getByRole("listitem").click();
		expect(onSelect).toHaveBeenCalledWith("e1");
	});

	it("highlights only the selected entry's card", () => {
		row([radioEntry("e1", "WINS"), radioEntry("e2", "WCBS")], {
			selectedUid: "e2",
		});
		const cards = screen.getAllByRole("listitem");
		expect(cards[0].className).not.toContain("playlistMediaCardSelected");
		expect(cards[1].className).toContain("playlistMediaCardSelected");
	});
});
