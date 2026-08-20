import type { ClassicyMenuItem } from "classicy";
import { describe, expect, it, vi } from "vitest";
import { ADD_ACTIONS } from "./addActions";
import {
	addMenuItems, documentControlMenu, documentEditMenu, documentFileMenu, windowMenu,
} from "./playlistMenus";

vi.mock("./settingsRegistry", () => ({
	listSettingsApps: () => [
		{ appId: "TV.app", name: "TV" },
		{ appId: "Weather.app", name: "Weather" },
	],
}));

const child = (menu: ClassicyMenuItem, id: string): ClassicyMenuItem => {
	const found = menu.menuChildren?.find((c) => c.id === id);
	if (!found) throw new Error(`no item ${id} in ${menu.id}`);
	return found;
};

const noopFile = {
	onOpenList: vi.fn(), onSave: vi.fn(), onRename: vi.fn(), onDuplicate: vi.fn(),
	onDelete: vi.fn(), onSetStatus: vi.fn(), onCopyStudentLink: vi.fn(),
	quitItem: { id: "quit", title: "Quit" },
};

const noopControl = {
	lock: { clock: false, busy: false }, dirty: false, status: "published" as const,
	onToggleClock: vi.fn(), onSyncClock: vi.fn(), onSendMessage: vi.fn(),
	onFocusApp: vi.fn(), onPushUpdate: vi.fn(),
};

describe("documentFileMenu", () => {
	it("disables Save until there is something to save", () => {
		expect(child(documentFileMenu({ ...noopFile, dirty: false, status: "draft" }), "playlist_file_save").disabled).toBe(true);
		expect(child(documentFileMenu({ ...noopFile, dirty: true, status: "draft" }), "playlist_file_save").disabled).toBe(false);
	});

	it("checkmarks the current status inside the Status submenu", () => {
		const status = child(documentFileMenu({ ...noopFile, dirty: false, status: "published" }), "playlist_file_status");
		const draft = status.menuChildren?.find((c) => c.id === "playlist_status_draft");
		const published = status.menuChildren?.find((c) => c.id === "playlist_status_published");

		expect(draft?.checked).toBe(false);
		expect(published?.checked).toBe(true);
	});

	// Drafts aren't joinable (the anonymous student loader refuses them), so
	// the share item is disabled with the reason in its balloon rather than
	// hidden — a teacher looking for it should find it and learn why.
	it("enables Copy Student Link only for a published playlist, explaining why not", () => {
		const published = child(
			documentFileMenu({ ...noopFile, dirty: false, status: "published" }),
			"playlist_file_copy_link",
		);
		expect(published.disabled).toBe(false);
		expect(published.balloon?.content).toContain("join");

		const draft = child(
			documentFileMenu({ ...noopFile, dirty: false, status: "draft" }),
			"playlist_file_copy_link",
		);
		expect(draft.disabled).toBe(true);
		expect(draft.balloon?.content).toContain("Drafts aren't joinable");
	});

	it("Copy Student Link fires its handler", () => {
		const onCopyStudentLink = vi.fn();
		child(
			documentFileMenu({ ...noopFile, onCopyStudentLink, dirty: false, status: "published" }),
			"playlist_file_copy_link",
		).onClickFunc?.();
		expect(onCopyStudentLink).toHaveBeenCalled();
	});
});

describe("documentEditMenu", () => {
	it("checkmarks the active mode and balloons both", () => {
		const menu = documentEditMenu({ mode: "restrict", onSetMode: vi.fn(), addItems: [] });

		expect(child(menu, "playlist_edit_restrict").checked).toBe(true);
		expect(child(menu, "playlist_edit_annotate").checked).toBe(false);
		expect(child(menu, "playlist_edit_restrict").balloon?.content).toBeTruthy();
		expect(child(menu, "playlist_edit_annotate").balloon?.content).toBeTruthy();
	});

	it("separates the modes from Add… with a spacer", () => {
		const menu = documentEditMenu({ mode: "annotate", onSetMode: vi.fn(), addItems: [] });
		const ids = menu.menuChildren?.map((c) => c.id);
		expect(ids).toEqual([
			"playlist_edit_restrict", "playlist_edit_annotate", "spacer", "playlist_edit_add",
		]);
	});
});

