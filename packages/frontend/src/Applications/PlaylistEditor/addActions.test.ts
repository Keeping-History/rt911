import { describe, expect, it, vi } from "vitest";
import { ADD_ACTIONS, runAddAction, runAddSettings } from "./addActions";

const byId = (id: string) => {
	const found = ADD_ACTIONS.find((a) => a.id === id);
	if (!found) throw new Error(`no add action ${id}`);
	return found;
};

const handlers = () => ({
	playlistId: "p1",
	edit: vi.fn(),
	setDialogMode: vi.fn(),
	openSettings: vi.fn(),
});

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
	it("dispatches an entry, selects it, and opens the Settings window", () => {
		const h = handlers();

		runAddAction(byId("jump"), h);

		expect(h.edit).toHaveBeenCalledWith("p1", {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
			select: true,
		});
		expect(h.openSettings).toHaveBeenCalled();
		expect(h.setDialogMode).not.toHaveBeenCalled();
	});

	// Media and File pick an existing item, so they open the file dialog
	// rather than appending a blank entry.
	it("opens the file dialog for media and file, dispatching nothing", () => {
		const h = handlers();

		runAddAction(byId("media"), h);
		expect(h.setDialogMode).toHaveBeenCalledWith("media");

		runAddAction(byId("file"), h);
		expect(h.setDialogMode).toHaveBeenCalledWith("file");

		expect(h.edit).not.toHaveBeenCalled();
		expect(h.openSettings).not.toHaveBeenCalled();
	});

	// Settings goes through runAddSettings with a picked app; the generic
	// runner must neither dispatch a blank entry nor open the dialog.
	it("does nothing for settings — its surfaces render an app menu instead", () => {
		const h = handlers();

		runAddAction(byId("settings"), h);

		expect(h.edit).not.toHaveBeenCalled();
		expect(h.setDialogMode).not.toHaveBeenCalled();
		expect(h.openSettings).not.toHaveBeenCalled();
	});
});

describe("runAddSettings", () => {
	it("adds a settings entry for the picked app, selected, with the Settings window open", () => {
		const h = handlers();

		runAddSettings("Weather.app", h);

		expect(h.edit).toHaveBeenCalledWith("p1", {
			type: "addEntries",
			entries: [{ entry: { kind: "settings", appId: "Weather.app", values: {} } }],
			select: true,
		});
		expect(h.openSettings).toHaveBeenCalled();
	});
});
