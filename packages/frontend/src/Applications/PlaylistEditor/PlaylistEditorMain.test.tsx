import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorState } from "./editorState";
import { PlaylistEditorMain } from "./PlaylistEditorMain";

afterEach(cleanup);

// Entries are grouped under Classicy tabs; inactive panels render `hidden`, so
// their controls are out of the accessibility tree until the tab is selected.
// ClassicyTabs commits the active tab on mouseUp (not click).
const selectTab = (name: string) => fireEvent.mouseUp(screen.getByRole("tab", { name }));

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

// Zoom is owned by the document window and only passed through here, so these
// tests pin it at 1x rather than exercising it — PlaylistTimeline.test.tsx owns
// the zoom behaviour.
const zoomProps = { zoom: 1, onZoomChange: vi.fn() };

describe("PlaylistEditorMain", () => {
	// The header and add bar moved to the menu bar and the Tools palette; the
	// body must not reintroduce chrome above the timeline and entry tabs.
	it("renders no title field, mode radios, status picker, or Add buttons", () => {
		render(<PlaylistEditorMain state={state()} edit={vi.fn()} {...zoomProps} />);

		expect(screen.queryByLabelText("Title")).toBeNull();
		expect(screen.queryByLabelText("Status")).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("renders one tab per entry kind and lists entries under their kind's tab", () => {
		render(
			<PlaylistEditorMain
				state={state({
					entries: [{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } }],
				})}
				edit={vi.fn()}
				{...zoomProps}
			/>,
		);

		expect(screen.getAllByRole("tab").map((t) => t.textContent))
			.toEqual(["Media", "Apps", "Settings", "Files", "Jumps", "Browser"]);

		selectTab("Browser");
		expect(screen.getByText(/example\.com/)).not.toBeNull();
	});

	it("splits the Media tab into per-app disclosure sections with empty hints", () => {
		render(<PlaylistEditorMain state={state()} edit={vi.fn()} {...zoomProps} />);
		// Media is the initially active tab; each media app gets its own
		// disclosure, open by default, with a per-section hint when empty.
		for (const label of ["TV Channels", "Radio Stations", "Radio Traffic", "News", "Flights"]) {
			expect(
				screen.getByRole("button", { name: new RegExp(label) }).getAttribute("aria-expanded"),
			).toBe("true");
		}
		expect(screen.getByText(/No TV channels yet/i)).not.toBeNull();
		expect(screen.getByText(/No radio stations yet/i)).not.toBeNull();
		expect(screen.getByText(/No radio traffic yet/i)).not.toBeNull();
	});

	it("renders TV media entries as logo cards and radio entries as tree rows", () => {
		const edit = vi.fn();
		const openSettings = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({
					entries: [
						{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "cnn" } },
						{ uid: "e2", entry: { kind: "media", app: "radio", itemId: "wnyc" } },
						{ uid: "e3", entry: { kind: "media", app: "radio", itemId: "WINS" } },
					],
				})}
				edit={edit}
				openSettings={openSettings}
				{...zoomProps}
			/>,
		);

		// TV: a card in the side-scrolling row with pencil/trash buttons.
		expect(screen.getByRole("list", { name: "TV channels" })).not.toBeNull();
		screen.getByRole("button", { name: "Edit CNN" }).click();
		expect(edit).toHaveBeenCalledWith("p1", { type: "select", uid: "e1" });
		expect(openSettings).toHaveBeenCalled();
		screen.getByRole("button", { name: "Remove CNN" }).click();
		expect(edit).toHaveBeenCalledWith("p1", { type: "removeEntry", uid: "e1" });

		// Radio: still the tree-row treatment for now — and split by station
		// kind: WINS (a BROADCAST_STATIONS member) sits under Radio Stations,
		// wnyc (traffic) under Radio Traffic.
		expect(screen.getByText(/RADIO · wnyc/)).not.toBeNull();
		expect(screen.getByText(/RADIO · WINS/)).not.toBeNull();
		const stationsSection = screen
			.getByRole("button", { name: /Radio Stations/ })
			.closest(".classicyDisclosure");
		expect(stationsSection?.textContent).toContain("WINS");
		expect(stationsSection?.textContent).not.toContain("wnyc");
	});

	it("routes an entry removal through the injected dispatcher", async () => {
		const edit = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({ entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }] })}
				edit={edit}
				{...zoomProps}
			/>,
		);

		selectTab("Jumps");
		screen.getByRole("button", { name: "Remove" }).click();

		expect(edit).toHaveBeenCalledWith("p1", { type: "removeEntry", uid: "e1" });
	});

	it("Edit selects the entry and reveals the Settings window", () => {
		const edit = vi.fn();
		const openSettings = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({
					entries: [{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } }],
				})}
				edit={edit}
				{...zoomProps}
				openSettings={openSettings}
			/>,
		);

		selectTab("Browser");
		screen.getByRole("button", { name: "Edit" }).click();

		expect(edit).toHaveBeenCalledWith("p1", { type: "select", uid: "e1" });
		expect(openSettings).toHaveBeenCalled();
	});

	// Entry editing moved to the shared Settings utility window
	// (SettingsWindow.tsx); the document body must not render a second form
	// for the selection.
	it("renders no inline EntryForm even when an entry is selected", () => {
		const entries: EditorState["entries"] = [
			{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } },
		];

		render(<PlaylistEditorMain state={state({ entries, selectedUid: "e1" })} edit={vi.fn()} {...zoomProps} />);
		expect(screen.queryByLabelText("URL")).toBeNull();
	});
});