describe("documentControlMenu", () => {
	it("checkmarks a locked clock and disables the item while in flight", () => {
		const locked = documentControlMenu({ ...noopControl, lock: { clock: true, busy: false } });
		expect(child(locked, "playlist_control_clock").checked).toBe(true);
		expect(child(locked, "playlist_control_clock").disabled).toBe(false);

		const busy = documentControlMenu({ ...noopControl, lock: { clock: false, busy: true } });
		expect(child(busy, "playlist_control_clock").disabled).toBe(true);
	});

	// Content locking is not built; the item exists so the pair reads as the
	// pair it will become.
	it("always disables Lock Contents and wires no handler", () => {
		const menu = documentControlMenu({ ...noopControl });
		const contents = child(menu, "playlist_control_contents");
		expect(contents.disabled).toBe(true);
		expect(contents.onClickFunc).toBeUndefined();
	});

	it("fires the sync and message handlers, with balloons on both", () => {
		const onSyncClock = vi.fn();
		const onSendMessage = vi.fn();
		const menu = documentControlMenu({ ...noopControl, onSyncClock, onSendMessage });

		expect(child(menu, "playlist_control_sync").balloon?.content).toBeTruthy();
		child(menu, "playlist_control_sync").onClickFunc?.();
		expect(onSyncClock).toHaveBeenCalled();

		expect(child(menu, "playlist_control_message").balloon?.content).toBeTruthy();
		child(menu, "playlist_control_message").onClickFunc?.();
		expect(onSendMessage).toHaveBeenCalled();
	});

	// The submenu's ids/names mirror PLAYLIST_APP_IDS — the same ids the
	// student-side bridge resolves — so a drifted id would silently focus
	// nothing on the students' desktops.
	it("lists the four playlist apps under Bring App to Front and passes their app ids", () => {
		const onFocusApp = vi.fn();
		const focus = child(documentControlMenu({ ...noopControl, onFocusApp }), "playlist_control_focus");
		expect(focus.menuChildren?.map((c) => c.title)).toEqual([
			"TV", "Radio Traffic", "News", "Flight Tracker",
		]);

		focus.menuChildren?.[0].onClickFunc?.();
		expect(onFocusApp).toHaveBeenCalledWith("TV.app");
		focus.menuChildren?.[3].onClickFunc?.();
		expect(onFocusApp).toHaveBeenCalledWith("FlightTracker.app");
	});

	// Push only works when students can fetch what they're told to fetch:
	// unsaved edits aren't on the server, and drafts are refused by the
	// anonymous loader. Dirty is the more actionable reason, so it wins the
	// balloon when both apply.
	it("gates Push Update to Class on a saved, published playlist", () => {
		const onPushUpdate = vi.fn();
		const ready = child(
			documentControlMenu({ ...noopControl, onPushUpdate }),
			"playlist_control_push",
		);
		expect(ready.disabled).toBe(false);
		ready.onClickFunc?.();
		expect(onPushUpdate).toHaveBeenCalled();

		const dirty = child(
			documentControlMenu({ ...noopControl, dirty: true }),
			"playlist_control_push",
		);
		expect(dirty.disabled).toBe(true);
		expect(dirty.balloon?.content).toContain("Save first");

		const draft = child(
			documentControlMenu({ ...noopControl, status: "draft" }),
			"playlist_control_push",
		);
		expect(draft.disabled).toBe(true);
		expect(draft.balloon?.content).toContain("published");

		const both = child(
			documentControlMenu({ ...noopControl, dirty: true, status: "draft" }),
			"playlist_control_push",
		);
		expect(both.balloon?.content).toContain("Save first");
	});
});

describe("addMenuItems", () => {
	it("renders Settings as a submenu of registered apps instead of a direct action", () => {
		const run = vi.fn();
		const runSettings = vi.fn();
		const items = addMenuItems(ADD_ACTIONS, run, runSettings);

		const settings = items.find((i) => i.id === "playlist_add_settings");
		expect(settings?.onClickFunc).toBeUndefined();
		expect(settings?.menuChildren?.map((c) => c.title)).toEqual(["TV", "Weather"]);

		settings?.menuChildren?.[1].onClickFunc?.();
		expect(runSettings).toHaveBeenCalledWith("Weather.app");
		expect(run).not.toHaveBeenCalled();
	});

	it("keeps every other action a direct click", () => {
		const run = vi.fn();
		const items = addMenuItems(ADD_ACTIONS, run, vi.fn());

		const jump = items.find((i) => i.id === "playlist_add_jump");
		jump?.onClickFunc?.();
		expect(run).toHaveBeenCalledWith(ADD_ACTIONS.find((a) => a.id === "jump"));
	});
});

describe("windowMenu", () => {
	it("lists every open document after the fixed items", () => {
		const menu = windowMenu({
			onFocusTools: vi.fn(),
			onFocusSettings: vi.fn(),
			onFocusList: vi.fn(),
			onFocusDocument: vi.fn(),
			documents: [{ playlistId: "p1", title: "Lesson One" }, { playlistId: "p2", title: "Lesson Two" }],
		});

		expect(menu.menuChildren?.map((c) => c.title)).toEqual([
			"Tools", "Settings", undefined, "My Playlists", "Lesson One", "Lesson Two",
		]);
	});

	it("focuses the document the item names", () => {
		const onFocusDocument = vi.fn();
		const menu = windowMenu({
			onFocusTools: vi.fn(), onFocusSettings: vi.fn(), onFocusList: vi.fn(), onFocusDocument,
			documents: [{ playlistId: "p7", title: "Lesson" }],
		});

		child(menu, "playlist_window_doc_p7").onClickFunc?.();

		expect(onFocusDocument).toHaveBeenCalledWith("p7");
	});

	it("reveals the Settings window from its fixed item", () => {
		const onFocusSettings = vi.fn();
		const menu = windowMenu({
			onFocusTools: vi.fn(), onFocusSettings, onFocusList: vi.fn(),
			onFocusDocument: vi.fn(), documents: [],
		});

		child(menu, "playlist_window_settings").onClickFunc?.();

		expect(onFocusSettings).toHaveBeenCalled();
	});
});
