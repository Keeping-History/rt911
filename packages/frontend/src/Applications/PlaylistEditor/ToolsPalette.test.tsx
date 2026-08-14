import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADD_ACTIONS } from "./addActions";
import { ToolsPalette } from "./ToolsPalette";

const editMock = vi.fn();
const setDialogModeMock = vi.fn();
const openSettingsWindowMock = vi.fn();
const ctx = vi.hoisted(() => ({ current: { activeId: null as string | null } }));

vi.mock("./PlaylistEditorProvider", () => ({
	usePlaylistEditor: () => ({
		activeId: ctx.current.activeId,
		edit: editMock,
		setDialogMode: setDialogModeMock,
		openSettingsWindow: openSettingsWindowMock,
	}),
}));

vi.mock("./settingsRegistry", () => ({
	listSettingsApps: () => [
		{ appId: "TV.app", name: "TV" },
		{ appId: "Weather.app", name: "Weather" },
	],
}));

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	// The dropdown's wiring is ours; the floating-menu chrome (fixed
	// positioning, provider, outside-click close) is classicy's. Render the
	// items as plain buttons so clicks exercise our onClickFuncs without the
	// desktop providers the real menu hooks into.
	ClassicyContextualMenu: ({
		menuItems,
	}: {
		menuItems: { id: string; title?: string; onClickFunc?: () => void }[];
	}) => (
		<ul data-testid="settings-dropdown">
			{menuItems.map((i) => (
				<li key={i.id}>
					<button type="button" onClick={i.onClickFunc}>{i.title}</button>
				</li>
			))}
		</ul>
	),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ToolsPalette", () => {
	it("disables every tool when no playlist window is frontmost", () => {
		ctx.current.activeId = null;
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

		for (const button of screen.getAllByRole("button")) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}
	});

	// This asserts only that the palette targets `activeId`. The cross-window
	// claim — that `activeId` is the LAST-FOCUSED document rather than the
	// first-opened one — is covered where the provider and the real windows
	// exist: PlaylistEditorProvider.test.tsx and PlaylistEditor.test.tsx.
	it("adds to the active document, selecting the entry and opening Settings", () => {
		ctx.current.activeId = "p2";
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

		fireEvent.click(screen.getByRole("button", { name: "Add Jump" }));

		expect(editMock).toHaveBeenCalledWith("p2", {
			type: "addEntries",
			entries: [{ entry: { kind: "jump", at: "", to: "" } }],
			select: true,
		});
		expect(openSettingsWindowMock).toHaveBeenCalled();
	});

	it("opens the file dialog for Add Media…", () => {
		ctx.current.activeId = "p1";
		render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));

		expect(setDialogModeMock).toHaveBeenCalledWith("media");
		expect(editMock).not.toHaveBeenCalled();
	});

	describe("Add Settings dropdown", () => {
		it("shows the registered apps on click instead of dispatching", () => {
			ctx.current.activeId = "p1";
			render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

			expect(screen.queryByTestId("settings-dropdown")).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: "Add Settings" }));

			expect(editMock).not.toHaveBeenCalled();
			expect(screen.getByTestId("settings-dropdown")).not.toBeNull();
			expect(screen.getByRole("button", { name: "TV" })).not.toBeNull();
			expect(screen.getByRole("button", { name: "Weather" })).not.toBeNull();
		});

		it("adds a settings entry for the picked app and closes the dropdown", () => {
			ctx.current.activeId = "p1";
			render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

			fireEvent.click(screen.getByRole("button", { name: "Add Settings" }));
			fireEvent.click(screen.getByRole("button", { name: "Weather" }));

			expect(editMock).toHaveBeenCalledWith("p1", {
				type: "addEntries",
				entries: [{ entry: { kind: "settings", appId: "Weather.app", values: {} } }],
				select: true,
			});
			expect(openSettingsWindowMock).toHaveBeenCalled();
			expect(screen.queryByTestId("settings-dropdown")).toBeNull();
		});

		it("toggles closed on a second click without dispatching", () => {
			ctx.current.activeId = "p1";
			render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

			fireEvent.click(screen.getByRole("button", { name: "Add Settings" }));
			fireEvent.click(screen.getByRole("button", { name: "Add Settings" }));

			expect(screen.queryByTestId("settings-dropdown")).toBeNull();
			expect(editMock).not.toHaveBeenCalled();
		});
	});

	// Verify all six add actions are present in the toolbar and dispatch correctly.
	// This parametrized test catches both dispatch wiring and silent drops due to GROUPS/ADD_ACTIONS mismatches.
	describe("add action dispatch coverage", () => {
		ADD_ACTIONS.forEach((action) => {
			it(`${action.label} button is present and dispatches correctly`, () => {
				ctx.current.activeId = "p1";
				render(<ToolsPalette appId="PlaylistEditor.app" icon="i.png" appMenu={[]} />);

				// Assert the button exists by accessible name — catches a missing or mis-typed GROUPS entry.
				const button = screen.getByRole("button", { name: action.label });
				expect(button).toBeDefined();

				fireEvent.click(button);

				if (action.id === "settings") {
					// Settings opens its app dropdown; nothing dispatches until an app is picked.
					expect(screen.getByTestId("settings-dropdown")).not.toBeNull();
					expect(editMock).not.toHaveBeenCalled();
					expect(setDialogModeMock).not.toHaveBeenCalled();
				} else if (action.entry === null) {
					// Dialog actions (media, file) open the file dialog and do NOT dispatch an entry.
					expect(setDialogModeMock).toHaveBeenCalledWith(action.id);
					expect(editMock).not.toHaveBeenCalled();
				} else {
					// Entry actions dispatch via edit, select the new entry, and open Settings.
					expect(editMock).toHaveBeenCalledWith("p1", {
						type: "addEntries",
						entries: [{ entry: action.entry }],
						select: true,
					});
					expect(openSettingsWindowMock).toHaveBeenCalled();
					expect(setDialogModeMock).not.toHaveBeenCalled();
				}
			});
		});
	});
});
