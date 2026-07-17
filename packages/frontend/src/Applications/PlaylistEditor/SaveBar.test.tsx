import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
	updatePlaylist: vi.fn(),
	parsePlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Auth/playlistApi")>()),
	updatePlaylist: mocks.updatePlaylist,
}));
vi.mock("../../Providers/Playlist/parsePlaylist", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Playlist/parsePlaylist")>()),
	parsePlaylist: mocks.parsePlaylist,
}));

import { AuthRequiredError } from "../../Providers/Auth/authApi";
import type { EditorState } from "./editorState";
import { SaveBar } from "./SaveBar";

const baseState: EditorState = {
	playlistId: "p1",
	title: "Lesson",
	mode: "restrict",
	status: "draft",
	entries: [{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "ABC" } }],
	selectedUid: null,
	dirty: true,
	nextUid: 2,
};

const savedRecord = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "restrict", entries: [] },
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SaveBar", () => {
	it("disables Save when the state is not dirty", () => {
		mocks.parsePlaylist.mockReturnValue({ definition: { version: 1, mode: "restrict", entries: [] }, warnings: [] });
		render(<SaveBar state={{ ...baseState, dirty: false }} onSaved={() => {}} />);
		const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it("a clean save calls updatePlaylist with the assembled definition and fires onSaved", async () => {
		const assembled = { version: 1, mode: "restrict", entries: baseState.entries.map((e) => e.entry) };
		mocks.parsePlaylist.mockReturnValue({ definition: assembled, warnings: [] });
		mocks.updatePlaylist.mockResolvedValue(savedRecord);
		const onSaved = vi.fn();

		render(<SaveBar state={baseState} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await screen.findByRole("button", { name: "Save" }); // let the microtask flush
		expect(mocks.updatePlaylist).toHaveBeenCalledWith("p1", {
			title: "Lesson",
			definition: assembled,
			status: "draft",
		});
		expect(onSaved).toHaveBeenCalledWith(savedRecord);
	});

	it("blocks the save with an inline error and makes no API call when the definition is structurally invalid", async () => {
		mocks.parsePlaylist.mockReturnValue({ definition: null, warnings: ["structurally invalid playlist document"] });

		render(<SaveBar state={baseState} onSaved={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("This playlist is invalid and can't be saved.")).not.toBeNull();
		expect(mocks.updatePlaylist).not.toHaveBeenCalled();
	});

	it("shows warnings and requires Save Anyway before calling the API", async () => {
		const assembled = { version: 1, mode: "restrict", entries: baseState.entries.map((e) => e.entry) };
		mocks.parsePlaylist.mockReturnValue({ definition: assembled, warnings: ["backward jump at ... loops until interrupted"] });
		mocks.updatePlaylist.mockResolvedValue(savedRecord);
		const onSaved = vi.fn();

		render(<SaveBar state={baseState} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("backward jump at ... loops until interrupted")).not.toBeNull();
		expect(mocks.updatePlaylist).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Save Anyway" }));
		await screen.findByRole("button", { name: "Save" });
		expect(mocks.updatePlaylist).toHaveBeenCalledWith("p1", {
			title: "Lesson",
			definition: assembled,
			status: "draft",
		});
		expect(onSaved).toHaveBeenCalledWith(savedRecord);
	});

	it("Don't Save cancels the warned save without calling the API", () => {
		const assembled = { version: 1, mode: "restrict" as const, entries: baseState.entries.map((e) => e.entry) };
		mocks.parsePlaylist.mockReturnValue({ definition: assembled, warnings: ["some warning"] });

		render(<SaveBar state={baseState} onSaved={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByText("some warning")).not.toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));
		expect(screen.queryByText("some warning")).toBeNull();
		expect(mocks.updatePlaylist).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
	});

	it("renders the signed-out message and keeps state on AuthRequiredError, without calling onSaved", async () => {
		const assembled = { version: 1, mode: "restrict" as const, entries: baseState.entries.map((e) => e.entry) };
		mocks.parsePlaylist.mockReturnValue({ definition: assembled, warnings: [] });
		mocks.updatePlaylist.mockRejectedValue(new AuthRequiredError("auth"));
		const onSaved = vi.fn();

		render(<SaveBar state={baseState} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText("You've been signed out. Sign in via the Account app, then save again."),
		).not.toBeNull();
		expect(onSaved).not.toHaveBeenCalled();
		// state kept: Save button still present and reflects the (still-dirty) state
		expect(screen.getByRole("button", { name: "Save" })).not.toBeNull();
	});

	it("shows a plain error message for other failures", async () => {
		const assembled = { version: 1, mode: "restrict" as const, entries: baseState.entries.map((e) => e.entry) };
		mocks.parsePlaylist.mockReturnValue({ definition: assembled, warnings: [] });
		mocks.updatePlaylist.mockRejectedValue(new Error("Failed to update playlist"));

		render(<SaveBar state={baseState} onSaved={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("Failed to update playlist")).not.toBeNull();
	});
});

describe("SaveBar — real parsePlaylist (entry-dropping vs. warning-only)", () => {
	beforeEach(async () => {
		const actual = await vi.importActual<typeof import("../../Providers/Playlist/parsePlaylist")>(
			"../../Providers/Playlist/parsePlaylist",
		);
		mocks.parsePlaylist.mockImplementation(actual.parsePlaylist);
	});

	it("blocks the save with no Save Anyway button when an entry would be dropped (empty jump at/to)", () => {
		const stateWithBadJump: EditorState = {
			...baseState,
			entries: [
				{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "ABC" } },
				{ uid: "e2", entry: { kind: "jump", at: "", to: "" } },
			],
		};

		render(<SaveBar state={stateWithBadJump} onSaved={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(
			screen.getByText("Some entries are incomplete and would be lost — fix them before saving."),
		).not.toBeNull();
		expect(screen.getByText("jump entry needs valid at and to")).not.toBeNull();
		expect(screen.queryByRole("button", { name: /save anyway/i })).toBeNull();
		expect(mocks.updatePlaylist).not.toHaveBeenCalled();
	});

	it("offers Save Anyway (and saves via it) for a non-dropping warning like a backward jump", async () => {
		const stateWithBackwardJump: EditorState = {
			...baseState,
			entries: [
				{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "ABC" } },
				{
					uid: "e2",
					entry: { kind: "jump", at: "2001-09-11T12:50:00.000Z", to: "2001-09-11T12:40:00.000Z" },
				},
			],
		};
		mocks.updatePlaylist.mockResolvedValue(savedRecord);
		const onSaved = vi.fn();

		render(<SaveBar state={stateWithBackwardJump} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText(
				"backward jump at 2001-09-11T12:50:00.000Z → 2001-09-11T12:40:00.000Z loops until interrupted",
			),
		).not.toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Save Anyway" }));
		await screen.findByRole("button", { name: "Save" });
		expect(mocks.updatePlaylist).toHaveBeenCalled();
		expect(onSaved).toHaveBeenCalledWith(savedRecord);
	});
});
