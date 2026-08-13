import { describe, expect, it, vi } from "vitest";
import { ADD_ACTIONS, runAddAction } from "./addActions";

const byId = (id: string) => {
	const found = ADD_ACTIONS.find((a) => a.id === id);
	if (!found) throw new Error(`no add action ${id}`);
	return found;
};

describe("ADD_ACTIONS", () => {
	it("covers all six add surfaces exactly once", () => {
		expect(ADD_ACTIONS.map((a) => a.id)).toEqual([
			"media", "file", "app", "settings", "jump", "browser",
		]);
	});

	it("gives every action an icon and balloon, since the palette has no text", () => {
		for (const action of ADD_ACTIONS) {
			expect(action.icon, action.id).toBeTruthy();
			expect(action.balloon.length, action.id).toBeGreaterThan(10);
		}
	});
});

describe("runAddAction", () => {
	it("dispatches an entry for the kinds that need no dialog", () => {
		const edit = vi.fn();
		const setDialogMode = vi.fn();

		runAddAction(byId("jump"), { playlistId: "p1", edit, setDialogMode });

		expect(edit).toHaveBeenCalledWith("p1", {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
		});
		expect(setDialogMode).not.toHaveBeenCalled();
	});

	// Media and File pick an existing item, so they open the file dialog
	// rather than appending a blank entry.
	it("opens the file dialog for media and file, dispatching nothing", () => {
		const edit = vi.fn();
		const setDialogMode = vi.fn();

		runAddAction(byId("media"), { playlistId: "p1", edit, setDialogMode });
		expect(setDialogMode).toHaveBeenCalledWith("media");

		runAddAction(byId("file"), { playlistId: "p1", edit, setDialogMode });
		expect(setDialogMode).toHaveBeenCalledWith("file");

		expect(edit).not.toHaveBeenCalled();
	});
});
