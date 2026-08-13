import type { ClassicyMenuItem } from "classicy";
import { describe, expect, it, vi } from "vitest";
import { documentControlMenu, documentEditMenu, documentFileMenu, windowMenu } from "./playlistMenus";

const child = (menu: ClassicyMenuItem, id: string): ClassicyMenuItem => {
	const found = menu.menuChildren?.find((c) => c.id === id);
	if (!found) throw new Error(`no item ${id} in ${menu.id}`);
	return found;
};

const noopFile = {
	onOpenList: vi.fn(), onSave: vi.fn(), onRename: vi.fn(), onDuplicate: vi.fn(),
	onDelete: vi.fn(), onSetStatus: vi.fn(), quitItem: { id: "quit", title: "Quit" },
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
		const locked = documentControlMenu({ lock: { clock: true, busy: false }, onToggleClock: vi.fn() });
		expect(child(locked, "playlist_control_clock").checked).toBe(true);
		expect(child(locked, "playlist_control_clock").disabled).toBe(false);

		const busy = documentControlMenu({ lock: { clock: false, busy: true }, onToggleClock: vi.fn() });
		expect(child(busy, "playlist_control_clock").disabled).toBe(true);
	});

	// Content locking is not built; the item exists so the pair reads as the
	// pair it will become.
	it("always disables Lock Contents and wires no handler", () => {
		const menu = documentControlMenu({ lock: { clock: false, busy: false }, onToggleClock: vi.fn() });
		const contents = child(menu, "playlist_control_contents");
		expect(contents.disabled).toBe(true);
		expect(contents.onClickFunc).toBeUndefined();
	});
});

describe("windowMenu", () => {
	it("lists every open document after the fixed items", () => {
		const menu = windowMenu({
			onFocusTools: vi.fn(),
			onFocusList: vi.fn(),
			onFocusDocument: vi.fn(),
			documents: [{ playlistId: "p1", title: "Lesson One" }, { playlistId: "p2", title: "Lesson Two" }],
		});

		expect(menu.menuChildren?.map((c) => c.title)).toEqual([
			"Tools", undefined, "My Playlists", "Lesson One", "Lesson Two",
		]);
	});

	it("focuses the document the item names", () => {
		const onFocusDocument = vi.fn();
		const menu = windowMenu({
			onFocusTools: vi.fn(), onFocusList: vi.fn(), onFocusDocument,
			documents: [{ playlistId: "p7", title: "Lesson" }],
		});

		child(menu, "playlist_window_doc_p7").onClickFunc?.();

		expect(onFocusDocument).toHaveBeenCalledWith("p7");
	});
});
