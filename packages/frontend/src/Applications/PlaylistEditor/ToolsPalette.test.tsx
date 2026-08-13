import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsPalette } from "./ToolsPalette";

const editMock = vi.fn();
const setDialogModeMock = vi.fn();
const ctx = vi.hoisted(() => ({ current: { activeId: null as string | null } }));

vi.mock("./PlaylistEditorProvider", () => ({
	usePlaylistEditor: () => ({
		activeId: ctx.current.activeId,
		edit: editMock,
		setDialogMode: setDialogModeMock,
	}),
}));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ToolsPalette", () => {
	it("disables every tool when no playlist window is frontmost", () => {
		ctx.current.activeId = null;
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" />);

		for (const button of screen.getAllByRole("button")) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}
	});

	it("adds to the active document, not to whichever opened first", () => {
		ctx.current.activeId = "p2";
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" />);

		fireEvent.click(screen.getByRole("button", { name: "Add Jump" }));

		expect(editMock).toHaveBeenCalledWith("p2", {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
		});
	});

	it("opens the file dialog for Add Media…", () => {
		ctx.current.activeId = "p1";
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" />);

		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));

		expect(setDialogModeMock).toHaveBeenCalledWith("media");
		expect(editMock).not.toHaveBeenCalled();
	});
});
