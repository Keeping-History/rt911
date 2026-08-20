# Playlist Editor Multi-Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-window Playlist Editor into a document-based app — one window per open playlist, document commands in the menu bar, and the six "Add …" buttons relocated to a floating Tools palette of icon buttons.

**Architecture:** Editor state lifts out of the window component into an app-level provider keyed by playlist id, so a floating palette can dispatch into whichever document is frontmost. A thin keyed wrapper routes actions to one playlist's slice; `editorReducer`'s existing cases are untouched, and Task 7 adds exactly one new case (`renamed`). Menus are built by pure functions and handed to each `ClassicyWindow` via `appMenu`, which is how Classicy decides what the menu bar shows.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + React Testing Library, `classicy` (external npm component library).

**Spec:** `plans/2026-08-13-playlist-editor-multiwindow-design.md` — read it before starting. This plan argues from it; where they disagree, the spec wins.

## Global Constraints

- **Working directory:** `/home/robbiebyrd/rt911/.claude/worktrees/af1-track`. Branch `playlist-editor-multiwindow`, based on `main` @ `ac0dadee`. Do not `cd` to the original repo root.
- **Every commit must carry the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.** This repo publishes an authorship breakdown driven by that trailer; a commit without it is silently recorded as human-authored. The commit commands below all include it — do not strip it.
- **Never modify the `classicy` package.** It is external and pinned to `"latest"`; `.husky/pre-commit` auto-bumps it. Do not hand-edit its version in `package.json` and do not be alarmed if a `pnpm-lock.yaml` bump rides along in your commit.
- **Frontend vitest has no RTL auto-cleanup.** Every new test file must call `afterEach(cleanup)` or renders leak into later tests in the same file.
- **`{ id: "spacer" }` is Classicy's separator convention** — an item with that id renders as an `<hr>`. It is not a placeholder id.
- **Test commands** (run from repo root):
  - one file: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/<file>`
  - one test: `pnpm --filter @rt911/frontend exec vitest run -t "<name>"`
  - types: `pnpm --filter @rt911/frontend exec tsc -b`
  - lint: `pnpm lint`
- **Display timezone is `-4`** (`DISPLAY_TZ_OFFSET_HOURS` in `editorState.ts`). Do not introduce a second copy.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `editorStates.ts` | Pure keyed reducer over `Record<playlistId, EditorState>`. No React. |
| `useSavePlaylist.ts` | The save validation gates, as state instead of JSX. Replaces `SaveBar.tsx`. |
| `addActions.ts` | The six Add actions, shared by the palette and `Edit > Add…`. Pure data + one dispatcher. |
| `PlaylistEditorProvider.tsx` | Owns keyed state, `openIds`, `activeId`, room locks, dialog mode. |
| `playlistMenus.ts` | Pure builders for the File / Edit / Control / Window menus. |
| `ToolsPalette.tsx` | The utility-class palette window and its six icon buttons. |
| `RenameDialog.tsx` | Modal window shell + form for `File > Rename…`. |
| `PlaylistDocumentWindow.tsx` | One playlist's window: menus, alerts, dirty-close, body. |

**Modified:** `PlaylistEditor.tsx` (app shell), `PlaylistEditorMain.tsx` (body only — header and add bar deleted), `PlaylistList.tsx` (Open hands a record upward instead of swapping the view).

**Deleted:** `SaveBar.tsx`, `SaveBar.test.tsx`, `ControlPanel.tsx`, `ControlPanel.test.tsx`.

---

### Task 1: Keyed editor state reducer

The map that lets one reducer serve N open documents. Pure — no React, no classicy.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/editorStates.ts`
- Test: `packages/frontend/src/Applications/PlaylistEditor/editorStates.test.ts`

**Interfaces:**
- Consumes: `editorReducer`, `initialEditorState`, `EditorState`, `EditorAction` from `./editorState`; `PlaylistRecord` from `../../Providers/Auth/playlistApi`.
- Produces: `EditorStates`, `EditorStatesAction`, `editorStatesReducer(states, action)`.

- [ ] **Step 1: Write the failing test**

Create `editorStates.test.ts`:

```tsx
import { describe, expect, it } from "vitest";
import { editorStatesReducer, type EditorStates } from "./editorStates";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";

const rec = (id: string, title = "Lesson"): PlaylistRecord => ({
	id,
	title,
	status: "draft",
	date_updated: null,
	user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
});

const opened = (...ids: string[]): EditorStates =>
	ids.reduce<EditorStates>(
		(acc, id) => editorStatesReducer(acc, { kind: "open", record: rec(id) }),
		{},
	);

describe("editorStatesReducer", () => {
	it("opens a playlist into its own slot", () => {
		const states = opened("p1");
		expect(Object.keys(states)).toEqual(["p1"]);
		expect(states.p1.title).toBe("Lesson");
		expect(states.p1.dirty).toBe(false);
	});

	// Reopening from the list must not silently throw away unsaved edits.
	it("leaves an already-open playlist untouched when reopened", () => {
		const dirty = editorStatesReducer(opened("p1"), {
			kind: "edit",
			playlistId: "p1",
			action: { type: "setTitle", title: "Edited" },
		});

		const reopened = editorStatesReducer(dirty, { kind: "open", record: rec("p1") });

		expect(reopened).toBe(dirty);
		expect(reopened.p1.title).toBe("Edited");
	});

	it("routes an edit to one playlist and leaves the others identical", () => {
		const before = opened("p1", "p2");

		const after = editorStatesReducer(before, {
			kind: "edit",
			playlistId: "p1",
			action: { type: "setTitle", title: "Edited" },
		});

		expect(after.p1.title).toBe("Edited");
		expect(after.p1.dirty).toBe(true);
		// Reference equality, not just deep equality: an untouched document must
		// not re-render because a sibling changed.
		expect(after.p2).toBe(before.p2);
	});

	it("ignores an edit aimed at a playlist that is not open", () => {
		const before = opened("p1");
		const after = editorStatesReducer(before, {
			kind: "edit",
			playlistId: "ghost",
			action: { type: "setTitle", title: "Nope" },
		});
		expect(after).toBe(before);
	});

	it("drops a playlist on close and leaves the rest identical", () => {
		const before = opened("p1", "p2");
		const after = editorStatesReducer(before, { kind: "close", playlistId: "p1" });

		expect(Object.keys(after)).toEqual(["p2"]);
		expect(after.p2).toBe(before.p2);
	});

	it("ignores closing a playlist that is not open", () => {
		const before = opened("p1");
		expect(editorStatesReducer(before, { kind: "close", playlistId: "ghost" })).toBe(before);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/editorStates.test.ts`
Expected: FAIL — cannot resolve `./editorStates`.

- [ ] **Step 3: Write the implementation**

Create `editorStates.ts`:

```ts
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { type EditorAction, editorReducer, type EditorState, initialEditorState } from "./editorState";

/** One `EditorState` per open document window, keyed by playlist id. */
export type EditorStates = Record<string, EditorState>;

export type EditorStatesAction =
	| { kind: "open"; record: PlaylistRecord }
	| { kind: "close"; playlistId: string }
	| { kind: "edit"; playlistId: string; action: EditorAction };

/**
 * Routes an `EditorAction` to one playlist's state and leaves every other
 * entry reference-identical, so opening a second playlist can never re-render
 * — or worse, reset — the first.
 *
 * `editorReducer`'s cases are deliberately untouched here: this wrapper owns only the
 * keying, which is why every existing `editorState.test.ts` case still holds.
 */
export function editorStatesReducer(
	states: EditorStates,
	action: EditorStatesAction,
): EditorStates {
	switch (action.kind) {
		case "open":
			// Already open: return the SAME object. Re-seeding from the record
			// would discard unsaved edits the moment a user picked an
			// already-open playlist out of the list again.
			if (states[action.record.id]) return states;
			return { ...states, [action.record.id]: initialEditorState(action.record) };
		case "close": {
			if (!states[action.playlistId]) return states;
			const next = { ...states };
			delete next[action.playlistId];
			return next;
		}
		case "edit": {
			const current = states[action.playlistId];
			if (!current) return states;
			return { ...states, [action.playlistId]: editorReducer(current, action.action) };
		}
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/editorStates.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/editorStates.ts \
        packages/frontend/src/Applications/PlaylistEditor/editorStates.test.ts
git commit -m "feat(frontend): key playlist editor state by playlist id

One EditorState per open document, so a floating palette can dispatch
into whichever playlist is frontmost. editorReducer's cases are unchanged;
this wrapper owns only the keying.

Reopening an already-open playlist returns the same state object rather
than re-seeding from the record, which would have discarded unsaved
edits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract the save gates into `useSavePlaylist`

`SaveBar` mixes three validation gates with their rendering. `File > Save`, the dirty-close prompt, and Delete all need the gates; none of them want the bar.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/useSavePlaylist.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/useSavePlaylist.test.ts`
- Delete (Step 6): `SaveBar.tsx`, `SaveBar.test.tsx`

**Interfaces:**
- Consumes: `EditorState`, `assembleDefinition` from `./editorState`; `parsePlaylist`; `updatePlaylist`, `PlaylistRecord`; `AuthRequiredError`.
- Produces: `SavePrompt`, `useSavePlaylist(state, onSaved, updateFn?)` → `{ prompt, save, confirmSave, dismiss, saving }`.

- [ ] **Step 1: Write the failing test**

Create `useSavePlaylist.test.ts`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import type { EditorState } from "./editorState";
import { useSavePlaylist } from "./useSavePlaylist";

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1",
	title: "Lesson",
	mode: "annotate",
	status: "draft",
	entries: [],
	selectedUid: null,
	dirty: true,
	nextUid: 1,
	...over,
});

const savedRecord = {
	id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1 as const, mode: "annotate" as const, entries: [] },
};

describe("useSavePlaylist", () => {
	it("writes and reports the saved record when the definition is clean", async () => {
		const update = vi.fn().mockResolvedValue(savedRecord);
		const onSaved = vi.fn();
		const { result } = renderHook(() => useSavePlaylist(state(), onSaved, update));

		act(() => result.current.save());

		await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedRecord));
		expect(update).toHaveBeenCalledWith("p1", {
			title: "Lesson",
			definition: { version: 1, mode: "annotate", entries: [] },
			status: "draft",
		});
		expect(result.current.prompt).toEqual({ kind: "none" });
	});

	// An entry that validation DROPS would vanish on next open, so saving is
	// blocked outright rather than offered as "save anyway".
	it("blocks the save when validation would drop entries", async () => {
		const update = vi.fn();
		const dirty = state({
			entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }],
		});
		const { result } = renderHook(() => useSavePlaylist(dirty, vi.fn(), update));

		act(() => result.current.save());

		await waitFor(() => expect(result.current.prompt.kind).toBe("dropped"));
		expect(update).not.toHaveBeenCalled();
	});

	it("surfaces a sign-out as an actionable message instead of a generic failure", async () => {
		const update = vi.fn().mockRejectedValue(new AuthRequiredError("nope"));
		const { result } = renderHook(() => useSavePlaylist(state(), vi.fn(), update));

		act(() => result.current.save());

		await waitFor(() =>
			expect(result.current.prompt).toEqual({
				kind: "message",
				message: "You've been signed out. Sign in via the Account app, then save again.",
			}),
		);
	});

	it("dismiss clears the prompt without writing", async () => {
		const update = vi.fn().mockRejectedValue(new Error("boom"));
		const { result } = renderHook(() => useSavePlaylist(state(), vi.fn(), update));

		act(() => result.current.save());
		await waitFor(() => expect(result.current.prompt.kind).toBe("message"));

		act(() => result.current.dismiss());

		expect(result.current.prompt).toEqual({ kind: "none" });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/useSavePlaylist.test.ts`
Expected: FAIL — cannot resolve `./useSavePlaylist`.

- [ ] **Step 3: Write the implementation**

Create `useSavePlaylist.ts`:

```ts
import { useCallback, useState } from "react";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import { type PlaylistRecord, updatePlaylist } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import { assembleDefinition, type EditorState } from "./editorState";

/**
 * What the owning window should put on screen, if anything. The window renders
 * these as a ClassicyAlert; the hook itself renders nothing, which is what lets
 * File > Save, the dirty-close prompt, and Delete share one gate.
 */
export type SavePrompt =
	/** Nothing to show. */
	| { kind: "none" }
	/** A blocking message with a single OK. */
	| { kind: "message"; message: string }
	/** Validation would drop entries — blocked, with the reasons. */
	| { kind: "dropped"; warnings: string[] }
	/** Validation warned but dropped nothing — offer Save Anyway. */
	| { kind: "warnings"; warnings: string[] };

export function useSavePlaylist(
	state: EditorState,
	onSaved: (record: PlaylistRecord) => void,
	/** Injectable for tests; defaults to the real API call. */
	updateFn: typeof updatePlaylist = updatePlaylist,
) {
	const [prompt, setPrompt] = useState<SavePrompt>({ kind: "none" });
	const [saving, setSaving] = useState(false);

	const write = useCallback(async () => {
		setSaving(true);
		try {
			const record = await updateFn(state.playlistId, {
				title: state.title,
				definition: assembleDefinition(state),
				status: state.status,
			});
			setPrompt({ kind: "none" });
			onSaved(record);
		} catch (err) {
			setPrompt({
				kind: "message",
				message:
					err instanceof AuthRequiredError
						? "You've been signed out. Sign in via the Account app, then save again."
						: err instanceof Error
							? err.message
							: "Couldn't save.",
			});
		} finally {
			setSaving(false);
		}
	}, [state, onSaved, updateFn]);

	const save = useCallback(() => {
		const parsed = parsePlaylist(assembleDefinition(state));
		if (parsed.definition === null) {
			setPrompt({ kind: "message", message: "This playlist is invalid and can't be saved." });
			return;
		}
		// Dropped entries are not the same as warnings: saving the raw state
		// would silently lose them on next open, so block rather than offer
		// "Save Anyway".
		if (parsed.definition.entries.length < state.entries.length) {
			setPrompt({ kind: "dropped", warnings: parsed.warnings });
			return;
		}
		if (parsed.warnings.length > 0) {
			setPrompt({ kind: "warnings", warnings: parsed.warnings });
			return;
		}
		void write();
	}, [state, write]);

	const confirmSave = useCallback(() => void write(), [write]);
	const dismiss = useCallback(() => setPrompt({ kind: "none" }), []);

	return { prompt, save, confirmSave, dismiss, saving };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/useSavePlaylist.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Delete the superseded component**

```bash
git rm packages/frontend/src/Applications/PlaylistEditor/SaveBar.tsx \
       packages/frontend/src/Applications/PlaylistEditor/SaveBar.test.tsx
```

`PlaylistEditorMain.tsx` still imports `SaveBar` at this point and will not compile. That is expected and is fixed in Task 8; do not patch it here.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/useSavePlaylist.ts \
        packages/frontend/src/Applications/PlaylistEditor/useSavePlaylist.test.ts
git commit -m "refactor(frontend): extract the playlist save gates into a hook

SaveBar mixed three validation gates with their rendering. File > Save,
the dirty-close prompt, and Delete all need the gates and none want the
bar, so the gates become a SavePrompt the owning window renders as an
alert.

Behavior is unchanged: invalid blocks, dropped-entries blocks (saving
raw state would lose them on next open), warnings offer Save Anyway,
and AuthRequiredError keeps its actionable message.

PlaylistEditorMain does not compile until the window rework lands.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The six Add actions, defined once

The palette and `Edit > Add…` must not drift apart as entry kinds are added.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/addActions.ts`
- Test: `packages/frontend/src/Applications/PlaylistEditor/addActions.test.ts`

**Interfaces:**
- Consumes: `ClassicyIcons` from `classicy`; `PlaylistEntry`; `EditorAction`.
- Produces: `AddActionId`, `AddAction`, `ADD_ACTIONS`, `runAddAction(action, handlers)`.

- [ ] **Step 1: Write the failing test**

Create `addActions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/addActions.test.ts`
Expected: FAIL — cannot resolve `./addActions`.

- [ ] **Step 3: Write the implementation**

Create `addActions.ts`:

```ts
import { ClassicyIcons } from "classicy";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import type { EditorAction } from "./editorState";

export type AddActionId = "media" | "file" | "app" | "settings" | "jump" | "browser";

export interface AddAction {
	id: AddActionId;
	/** Palette button label — used as the accessible name, not drawn. */
	label: string;
	/** Title inside Edit > Add…, where "Add" is already implied by the submenu. */
	menuTitle: string;
	icon: string;
	balloon: string;
	/**
	 * The entry to append, or null for actions that instead open the file
	 * dialog (the user is picking something that already exists).
	 */
	entry: PlaylistEntry | null;
}

/**
 * The single definition of the Add surfaces. The Tools palette and the
 * Edit > Add… submenu both render from this array, so a new entry kind cannot
 * appear in one and go missing from the other.
 *
 * Icons are stock ClassicyIcons glyphs — period-correct and already bundled.
 * Every action carries a balloon because the palette buttons are icon-only.
 */
export const ADD_ACTIONS: AddAction[] = [
	{
		id: "media",
		label: "Add Media…",
		menuTitle: "Media…",
		icon: ClassicyIcons.system.quicktime.movie,
		balloon: "Add a TV channel, radio station, news story, or flight to this playlist.",
		entry: null,
	},
	{
		id: "file",
		label: "Add File…",
		menuTitle: "File…",
		icon: ClassicyIcons.system.files.document,
		balloon: "Add a document from the desktop, to be opened at a set time.",
		entry: null,
	},
	{
		id: "app",
		label: "Add App Rule",
		menuTitle: "App Rule",
		icon: ClassicyIcons.system.files.application,
		balloon: "Disable an application for students following this playlist.",
		entry: { kind: "app", appId: "TimeMachine.app", disabled: true },
	},
	{
		id: "settings",
		label: "Add Settings",
		menuTitle: "Settings",
		icon: ClassicyIcons.system.files.preferences,
		balloon: "Force an application's settings — for example, which TV channel it opens on.",
		entry: { kind: "settings", appId: "TV.app", values: {} },
	},
	{
		id: "jump",
		label: "Add Jump",
		menuTitle: "Jump",
		icon: ClassicyIcons.system.extensions.dateAndTime,
		balloon: "Move every student's clock to a new time when the playlist reaches this point.",
		entry: { kind: "jump", at: "", to: "" },
	},
	{
		id: "browser",
		label: "Add Browser",
		menuTitle: "Browser",
		icon: ClassicyIcons.system.network.globe,
		balloon: "Open a web page in the browser at a set time.",
		entry: { kind: "browser", url: "http://", at: "" },
	},
];

export interface AddActionHandlers {
	playlistId: string;
	edit: (playlistId: string, action: EditorAction) => void;
	setDialogMode: (mode: "media" | "file") => void;
}

/** Perform one Add action against a specific playlist. */
export function runAddAction(action: AddAction, handlers: AddActionHandlers): void {
	if (action.entry === null) {
		// Only media and file have a null entry, and their ids are exactly the
		// dialog's two modes.
		handlers.setDialogMode(action.id as "media" | "file");
		return;
	}
	handlers.edit(handlers.playlistId, {
		type: "addEntries",
		entries: [{ entry: action.entry }],
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/addActions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/addActions.ts \
        packages/frontend/src/Applications/PlaylistEditor/addActions.test.ts
git commit -m "feat(frontend): define the six playlist Add actions once

The Tools palette and Edit > Add… both render from this array, so a new
entry kind cannot appear in one surface and go missing from the other.

Icons are stock ClassicyIcons glyphs; every action carries balloon copy
because the palette buttons are icon-only and have no visible label.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The provider

Owns everything the windows and the palette share.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorProvider.tsx`
- Test: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorProvider.test.tsx`

**Interfaces:**
- Consumes: `editorStatesReducer`, `EditorStates` (Task 1); `sendRoomLock`, `RoomCommandError` from `../../Providers/Playlist/roomApi`.
- Produces: `PlaylistEditorProvider`, `usePlaylistEditor()` returning `PlaylistEditorContextValue` (fields listed in the implementation below).

- [ ] **Step 1: Write the failing test**

Create `PlaylistEditorProvider.test.tsx`:

```tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomCommandError } from "../../Providers/Playlist/roomApi";
import { PlaylistEditorProvider, usePlaylistEditor } from "./PlaylistEditorProvider";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";

afterEach(cleanup);

const rec = (id: string, title = "Lesson"): PlaylistRecord => ({
	id, title, status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
});

let api: ReturnType<typeof usePlaylistEditor>;
function Probe() {
	api = usePlaylistEditor();
	return <div data-testid="ids">{api.openIds.join(",")}</div>;
}
const renderProvider = (sendLock = vi.fn().mockResolvedValue(undefined)) =>
	render(
		<PlaylistEditorProvider sendLock={sendLock}>
			<Probe />
		</PlaylistEditorProvider>,
	);

describe("PlaylistEditorProvider", () => {
	it("tracks open documents in open order and makes the newest active", () => {
		renderProvider();

		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		expect(screen.getByTestId("ids").textContent).toBe("p1,p2");
		expect(api.activeId).toBe("p2");
	});

	it("closing the active document clears activeId", () => {
		renderProvider();
		act(() => api.openPlaylist(rec("p1")));

		act(() => api.closePlaylist("p1"));

		expect(api.openIds).toEqual([]);
		expect(api.activeId).toBeNull();
	});

	// The palette targets the last-focused document; focusing the palette
	// itself must not retarget it.
	it("setActive retargets to the focused document", () => {
		renderProvider();
		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		act(() => api.setActive("p1"));

		expect(api.activeId).toBe("p1");
	});

	it("locks the clock only after the server accepts, and per playlist", async () => {
		const sendLock = vi.fn().mockResolvedValue(undefined);
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));
		act(() => api.openPlaylist(rec("p2")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(sendLock).toHaveBeenCalledWith("p1", "clock", true);
		expect(api.locks.p1?.clock).toBe(true);
		// Locking one classroom must not mark another as locked.
		expect(api.locks.p2?.clock ?? false).toBe(false);
	});

	it("leaves the lock off and reports why when the command is refused", async () => {
		const sendLock = vi
			.fn()
			.mockRejectedValue(new RoomCommandError("Only the person who created this playlist can control it."));
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(api.locks.p1?.clock ?? false).toBe(false);
		expect(api.lockError).toEqual({
			playlistId: "p1",
			message: "Only the person who created this playlist can control it.",
		});
	});

	it("reports a generic failure for a non-RoomCommandError", async () => {
		const sendLock = vi.fn().mockRejectedValue(new Error("socket died"));
		renderProvider(sendLock);
		act(() => api.openPlaylist(rec("p1")));

		await act(async () => {
			await api.toggleClockLock("p1");
		});

		expect(api.lockError?.message).toBe("Command failed.");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditorProvider.test.tsx`
Expected: FAIL — cannot resolve `./PlaylistEditorProvider`.

- [ ] **Step 3: Write the implementation**

Create `PlaylistEditorProvider.tsx`:

```tsx
import { createContext, type ReactNode, useCallback, useContext, useMemo, useReducer, useState } from "react";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { RoomCommandError, sendRoomLock } from "../../Providers/Playlist/roomApi";
import type { EditorAction } from "./editorState";
import { editorStatesReducer, type EditorStates } from "./editorStates";

/** Per-playlist room lock state. Not read back from the server — see below. */
export interface LockState {
	clock: boolean;
	busy: boolean;
}

export interface PlaylistEditorContextValue {
	states: EditorStates;
	/** Open documents, in the order they were opened; drives window cascade. */
	openIds: string[];
	/** The last-focused document window's playlist id. */
	activeId: string | null;
	locks: Record<string, LockState>;
	lockError: { playlistId: string; message: string } | null;
	dialogMode: "media" | "file" | null;
	openPlaylist: (record: PlaylistRecord) => void;
	closePlaylist: (playlistId: string) => void;
	setActive: (playlistId: string) => void;
	edit: (playlistId: string, action: EditorAction) => void;
	toggleClockLock: (playlistId: string) => Promise<void>;
	dismissLockError: () => void;
	setDialogMode: (mode: "media" | "file" | null) => void;
}

const PlaylistEditorContext = createContext<PlaylistEditorContextValue | null>(null);

export function usePlaylistEditor(): PlaylistEditorContextValue {
	const ctx = useContext(PlaylistEditorContext);
	if (!ctx) throw new Error("usePlaylistEditor must be used inside PlaylistEditorProvider");
	return ctx;
}

export function PlaylistEditorProvider({
	children,
	/** Injectable for tests; defaults to the real API call. */
	sendLock = sendRoomLock,
}: {
	children: ReactNode;
	sendLock?: typeof sendRoomLock;
}) {
	const [states, dispatchStates] = useReducer(editorStatesReducer, {});
	const [openIds, setOpenIds] = useState<string[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [locks, setLocks] = useState<Record<string, LockState>>({});
	const [lockError, setLockError] = useState<{ playlistId: string; message: string } | null>(null);
	const [dialogMode, setDialogMode] = useState<"media" | "file" | null>(null);

	const openPlaylist = useCallback((record: PlaylistRecord) => {
		dispatchStates({ kind: "open", record });
		setOpenIds((ids) => (ids.includes(record.id) ? ids : [...ids, record.id]));
		// Opening focuses, which is also what makes a freshly duplicated
		// playlist the palette's target.
		setActiveId(record.id);
	}, []);

	const closePlaylist = useCallback((playlistId: string) => {
		dispatchStates({ kind: "close", playlistId });
		setOpenIds((ids) => ids.filter((id) => id !== playlistId));
		setActiveId((current) => (current === playlistId ? null : current));
	}, []);

	const setActive = useCallback((playlistId: string) => setActiveId(playlistId), []);

	const edit = useCallback((playlistId: string, action: EditorAction) => {
		dispatchStates({ kind: "edit", playlistId, action });
	}, []);

	/**
	 * Lock state is held here rather than read back from the server, because
	 * the streamer keeps none: a room command is fire-and-forget, so there is
	 * nothing to query. Two consequences worth knowing: the checkmark resets
	 * when the app is reopened (students stay locked — only the menu forgets),
	 * and two teachers driving one playlist will not see each other's state.
	 */
	const toggleClockLock = useCallback(
		async (playlistId: string) => {
			const current = locks[playlistId] ?? { clock: false, busy: false };
			if (current.busy) return;
			const next = !current.clock;
			setLocks((l) => ({ ...l, [playlistId]: { ...current, busy: true } }));
			setLockError(null);
			try {
				await sendLock(playlistId, "clock", next);
				// Only after the server accepts. Flipping first would leave the
				// menu claiming a lock that never reached a single student.
				setLocks((l) => ({ ...l, [playlistId]: { clock: next, busy: false } }));
			} catch (err) {
				setLocks((l) => ({ ...l, [playlistId]: { ...current, busy: false } }));
				setLockError({
					playlistId,
					message: err instanceof RoomCommandError ? err.message : "Command failed.",
				});
			}
		},
		[locks, sendLock],
	);

	const dismissLockError = useCallback(() => setLockError(null), []);

	const value = useMemo<PlaylistEditorContextValue>(
		() => ({
			states, openIds, activeId, locks, lockError, dialogMode,
			openPlaylist, closePlaylist, setActive, edit,
			toggleClockLock, dismissLockError, setDialogMode,
		}),
		[
			states, openIds, activeId, locks, lockError, dialogMode,
			openPlaylist, closePlaylist, setActive, edit, toggleClockLock, dismissLockError,
		],
	);

	return (
		<PlaylistEditorContext.Provider value={value}>{children}</PlaylistEditorContext.Provider>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditorProvider.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorProvider.tsx \
        packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorProvider.test.tsx
git commit -m "feat(frontend): add the playlist editor provider

Owns keyed editor state, open-document order, the active document, and
per-playlist room locks — everything the document windows and the
floating palette share.

Lock state moves here from ControlPanel's component-local useState,
keyed by playlist id: one shared flag would have shown playlist B as
clock-locked because the teacher locked playlist A. The accept-then-flip
ordering is preserved, so a refused command never leaves a lock claimed
that no student received.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Menu builders

Pure functions, so the menus can be asserted without rendering Classicy's menu bar.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/playlistMenus.ts`
- Test: `packages/frontend/src/Applications/PlaylistEditor/playlistMenus.test.ts`

**Interfaces:**
- Consumes: `ClassicyMenuItem` from `classicy`; `ADD_ACTIONS`, `AddAction` (Task 3).
- Produces: `documentFileMenu`, `documentEditMenu`, `documentControlMenu`, `windowMenu`, `listFileMenu`, `paletteFileMenu`, each returning one `ClassicyMenuItem`.

- [ ] **Step 1: Write the failing test**

Create `playlistMenus.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/playlistMenus.test.ts`
Expected: FAIL — cannot resolve `./playlistMenus`.

- [ ] **Step 3: Write the implementation**

Create `playlistMenus.ts`:

```ts
import type { ClassicyMenuItem } from "classicy";
import type { AddAction } from "./addActions";
import type { LockState } from "./PlaylistEditorProvider";

/** `{id:"spacer"}` renders as an <hr> in classicy — the library's separator. */
const SPACER: ClassicyMenuItem = { id: "spacer" };

export interface DocumentFileMenuOptions {
	dirty: boolean;
	status: "draft" | "published";
	onOpenList: () => void;
	onSave: () => void;
	onRename: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
	onSetStatus: (status: "draft" | "published") => void;
	quitItem: ClassicyMenuItem;
}

export function documentFileMenu(o: DocumentFileMenuOptions): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_open", title: "Open…", onClickFunc: o.onOpenList },
			SPACER,
			{
				id: "playlist_file_save",
				title: "Save",
				keyboardShortcut: "S",
				disabled: !o.dirty,
				onClickFunc: o.onSave,
			},
			// "Rename…", not "Save As…": it renames in place, and File >
			// Duplicate is what makes a copy.
			{ id: "playlist_file_rename", title: "Rename…", onClickFunc: o.onRename },
			{ id: "playlist_file_duplicate", title: "Duplicate", onClickFunc: o.onDuplicate },
			SPACER,
			{
				id: "playlist_file_status",
				title: "Status",
				menuChildren: [
					{
						id: "playlist_status_draft",
						title: "Draft",
						checked: o.status === "draft",
						onClickFunc: () => o.onSetStatus("draft"),
					},
					{
						id: "playlist_status_published",
						title: "Published",
						checked: o.status === "published",
						onClickFunc: () => o.onSetStatus("published"),
					},
				],
			},
			SPACER,
			{ id: "playlist_file_delete", title: "Delete…", onClickFunc: o.onDelete },
			SPACER,
			o.quitItem,
		],
	};
}

export const MODE_BALLOONS = {
	restrict:
		"Students see only what this playlist includes. Everything else on the desktop is hidden or disabled.",
	annotate:
		"Students keep the full desktop. This playlist only adds notes, jumps, and scheduled events on top of it.",
} as const;

export function documentEditMenu(o: {
	mode: "restrict" | "annotate";
	onSetMode: (mode: "restrict" | "annotate") => void;
	addItems: ClassicyMenuItem[];
}): ClassicyMenuItem {
	return {
		id: "edit",
		title: "Edit",
		menuChildren: [
			{
				id: "playlist_edit_restrict",
				title: "Restrict",
				checked: o.mode === "restrict",
				balloon: { title: "Restrict", content: MODE_BALLOONS.restrict },
				onClickFunc: () => o.onSetMode("restrict"),
			},
			{
				id: "playlist_edit_annotate",
				title: "Annotate",
				checked: o.mode === "annotate",
				balloon: { title: "Annotate", content: MODE_BALLOONS.annotate },
				onClickFunc: () => o.onSetMode("annotate"),
			},
			SPACER,
			{ id: "playlist_edit_add", title: "Add…", menuChildren: o.addItems },
		],
	};
}

/** Build the Edit > Add… children from the shared action list. */
export function addMenuItems(
	actions: AddAction[],
	run: (action: AddAction) => void,
): ClassicyMenuItem[] {
	return actions.map((action) => ({
		id: `playlist_add_${action.id}`,
		title: action.menuTitle,
		icon: action.icon,
		balloon: { title: action.label, content: action.balloon },
		onClickFunc: () => run(action),
	}));
}

export const CLOCK_LOCK_BALLOON =
	"Students following this playlist cannot change the time until you unlock the clock.";
export const CONTENTS_LOCK_BALLOON =
	"Not yet available. This will stop students from switching channels or stations on their own.";

export function documentControlMenu(o: {
	lock: LockState;
	onToggleClock: () => void;
}): ClassicyMenuItem {
	return {
		id: "control",
		title: "Control",
		menuChildren: [
			{
				id: "playlist_control_clock",
				title: "Lock Clock",
				checked: o.lock.clock,
				disabled: o.lock.busy,
				balloon: { title: "Lock Clock", content: CLOCK_LOCK_BALLOON },
				onClickFunc: o.onToggleClock,
			},
			// Content locking is not built. Present so the pair reads as the
			// pair it will become, disabled so it cannot imply an effect it
			// does not have, and deliberately given no handler.
			{
				id: "playlist_control_contents",
				title: "Lock Contents",
				checked: false,
				disabled: true,
				balloon: { title: "Lock Contents", content: CONTENTS_LOCK_BALLOON },
			},
		],
	};
}

export function windowMenu(o: {
	onFocusTools: () => void;
	onFocusList: () => void;
	onFocusDocument: (playlistId: string) => void;
	documents: { playlistId: string; title: string }[];
}): ClassicyMenuItem {
	return {
		id: "window",
		title: "Window",
		menuChildren: [
			{ id: "playlist_window_tools", title: "Tools", onClickFunc: o.onFocusTools },
			SPACER,
			{ id: "playlist_window_list", title: "My Playlists", onClickFunc: o.onFocusList },
			// Rebuilt every render from the open list — never snapshotted — so a
			// window opening or closing shows up in the same render that mounts
			// or unmounts it.
			...o.documents.map((doc) => ({
				id: `playlist_window_doc_${doc.playlistId}`,
				title: doc.title,
				onClickFunc: () => o.onFocusDocument(doc.playlistId),
			})),
		],
	};
}

export function listFileMenu(o: {
	onNew: () => void;
	onOpenList: () => void;
	quitItem: ClassicyMenuItem;
}): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_new", title: "New", onClickFunc: o.onNew },
			{ id: "playlist_file_open", title: "Open", onClickFunc: o.onOpenList },
			SPACER,
			o.quitItem,
		],
	};
}

export function paletteFileMenu(o: {
	onOpenList: () => void;
	quitItem: ClassicyMenuItem;
}): ClassicyMenuItem {
	return {
		id: "file",
		title: "File",
		menuChildren: [
			{ id: "playlist_file_open", title: "Open", onClickFunc: o.onOpenList },
			SPACER,
			o.quitItem,
		],
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/playlistMenus.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/playlistMenus.ts \
        packages/frontend/src/Applications/PlaylistEditor/playlistMenus.test.ts
git commit -m "feat(frontend): build the playlist editor menus as pure functions

File, Edit, Control, and Window as data rather than JSX, so their shape
can be asserted without rendering classicy's menu bar.

Rename… is deliberately not labelled Save As…: it renames in place, and
File > Duplicate is what makes a copy. Lock Contents ships disabled and
handler-less because content locking is not built.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The Tools palette

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/ToolsPalette.tsx`
- Test: `packages/frontend/src/Applications/PlaylistEditor/ToolsPalette.test.tsx`

**Interfaces:**
- Consumes: `ADD_ACTIONS`, `runAddAction` (Task 3); `usePlaylistEditor` (Task 4).
- Produces: `ToolsPalette({ appId, icon, appMenu })`.

- [ ] **Step 1: Write the failing test**

Create `ToolsPalette.test.tsx`:

```tsx
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
			expect(button).toBeDisabled();
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/ToolsPalette.test.tsx`
Expected: FAIL — cannot resolve `./ToolsPalette`.

- [ ] **Step 3: Write the implementation**

Create `ToolsPalette.tsx`:

```tsx
import {
	ClassicyBalloonHelp,
	ClassicyBevelButton,
	ClassicyButtonToolbar,
	ClassicyButtonToolbarGroup,
	type ClassicyMenuItem,
	ClassicyWindow,
} from "classicy";
import { ADD_ACTIONS, type AddAction, runAddAction } from "./addActions";
import { usePlaylistEditor } from "./PlaylistEditorProvider";

/** Three groups; ClassicyButtonToolbar draws the engraved dividers between. */
const GROUPS: AddAction["id"][][] = [
	["media", "file"],
	["app", "settings"],
	["jump", "browser"],
];

/**
 * The floating tool palette. A utility-class window, so it gets the Platinum
 * crosshatch drag region rather than a document title bar.
 *
 * It is `closable={false}` because it is the app's guaranteed menu anchor: with
 * every other window closable and quitting reachable only from File > Quit,
 * closing everything would otherwise leave the menu bar showing a dead
 * window's menus. Collapsing it covers the "get it out of my way" need.
 *
 * `appMenu` is passed ONLY when no document window is open. While a document
 * exists this palette stays menu-less, so clicking it leaves the frontmost
 * document's menus on screen instead of swapping the menu bar out mid-click —
 * classicy's focus reducer assigns Desktop.appMenu only when the newly focused
 * window supplies one.
 */
export function ToolsPalette({
	appId,
	icon,
	appMenu,
}: {
	appId: string;
	icon: string;
	appMenu?: ClassicyMenuItem[];
}) {
	const { activeId, edit, setDialogMode } = usePlaylistEditor();

	const run = (action: AddAction) => {
		if (activeId === null) return;
		runAddAction(action, { playlistId: activeId, edit, setDialogMode });
	};

	return (
		<ClassicyWindow
			id="playlist_editor_tools"
			appId={appId}
			title="Tools"
			icon={icon}
			windowType="utility"
			closable={false}
			resizable={false}
			zoomable={false}
			collapsable={true}
			scrollable={false}
			initialSize={[0, 0]}
			initialPosition={[440, 120]}
			appMenu={appMenu}
		>
			<ClassicyButtonToolbar className="playlistToolsPalette">
				{GROUPS.map((group) => (
					<ClassicyButtonToolbarGroup key={group.join("-")}>
						{group.map((id) => {
							const action = ADD_ACTIONS.find((a) => a.id === id);
							if (!action) return null;
							return (
								<ClassicyBalloonHelp
									key={action.id}
									title={action.label}
									content={action.balloon}
								>
									<ClassicyBevelButton
										icon={action.icon}
										iconAlt={action.label}
										aria-label={action.label}
										disabled={activeId === null}
										onClickFunc={() => run(action)}
									/>
								</ClassicyBalloonHelp>
							);
						})}
					</ClassicyButtonToolbarGroup>
				))}
			</ClassicyButtonToolbar>
		</ClassicyWindow>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/ToolsPalette.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/ToolsPalette.tsx \
        packages/frontend/src/Applications/PlaylistEditor/ToolsPalette.test.tsx
git commit -m "feat(frontend): add the playlist Tools palette

A utility-class window of six icon-only bevel buttons with balloon help,
grouped so the toolbar draws its engraved dividers between them.

The palette acts on the last-focused document and disables every tool
when none is frontmost. It is non-closable because it is the app's
guaranteed menu anchor, and it supplies an appMenu only when no document
window is open, so clicking it never swaps the menu bar mid-click.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The Rename dialog

`ClassicyAlert` cannot host a text field — its contract is "only an icon, text, and buttons". This follows `TimeMachine/BookmarkDialog.tsx` instead.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/RenameDialog.tsx`
- Test: `packages/frontend/src/Applications/PlaylistEditor/RenameDialog.test.tsx`

**Interfaces:**
- Produces: `RenameDialog({ appId, icon, initialTitle, onRename, onCancel })`, `RenameDialogForm`, and a new `{ type: "renamed"; title: string }` case on `EditorAction`.

**Why a new reducer action:** Rename writes to the server immediately —
`updatePlaylist` accepts a **partial** patch, so it sends `{ title }` alone and
never persists unsaved definition edits as a side effect. The local state must
therefore adopt the new title *without* becoming dirty, which `setTitle` (which
always sets `dirty: true`) cannot express.

- [ ] **Step 0: Add the `renamed` action**

Append to `EditorAction` in `editorState.ts`:

```ts
	| { type: "renamed"; title: string }
```

And to `editorReducer`'s switch, immediately after the `setTitle` case:

```ts
		case "renamed":
			// Rename has ALREADY written the title to the server, so unlike
			// setTitle this must not mark the document dirty — that would make
			// the next Save re-send the whole definition, including edits the
			// user has not chosen to save yet.
			return { ...state, title: action.title };
```

Append to `editorState.test.ts`:

```ts
	it("renamed adopts the title without marking the document dirty", () => {
		const clean = initialEditorState({
			id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
			definition: { version: 1, mode: "annotate", entries: [] },
		});

		const after = editorReducer(clean, { type: "renamed", title: "Lesson Two" });

		expect(after.title).toBe("Lesson Two");
		expect(after.dirty).toBe(false);
	});
```

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/editorState.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 1: Write the failing test**

Create `RenameDialog.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenameDialogForm } from "./RenameDialog";

afterEach(cleanup);

const field = () => screen.getByLabelText("Title");

describe("RenameDialogForm", () => {
	it("starts from the current title and renames to the edited value", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		expect(field()).toHaveValue("Lesson");
		fireEvent.change(field(), { target: { value: "Lesson Two" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expect(onRename).toHaveBeenCalledWith("Lesson Two");
	});

	// A playlist with a blank title is unidentifiable in the list window.
	it("refuses an empty or whitespace-only title", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		fireEvent.change(field(), { target: { value: "   " } });

		expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect(onRename).not.toHaveBeenCalled();
	});

	it("trims the saved title", () => {
		const onRename = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={vi.fn()} />);

		fireEvent.change(field(), { target: { value: "  Padded  " } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));

		expect(onRename).toHaveBeenCalledWith("Padded");
	});

	it("cancel reports nothing", () => {
		const onRename = vi.fn();
		const onCancel = vi.fn();
		render(<RenameDialogForm initialTitle="Lesson" onRename={onRename} onCancel={onCancel} />);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onCancel).toHaveBeenCalled();
		expect(onRename).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/RenameDialog.test.tsx`
Expected: FAIL — cannot resolve `./RenameDialog`.

- [ ] **Step 3: Write the implementation**

Create `RenameDialog.tsx`:

```tsx
import { ClassicyButton, ClassicyWindow } from "classicy";
import { useState } from "react";

export interface RenameDialogFormProps {
	initialTitle: string;
	onRename: (title: string) => void;
	onCancel: () => void;
}

/**
 * Split from the window shell (the same shape as TimeMachine's
 * BookmarkDialog/BookmarkDialogForm) so the form is testable without classicy
 * window chrome.
 *
 * This is a window rather than a ClassicyAlert because an alert's contract is
 * explicitly "only an icon, text, and buttons — no other controls", and this
 * needs a text field.
 */
export function RenameDialogForm({ initialTitle, onRename, onCancel }: RenameDialogFormProps) {
	const [title, setTitle] = useState(initialTitle);
	const trimmed = title.trim();

	return (
		<div className="playlistRenameDialog">
			<label>
				Title
				<input
					aria-label="Title"
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
				/>
			</label>
			<ClassicyButton
				isDefault={true}
				// A blank title would leave the playlist unidentifiable in the
				// list window and in the Window menu.
				disabled={trimmed === ""}
				onClickFunc={() => {
					if (trimmed !== "") onRename(trimmed);
				}}
			>
				Rename
			</ClassicyButton>
			<ClassicyButton onClickFunc={onCancel}>Cancel</ClassicyButton>
		</div>
	);
}

export function RenameDialog({
	appId,
	icon,
	...formProps
}: RenameDialogFormProps & { appId: string; icon: string }) {
	return (
		<ClassicyWindow
			id="playlist_rename_dialog"
			appId={appId}
			title="Rename Playlist"
			icon={icon}
			modal={true}
			closable={true}
			resizable={false}
			zoomable={false}
			collapsable={false}
			scrollable={false}
			initialSize={[300, 0]}
			initialPosition={[400, 240]}
			onCloseFunc={formProps.onCancel}
		>
			<RenameDialogForm {...formProps} />
		</ClassicyWindow>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/RenameDialog.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/RenameDialog.tsx \
        packages/frontend/src/Applications/PlaylistEditor/RenameDialog.test.tsx
git commit -m "feat(frontend): add the playlist Rename dialog

File > Rename… replaces the title field the removed header carried. A
modal window rather than a ClassicyAlert, because an alert's contract is
only an icon, text, and buttons — and this needs a text field.

Form split from the window shell like TimeMachine's BookmarkDialog, so
it is testable without window chrome. Blank titles are refused: they
would leave a playlist unidentifiable in the list and the Window menu.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Strip the header and add bar from the editor body

`playlistEditorBody` becomes the window's first child. Everything the header carried now lives in menus built in Task 5.

**Files:**
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.test.tsx`

**Interfaces:**
- Consumes: `EditorState`, `EditorAction`.
- Produces: `PlaylistEditorMain({ state, edit })` — a pure body. Every previous prop (`record`, `onBack`, `onDirtyChange`, `closeRequested`, `onCancelClose`, `onQuit`) is gone; the window owns those concerns now.

- [ ] **Step 1: Rewrite the test to describe the body alone**

Replace the whole of `PlaylistEditorMain.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorState } from "./editorState";
import { PlaylistEditorMain } from "./PlaylistEditorMain";

vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: { video: [], audio: [] } }),
}));

afterEach(cleanup);

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

describe("PlaylistEditorMain", () => {
	// The header and add bar moved to the menu bar and the Tools palette; the
	// body must not reintroduce chrome above the entry tree.
	it("renders no title field, mode radios, status picker, or Add buttons", () => {
		render(<PlaylistEditorMain state={state()} edit={vi.fn()} />);

		expect(screen.queryByLabelText("Title")).toBeNull();
		expect(screen.queryByLabelText("Status")).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("lists entries grouped by kind", () => {
		render(
			<PlaylistEditorMain
				state={state({
					entries: [{ uid: "e1", entry: { kind: "browser", url: "http://example.com", at: "" } }],
				})}
				edit={vi.fn()}
			/>,
		);

		expect(screen.getByText("Browser")).toBeInTheDocument();
		expect(screen.getByText(/example\.com/)).toBeInTheDocument();
	});

	it("routes an entry removal through the injected dispatcher", async () => {
		const edit = vi.fn();
		render(
			<PlaylistEditorMain
				state={state({ entries: [{ uid: "e1", entry: { kind: "jump", at: "", to: "" } }] })}
				edit={edit}
			/>,
		);

		screen.getByRole("button", { name: "Remove" }).click();

		expect(edit).toHaveBeenCalledWith("p1", { type: "removeEntry", uid: "e1" });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditorMain.test.tsx`
Expected: FAIL — the component still takes `record` and imports the deleted `SaveBar`.

- [ ] **Step 3: Rewrite the component**

Replace the whole of `PlaylistEditorMain.tsx`:

```tsx
import { ClassicyTree, type ClassicyTreeNode } from "classicy";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { type EditorAction, type EditorEntry, type EditorState, utcIsoToDisplayWallClock } from "./editorState";
import { EntryForm } from "./EntryForm";
import { PlaylistTimeline } from "./PlaylistTimeline";

const KIND_BRANCHES: [PlaylistEntry["kind"], string][] = [
	["media", "Media"], ["app", "Apps"], ["settings", "Settings"],
	["file", "Files"], ["jump", "Jumps"], ["browser", "Browser"],
];

function entrySummary(e: EditorEntry): string {
	const t = (iso: string) => {
		const w = utcIsoToDisplayWallClock(iso);
		return `${String(w.getHours()).padStart(2, "0")}:${String(w.getMinutes()).padStart(2, "0")}`;
	};
	switch (e.entry.kind) {
		case "media": return `${e.entry.app.toUpperCase()} · ${e.entry.itemId}`;
		case "app": return `Disable ${e.entry.appId}`;
		case "settings": return `Settings ${e.entry.appId}`;
		case "file": return `${e.entry.path.split(":").pop()}${e.entry.at ? ` @ ${t(e.entry.at)}` : ""}`;
		case "jump": return `Jump ${e.entry.at ? t(e.entry.at) : "?"} → ${e.entry.to ? t(e.entry.to) : "?"}`;
		case "browser": return `${e.entry.url}${e.entry.at ? ` @ ${t(e.entry.at)}` : ""}`;
	}
}

/**
 * The editing surface, and nothing else.
 *
 * The header (title, mode, status, Save) and the Add bar are gone: they live in
 * the File/Edit menus and the Tools palette now, so playlistEditorBody is the
 * window's first child. This component holds no state — its owning document
 * window passes the playlist's slice of the keyed store and a dispatcher.
 */
export function PlaylistEditorMain({
	state,
	edit,
}: {
	state: EditorState;
	edit: (playlistId: string, action: EditorAction) => void;
}) {
	const dispatch = (action: EditorAction) => edit(state.playlistId, action);
	const selected = state.entries.find((e) => e.uid === state.selectedUid) ?? null;

	const nodes: ClassicyTreeNode[] = KIND_BRANCHES.map(([kind, label]) => ({
		id: `branch-${kind}`,
		label,
		defaultOpen: true,
		children: state.entries
			.filter((e) => e.entry.kind === kind)
			.map((e) => ({
				id: e.uid,
				label: entrySummary(e),
				buttons: [
					{ label: "Edit", onClickFunc: () => dispatch({ type: "select", uid: e.uid }) },
					{ label: "Remove", onClickFunc: () => dispatch({ type: "removeEntry", uid: e.uid }) },
				],
			})),
	})).filter((b) => (b.children?.length ?? 0) > 0);

	return (
		<div className="playlistEditorMain">
			<div className="playlistEditorBody">
				<div className="playlistEditorEntries">
					<ClassicyTree nodes={nodes} />
				</div>
				{selected && (
					<EntryForm
						key={selected.uid}
						value={selected}
						onChange={(entry) => dispatch({ type: "updateEntry", uid: selected.uid, entry })}
					/>
				)}
			</div>

			<PlaylistTimeline
				entries={state.entries}
				selectedUid={state.selectedUid}
				onSelect={(uid) => dispatch({ type: "select", uid })}
			/>
		</div>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditorMain.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.tsx \
        packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.test.tsx
git commit -m "refactor(frontend): reduce the playlist editor body to the body

Deletes playlistEditorHeader and playlistEditorAddBar. Title, mode,
status, and Save now live in the File and Edit menus; the six Add
buttons live in the Tools palette. playlistEditorBody is consequently
the window's first child, which was the point.

The component also stops owning state: its window passes the playlist's
slice of the keyed store and a dispatcher, so N windows can edit N
playlists without N copies of this component fighting over one reducer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The document window

One playlist's window: its four menus, its alerts, its dirty-close, and the body.

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistDocumentWindow.tsx`
- Test: `packages/frontend/src/Applications/PlaylistEditor/PlaylistDocumentWindow.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `PlaylistDocumentWindow({ playlistId, index, appId, appIcon, quitItem, onFocusTools, onFocusList, onFocusDocument, onOpenList })`.

- [ ] **Step 1: Write the failing test**

Create `PlaylistDocumentWindow.test.tsx`:

```tsx
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyMenuItem } from "classicy";
import { PlaylistDocumentWindow } from "./PlaylistDocumentWindow";
import type { EditorState } from "./editorState";

const menus = vi.hoisted(() => ({ current: [] as ClassicyMenuItem[] }));
const closeFns = vi.hoisted(() => ({ current: {} as Record<string, () => void> }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyWindow: ({ children, id, appMenu, onCloseFunc, title }: {
		children?: React.ReactNode; id?: string; appMenu?: ClassicyMenuItem[];
		onCloseFunc?: () => void; title?: string;
	}) => {
		if (appMenu) menus.current = appMenu;
		if (id && onCloseFunc) closeFns.current[id] = onCloseFunc;
		return <div data-testid={`win-${id}`} data-title={title}>{children}</div>;
	},
	ClassicyAlert: ({ label, buttons }: {
		label?: string; buttons?: { id: string; label: string; onClick?: () => void }[];
	}) => (
		<div data-testid="alert">
			<p>{label}</p>
			{buttons?.map((b) => (
				<button key={b.id} onClick={b.onClick}>{b.label}</button>
			))}
		</div>
	),
}));

vi.mock("./PlaylistEditorMain", () => ({
	PlaylistEditorMain: () => <div data-testid="body" />,
}));

const saveMock = vi.fn();
vi.mock("./useSavePlaylist", () => ({
	useSavePlaylist: () => ({
		prompt: { kind: "none" }, save: saveMock, confirmSave: vi.fn(),
		dismiss: vi.fn(), saving: false,
	}),
}));

const state = (over: Partial<EditorState> = {}): EditorState => ({
	playlistId: "p1", title: "Lesson", mode: "annotate", status: "draft",
	entries: [], selectedUid: null, dirty: false, nextUid: 1, ...over,
});

const ctx = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));
const toggleClockLock = vi.fn().mockResolvedValue(undefined);
const closePlaylist = vi.fn();
vi.mock("./PlaylistEditorProvider", () => ({
	usePlaylistEditor: () => ctx.current,
}));

const renderWindow = (over: Partial<EditorState> = {}) => {
	ctx.current = {
		states: { p1: state(over) },
		openIds: ["p1"],
		activeId: "p1",
		locks: { p1: { clock: false, busy: false } },
		lockError: null,
		edit: vi.fn(),
		setActive: vi.fn(),
		closePlaylist,
		toggleClockLock,
		dismissLockError: vi.fn(),
		openPlaylist: vi.fn(),
		setDialogMode: vi.fn(),
		dialogMode: null,
	};
	return render(
		<PlaylistDocumentWindow
			playlistId="p1"
			index={0}
			appId="PlaylistEditor.app"
			appIcon="i.png"
			quitItem={{ id: "quit", title: "Quit" }}
			onFocusTools={vi.fn()}
			onFocusList={vi.fn()}
			onFocusDocument={vi.fn()}
			onOpenList={vi.fn()}
		/>,
	);
};

const menu = (id: string) => {
	const found = menus.current.find((m) => m.id === id);
	if (!found) throw new Error(`no ${id} menu`);
	return found;
};
const item = (menuId: string, itemId: string) => {
	const found = menu(menuId).menuChildren?.find((c) => c.id === itemId);
	if (!found) throw new Error(`no ${itemId}`);
	return found;
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistDocumentWindow", () => {
	it("titles the window with the playlist title", () => {
		renderWindow();
		expect(screen.getByTestId("win-playlist_doc_p1").dataset.title).toBe("Lesson");
	});

	it("carries File, Edit, Control, and Window menus", () => {
		renderWindow();
		expect(menus.current.map((m) => m.id)).toEqual(["file", "edit", "control", "window"]);
	});

	// The Control menu belongs to this window, so it must act on THIS
	// playlist — never on whichever document happens to be active.
	it("locks the clock for its own playlist", async () => {
		renderWindow();
		act(() => item("control", "playlist_control_clock").onClickFunc?.());
		await waitFor(() => expect(toggleClockLock).toHaveBeenCalledWith("p1"));
	});

	it("closes without a prompt when the document is clean", () => {
		renderWindow({ dirty: false });
		act(() => closeFns.current.playlist_doc_p1?.());
		expect(closePlaylist).toHaveBeenCalledWith("p1");
		expect(screen.queryByTestId("alert")).toBeNull();
	});

	it("asks before closing a dirty document, and does not close on its own", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());

		expect(closePlaylist).not.toHaveBeenCalled();
		expect(screen.getByTestId("alert")).toHaveTextContent('Save changes to "Lesson" before closing?');
	});

	it("Don't Save closes the dirty document without writing", () => {
		renderWindow({ dirty: true });
		act(() => closeFns.current.playlist_doc_p1?.());

		screen.getByRole("button", { name: "Don't Save" }).click();

		expect(closePlaylist).toHaveBeenCalledWith("p1");
		expect(saveMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistDocumentWindow.test.tsx`
Expected: FAIL — cannot resolve `./PlaylistDocumentWindow`.

- [ ] **Step 3: Write the implementation**

Create `PlaylistDocumentWindow.tsx`:

```tsx
import { ClassicyAlert, type ClassicyMenuItem, ClassicyWindow, useAppManager } from "classicy";
import { useEffect, useMemo, useState } from "react";
import { deletePlaylist, duplicatePlaylist, getPlaylist } from "../../Providers/Auth/playlistApi";
import { ADD_ACTIONS, type AddAction, runAddAction } from "./addActions";
import {
	addMenuItems, documentControlMenu, documentEditMenu, documentFileMenu, windowMenu,
} from "./playlistMenus";
import { PlaylistEditorMain } from "./PlaylistEditorMain";
import { usePlaylistEditor } from "./PlaylistEditorProvider";
import { RenameDialog } from "./RenameDialog";
import { useSavePlaylist } from "./useSavePlaylist";

/** Cascade so a second window does not land exactly on the first. */
const CASCADE = 24;

type Pending = null | { kind: "close" } | { kind: "delete" };

export function PlaylistDocumentWindow({
	playlistId, index, appId, appIcon, quitItem,
	onFocusTools, onFocusList, onFocusDocument, onOpenList,
}: {
	playlistId: string;
	index: number;
	appId: string;
	appIcon: string;
	quitItem: ClassicyMenuItem;
	onFocusTools: () => void;
	onFocusList: () => void;
	onFocusDocument: (playlistId: string) => void;
	onOpenList: () => void;
}) {
	const {
		states, openIds, locks, lockError, edit, setActive, closePlaylist,
		openPlaylist, toggleClockLock, dismissLockError, setDialogMode,
	} = usePlaylistEditor();
	const state = states[playlistId];
	const windowId = `playlist_doc_${playlistId}`;

	const [pending, setPending] = useState<Pending>(null);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { prompt, save, confirmSave, dismiss } = useSavePlaylist(
		state,
		() => edit(playlistId, { type: "markSaved" }),
	);

	// Claim the palette's target whenever this window is the focused one.
	// Focusing the PALETTE does not run this, which is exactly right: a
	// palette click must keep acting on the document the user was last in.
	const focused = useAppManager(
		(s) =>
			s.System.Manager.Applications.apps[appId]?.windows.find((w) => w.id === windowId)
				?.focused ?? false,
	);
	useEffect(() => {
		if (focused) setActive(playlistId);
	}, [focused, playlistId, setActive]);

	const runAdd = (action: AddAction) =>
		runAddAction(action, { playlistId, edit, setDialogMode });

	const appMenu = useMemo<ClassicyMenuItem[]>(
		() => [
			documentFileMenu({
				dirty: state.dirty,
				status: state.status,
				onOpenList,
				onSave: save,
				onRename: () => setRenaming(true),
				// Rename writes the title ALONE. updatePlaylist takes a partial
				// patch, so omitting `definition` means renaming cannot smuggle
				// the document's unsaved entry edits into a save the user did
				// not ask for.
				onDuplicate: () => {
					void duplicatePlaylist(playlistId)
						.then((copy) => getPlaylist(copy.id))
						.then(openPlaylist)
						.catch((e) => setError(e instanceof Error ? e.message : "Couldn't duplicate."));
				},
				onDelete: () => setPending({ kind: "delete" }),
				onSetStatus: (status) => edit(playlistId, { type: "setStatus", status }),
				quitItem,
			}),
			documentEditMenu({
				mode: state.mode,
				onSetMode: (mode) => edit(playlistId, { type: "setMode", mode }),
				addItems: addMenuItems(ADD_ACTIONS, runAdd),
			}),
			documentControlMenu({
				lock: locks[playlistId] ?? { clock: false, busy: false },
				onToggleClock: () => void toggleClockLock(playlistId),
			}),
			windowMenu({
				onFocusTools,
				onFocusList,
				onFocusDocument,
				documents: openIds.map((id) => ({ playlistId: id, title: states[id]?.title ?? "" })),
			}),
		],
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[state, locks, openIds, states, playlistId, quitItem],
	);

	if (!state) return null;

	const alert = (() => {
		if (lockError?.playlistId === playlistId) {
			return (
				<ClassicyAlert
					id={`${windowId}_lock_error`} appId={appId} alertType="stop"
					title="Control" label={lockError.message}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismissLockError }]}
					onClose={dismissLockError}
				/>
			);
		}
		if (error) {
			return (
				<ClassicyAlert
					id={`${windowId}_error`} appId={appId} alertType="stop"
					title="Playlists" label={error}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: () => setError(null) }]}
					onClose={() => setError(null)}
				/>
			);
		}
		if (pending?.kind === "delete") {
			return (
				<ClassicyAlert
					id={`${windowId}_delete`} appId={appId} alertType="caution"
					title="Playlists" label={`Delete "${state.title}"? This cannot be undone.`}
					// HIG: on an action that risks data loss the SAFE button is
					// the default, so Return dismisses rather than destroys.
					defaultButtonId="cancel"
					buttons={[
						{ id: "cancel", label: "Cancel", role: "cancel", onClick: () => setPending(null) },
						{
							id: "delete", label: "Delete", role: "normal",
							onClick: () => {
								void deletePlaylist(playlistId)
									.then(() => closePlaylist(playlistId))
									.catch((e) => {
										setPending(null);
										setError(e instanceof Error ? e.message : "Couldn't delete.");
									});
							},
						},
					]}
					onClose={() => setPending(null)}
				/>
			);
		}
		if (pending?.kind === "close") {
			return (
				<ClassicyAlert
					id={`${windowId}_close`} appId={appId} alertType="caution"
					title="Playlists" label={`Save changes to "${state.title}" before closing?`}
					buttons={[
						{ id: "save", label: "Save", role: "default", onClick: save },
						{
							id: "dont", label: "Don't Save", role: "normal",
							onClick: () => { setPending(null); closePlaylist(playlistId); },
						},
						{ id: "cancel", label: "Cancel", role: "cancel", onClick: () => setPending(null) },
					]}
					onClose={() => setPending(null)}
				/>
			);
		}
		if (prompt.kind === "message") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_msg`} appId={appId} alertType="stop"
					title="Playlists" label={prompt.message}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismiss }]}
					onClose={dismiss}
				/>
			);
		}
		if (prompt.kind === "dropped") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_dropped`} appId={appId} alertType="stop"
					title="Playlists"
					label="Some entries are incomplete and would be lost — fix them before saving."
					message={<ul>{prompt.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
					buttons={[{ id: "ok", label: "OK", role: "default", onClick: dismiss }]}
					onClose={dismiss}
				/>
			);
		}
		if (prompt.kind === "warnings") {
			return (
				<ClassicyAlert
					id={`${windowId}_save_warn`} appId={appId} alertType="caution"
					title="Playlists" label="This playlist has warnings."
					message={<ul>{prompt.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
					buttons={[
						{ id: "anyway", label: "Save Anyway", role: "default", onClick: confirmSave },
						{ id: "keep", label: "Keep Editing", role: "cancel", onClick: dismiss },
					]}
					onClose={dismiss}
				/>
			);
		}
		return null;
	})();

	return (
		<>
			<ClassicyWindow
				id={windowId}
				appId={appId}
				title={state.title}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				collapsable={false}
				scrollable={true}
				initialSize={[640, 480]}
				initialPosition={[140 + index * CASCADE, 90 + index * CASCADE]}
				appMenu={appMenu}
				onCloseFunc={() => {
					if (!state.dirty) {
						closePlaylist(playlistId);
						return;
					}
					setPending({ kind: "close" });
				}}
			>
				<PlaylistEditorMain state={state} edit={edit} />
			</ClassicyWindow>
			{alert}
			{renaming && (
				<RenameDialog
					appId={appId}
					icon={appIcon}
					initialTitle={state.title}
					onRename={(title) => {
						setRenaming(false);
						// Title-only patch: updatePlaylist takes a partial, so
						// renaming never persists unsaved definition edits as a
						// side effect. `renamed` (not setTitle) keeps the
						// document's dirty flag untouched, since the title it
						// carries is already saved.
						void updatePlaylist(playlistId, { title })
							.then(() => edit(playlistId, { type: "renamed", title }))
							.catch((e) => setError(e instanceof Error ? e.message : "Couldn't rename."));
					}}
					onCancel={() => setRenaming(false)}
				/>
			)}
		</>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistDocumentWindow.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/PlaylistDocumentWindow.tsx \
        packages/frontend/src/Applications/PlaylistEditor/PlaylistDocumentWindow.test.tsx
git commit -m "feat(frontend): give each open playlist its own window

One document window per playlist, carrying File, Edit, Control, and
Window menus, its own save/close/delete alerts, and the Rename dialog.

The Control menu acts on the window's own playlist rather than on the
active one — a menu belongs to the window it drops from, so there is no
way to lock the wrong classroom. Dirty close asks before closing and
never closes on its own; Delete deliberately skips that prompt, since
offering to save a document you are destroying is incoherent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Rewire the app shell and delete the Control window

**Files:**
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistList.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.test.tsx`
- Delete: `ControlPanel.tsx`, `ControlPanel.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: the finished `PlaylistEditor` app.

- [ ] **Step 1: Delete the Control window's component**

```bash
git rm packages/frontend/src/Applications/PlaylistEditor/ControlPanel.tsx \
       packages/frontend/src/Applications/PlaylistEditor/ControlPanel.test.tsx
```

Its behavioral cases are not lost — they were ported to `PlaylistEditorProvider.test.tsx` (accept-then-flip, refusal handling, per-playlist isolation) in Task 4 and to `playlistMenus.test.ts` (checkmark, busy-disable, disabled Lock Contents) in Task 5.

- [ ] **Step 2: Write the failing test**

Replace the whole of `PlaylistEditor.test.tsx`:

```tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClassicyMenuItem } from "classicy";
import { PlaylistEditor } from "./PlaylistEditor";

const dispatchMock = vi.fn();
const windows = vi.hoisted(() => ({ current: {} as Record<string, { appMenu?: ClassicyMenuItem[] }> }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children, id, appMenu }: {
		children?: React.ReactNode; id?: string; appMenu?: ClassicyMenuItem[];
	}) => {
		if (id) windows.current[id] = { appMenu };
		return <div data-testid={`win-${id}`}>{children}</div>;
	},
	useAppManagerDispatch: () => dispatchMock,
	useAppManager: () => false,
}));

const mockAuth = vi.hoisted(() => ({ status: "signedIn" as string, user: { id: "u1" } as { id: string } | null }));
vi.mock("../../Providers/Auth/AuthContext", () => ({ useAuth: () => mockAuth }));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: { video: [], audio: [] } }),
}));

const testRecord = {
	id: "p1", title: "Lesson", status: "draft", date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "annotate", entries: [] },
};
vi.mock("./PlaylistList", () => ({
	PlaylistList: ({ onOpen }: { onOpen: (r: unknown) => void }) => (
		<button onClick={() => onOpen(testRecord)}>Mock Open</button>
	),
}));
vi.mock("./PlaylistEditorMain", () => ({ PlaylistEditorMain: () => <div data-testid="body" /> }));

afterEach(() => {
	cleanup();
	windows.current = {};
	mockAuth.status = "signedIn";
	vi.clearAllMocks();
});

describe("PlaylistEditor", () => {
	it("shows the list and the Tools palette once signed in", () => {
		render(<PlaylistEditor />);
		expect(screen.getByTestId("win-playlist_editor_list")).toBeInTheDocument();
		expect(screen.getByTestId("win-playlist_editor_tools")).toBeInTheDocument();
	});

	it("shows only the gate while signed out — no list, no palette", () => {
		mockAuth.status = "anonymous";
		render(<PlaylistEditor />);

		expect(screen.getByTestId("win-playlist_editor_gate")).toBeInTheDocument();
		expect(screen.queryByTestId("win-playlist_editor_list")).toBeNull();
		expect(screen.queryByTestId("win-playlist_editor_tools")).toBeNull();
	});

	it("opens a playlist into its own window, keeping the list open", () => {
		render(<PlaylistEditor />);

		act(() => screen.getByRole("button", { name: "Mock Open" }).click());

		expect(screen.getByTestId("win-playlist_doc_p1")).toBeInTheDocument();
		expect(screen.getByTestId("win-playlist_editor_list")).toBeInTheDocument();
	});

	// With no document open the palette is the only menu-bearing window; once
	// one exists it must go menu-less so clicking it does not swap the bar.
	it("gives the palette a menu only while no document window is open", () => {
		render(<PlaylistEditor />);
		expect(windows.current.playlist_editor_tools.appMenu).toBeDefined();

		act(() => screen.getByRole("button", { name: "Mock Open" }).click());

		expect(windows.current.playlist_editor_tools.appMenu).toBeUndefined();
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditor.test.tsx`
Expected: FAIL — no `playlist_editor_tools` window; `playlist_editor_main` still rendered.

- [ ] **Step 4: Rewrite `PlaylistEditor.tsx`**

Replace the whole file:

```tsx
import {
	ClassicyApp, ClassicyButton, ClassicyFileOpenDialog, type ClassicyFileOpenSelection,
	ClassicyIcons, ClassicyWindow, desktopVolume, fileSystemVolume, quitAppHelper,
	quitMenuItemHelper, registerClassicyIcons, useAppManagerDispatch, useClassicyFileSystem,
} from "classicy";
import { useCallback, useMemo, useRef } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import { createPlaylist } from "../../Providers/Auth/playlistApi";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import { createDirectusVolume, MEDIA_FILE_TYPES } from "./directusVolume";
import { selectionsToEntries } from "./editorState";
import { listFileMenu, paletteFileMenu, windowMenu } from "./playlistMenus";
import { PlaylistDocumentWindow } from "./PlaylistDocumentWindow";
import { PlaylistEditorProvider, usePlaylistEditor } from "./PlaylistEditorProvider";
import { PlaylistList } from "./PlaylistList";
import { ToolsPalette } from "./ToolsPalette";
import appIconPng from "./app.png";

const appId = "PlaylistEditor.app";
const appName = "Playlists";
export const GATE_MESSAGE = "You must be signed in to create playlists.";

const ICONS = registerClassicyIcons({
	applications: { ...ClassicyIcons.applications, playlistEditor: { app: appIconPng } },
});
const appIcon = ICONS.applications.playlistEditor.app;

const LIST_WINDOW = "playlist_editor_list";
const TOOLS_WINDOW = "playlist_editor_tools";

function PlaylistEditorContent() {
	const { user } = useAuth();
	const dispatch = useAppManagerDispatch();
	const {
		states, openIds, activeId, dialogMode, openPlaylist, edit, setDialogMode,
	} = usePlaylistEditor();

	const fs = useClassicyFileSystem();
	const { sources } = useMediaStream();
	// The volume's closures read this ref, not the render's `sources`, so they
	// always see the live lists even though the volume is created only once.
	const sourcesRef = useRef(sources);
	sourcesRef.current = sources;

	const localVolumes = useMemo(
		() => [desktopVolume(fs), fileSystemVolume(fs, "Macintosh HD")],
		[fs],
	);
	const archiveVolume = useMemo(
		() =>
			createDirectusVolume({
				tvSlugs: () => sourcesRef.current.video,
				radioSlugs: () => sourcesRef.current.audio,
			}),
		// identity must stay stable for the dialog's per-folder cache
		[],
	);

	// Open THEN focus: ClassicyWindowFocus does not clear `closed`, so focusing
	// a closed window would do nothing visible.
	const reveal = useCallback(
		(windowId: string) => {
			dispatch({ type: "ClassicyWindowOpen", app: { id: appId }, window: { id: windowId } });
			dispatch({ type: "ClassicyWindowFocus", app: { id: appId }, window: { id: windowId } });
		},
		[dispatch],
	);

	const quitItem = useMemo(() => quitMenuItemHelper(appId, appName, appIcon), []);

	// File > New creates a playlist and opens it, matching the list window's
	// own New button — focusing the list instead would make the item a no-op
	// whenever the list was already frontmost.
	const onNew = useCallback(() => {
		void createPlaylist("Untitled Playlist", { version: 1, mode: "annotate", entries: [] })
			.then(openPlaylist)
			.catch(() => {
				/* the list window surfaces its own errors; nothing to add here */
			});
	}, [openPlaylist]);

	const onFocusList = useCallback(() => reveal(LIST_WINDOW), [reveal]);
	const onFocusTools = useCallback(() => reveal(TOOLS_WINDOW), [reveal]);
	const onFocusDocument = useCallback(
		(playlistId: string) => reveal(`playlist_doc_${playlistId}`),
		[reveal],
	);

	const sharedWindowMenu = useMemo(
		() =>
			windowMenu({
				onFocusTools, onFocusList, onFocusDocument,
				documents: openIds.map((id) => ({ playlistId: id, title: states[id]?.title ?? "" })),
			}),
		[onFocusTools, onFocusList, onFocusDocument, openIds, states],
	);

	const listMenu = useMemo(
		() => [
			listFileMenu({ onNew, onOpenList: onFocusList, quitItem }),
			sharedWindowMenu,
		],
		[onNew, onFocusList, quitItem, sharedWindowMenu],
	);

	// The menu of last resort. With every window closable and quitting reachable
	// only from File > Quit, closing everything would otherwise leave the menu
	// bar showing a dead window's menus and no way to quit. Supplied ONLY when
	// no document window is open, so clicking the palette during normal use
	// leaves the frontmost document's menus alone.
	const paletteMenu = useMemo(
		() =>
			openIds.length === 0
				? [paletteFileMenu({ onOpenList: onFocusList, quitItem }), sharedWindowMenu]
				: undefined,
		[openIds.length, onFocusList, quitItem, sharedWindowMenu],
	);

	const handleDialogOpen = (selections: ClassicyFileOpenSelection[]) => {
		if (activeId) {
			edit(activeId, { type: "addEntries", entries: selectionsToEntries(selections) });
		}
		setDialogMode(null);
	};

	return (
		<>
			<ClassicyWindow
				id={LIST_WINDOW}
				appId={appId}
				title={appName}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				collapsable={false}
				scrollable={true}
				initialSize={[420, 400]}
				initialPosition={[100, 80]}
				appMenu={listMenu}
			>
				<PlaylistList meId={user?.id ?? ""} onOpen={openPlaylist} />
			</ClassicyWindow>

			{openIds.map((playlistId, index) => (
				<PlaylistDocumentWindow
					key={playlistId}
					playlistId={playlistId}
					index={index}
					appId={appId}
					appIcon={appIcon}
					quitItem={quitItem}
					onFocusTools={onFocusTools}
					onFocusList={onFocusList}
					onFocusDocument={onFocusDocument}
					onOpenList={onFocusList}
				/>
			))}

			<ToolsPalette appId={appId} icon={appIcon} appMenu={paletteMenu} />

			<ClassicyFileOpenDialog
				id="playlist_editor_open"
				appId={appId}
				open={dialogMode !== null}
				title={dialogMode === "media" ? "Add Media" : "Add File"}
				volumes={dialogMode === "media" ? [...localVolumes, archiveVolume] : localVolumes}
				selectionMode={dialogMode === "media" ? "multi" : "single"}
				fileTypeFilters={
					dialogMode === "media"
						? [
								{ label: "All Media", types: Object.values(MEDIA_FILE_TYPES) },
								{ label: "TV Channels", types: [MEDIA_FILE_TYPES.tv] },
								{ label: "Radio Stations", types: [MEDIA_FILE_TYPES.radio] },
								{ label: "News", types: [MEDIA_FILE_TYPES.news] },
								{ label: "Flights", types: [MEDIA_FILE_TYPES.flight] },
							]
						: undefined
				}
				onOpenFunc={handleDialogOpen}
				onCancelFunc={() => setDialogMode(null)}
			/>
		</>
	);
}

export function PlaylistEditor() {
	const { status } = useAuth();
	const dispatch = useAppManagerDispatch();
	const quit = () => dispatch(quitAppHelper(appId, appName, appIcon));

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow={LIST_WINDOW}
			addSystemMenu={false}
		>
			{status === "anonymous" && (
				<ClassicyWindow
					id="playlist_editor_gate"
					appId={appId}
					title={appName}
					icon={appIcon}
					modal={true}
					closable={true}
					resizable={false}
					zoomable={false}
					collapsable={false}
					scrollable={false}
					initialSize={[320, 0]}
					initialPosition={[260, 200]}
					onCloseFunc={quit}
				>
					<div className="playlistEditorGate">
						<p>{GATE_MESSAGE}</p>
						<ClassicyButton isDefault={true} onClickFunc={quit}>
							Quit
						</ClassicyButton>
					</div>
				</ClassicyWindow>
			)}
			{status === "signedIn" && (
				<PlaylistEditorProvider>
					<PlaylistEditorContent />
				</PlaylistEditorProvider>
			)}
			{/* status === "loading": render no window; auth resolves within a tick of boot */}
		</ClassicyApp>
	);
}
```

Then remove the stray `<span hidden onClick={quit} />` and the now-unused `quit` from `PlaylistEditorContent` — it is a leftover; `quit` is only needed in the gate. Verify `tsc -b` reports no unused variable before committing.

- [ ] **Step 5: Simplify `PlaylistList`'s Open path**

In `PlaylistList.tsx`, the Open button already calls `onOpen(await getPlaylist(selected.id))` — no change needed. Delete the now-duplicated `Duplicate` and `Delete` buttons only if `pnpm lint` flags them as unused; otherwise leave them, since the list is still a legitimate place to manage playlists without opening them.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditor.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add -A packages/frontend/src/Applications/PlaylistEditor
git commit -m "feat(frontend): make Playlists a document-based app

The list window persists as the app's home base, each opened playlist
gets its own cascaded document window, and the Tools palette floats
above them acting on whichever document is frontmost.

Deletes the Control window and ControlPanel: its two locks are now the
Control menu on each document window, which removes the ambiguity of a
single window whose target was the last-focused document. Its
behavioural cases moved to the provider and menu tests rather than being
dropped.

The file-open dialog moves up to app level, since the palette rather
than a document body now triggers it; the sourcesRef pattern that keeps
the archive volume's identity stable is preserved verbatim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Integration test and full verification

**Files:**
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.integration.test.tsx`

- [ ] **Step 1: Add the cross-window cases**

This file renders the **real** `PlaylistList` and the **real** provider — only `classicy` and the network are mocked. That is what makes it worth keeping: the unit tests each mock their neighbour, so nothing else proves the list, the provider, and the windows agree.

Its existing `ClassicyWindow` mock keys test ids by **title**, not id (`data-testid={`window-${title}`}`). Document windows are titled with the playlist title, so two open playlists are two distinguishable test ids without touching the mock.

Add `getPlaylist` to the existing `apiMocks` block:

```tsx
const apiMocks = vi.hoisted(() => ({
	listMine: vi.fn(),
	getPlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../Providers/Auth/playlistApi")>()),
	listMine: apiMocks.listMine,
	getPlaylist: apiMocks.getPlaylist,
}));
```

Then append inside the top-level `describe`:

```tsx
const summary = (id: string, title: string) => ({
	id, title, status: "draft" as const, date_updated: null, user_created: "u1",
});
const record = (id: string, title: string) => ({
	...summary(id, title),
	definition: { version: 1 as const, mode: "annotate" as const, entries: [] },
});

const openFromList = async (title: string) => {
	fireEvent.click(await screen.findByText(title));
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
};

it("opens each playlist into its own window, titled by playlist", async () => {
	apiMocks.listMine.mockResolvedValue([summary("p1", "Lesson One"), summary("p2", "Lesson Two")]);
	apiMocks.getPlaylist.mockImplementation(async (id: string) =>
		id === "p1" ? record("p1", "Lesson One") : record("p2", "Lesson Two"),
	);
	render(<PlaylistEditor />);

	await openFromList("Lesson One");
	await waitFor(() => expect(screen.getByTestId("window-Lesson One")).toBeInTheDocument());

	await openFromList("Lesson Two");
	await waitFor(() => expect(screen.getByTestId("window-Lesson Two")).toBeInTheDocument());

	// Both documents AND the list survive — the whole point of the rework.
	expect(screen.getByTestId("window-Lesson One")).toBeInTheDocument();
	expect(screen.getByTestId("window-Playlists")).toBeInTheDocument();
});

// Reopening from the list must not re-seed from the record: that would throw
// away unsaved edits the moment a user clicked a playlist they already had open.
it("reopening an already-open playlist does not add a second window", async () => {
	apiMocks.listMine.mockResolvedValue([summary("p1", "Lesson One")]);
	apiMocks.getPlaylist.mockResolvedValue(record("p1", "Lesson One"));
	render(<PlaylistEditor />);

	await openFromList("Lesson One");
	await waitFor(() => expect(screen.getByTestId("window-Lesson One")).toBeInTheDocument());
	await openFromList("Lesson One");

	expect(screen.getAllByTestId("window-Lesson One")).toHaveLength(1);
});
```

Add `fireEvent` and `waitFor` to the existing `@testing-library/react` import at the top of the file.

- [ ] **Step 2: Run the full frontend suite**

Run: `pnpm test`
Expected: PASS. Any failure outside `src/Applications/PlaylistEditor/` means something shared was broken — fix it rather than skipping the test.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @rt911/frontend exec tsc -b && pnpm lint`
Expected: both clean. `tsc -b` caches — if it reports success suspiciously fast after an error, re-run with `--force`.

- [ ] **Step 4: Verify by hand in the browser**

```bash
pnpm dev
```

Check who owns port 5173 first — a stale vite from another project silently squats it and you will be testing the wrong app. Then, signed in:

1. Open two playlists; both windows appear, cascaded, list still open.
2. Palette tools are greyed until a document is focused, then add to the focused one.
3. `Edit` shows the current mode checkmarked, with balloon help on hover.
4. `File > Status` checkmarks the current status; `File > Save` is disabled until dirty.
5. `Control > Lock Clock` checkmarks on success; `Lock Contents` is greyed.
6. `Window` lists both playlists and focuses the right one.
7. Close a dirty document — the alert appears and Cancel keeps it open.
8. Close every window; the palette remains with a working `File > Quit`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/frontend/src/Applications/PlaylistEditor
git commit -m "test(frontend): cover playlist multi-window isolation end to end

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **`.env` gotcha:** a fresh worktree has no `.env`, so `pnpm dev` silently points at **production** Directus and the production streamer. Copy `.env.example` first, or you will be locking clocks for real users.
- **`useAppManager` selector shape:** `s.System.Manager.Applications.apps["PlaylistEditor.app"].windows` is an array of `{ id, focused, ... }`. There is no `focusedWindowId` field — derive from `windows`.
- **Do not add an `alwaysOnTop` palette.** That prop floats a utility window above *every* app even when this one is backgrounded; the palette should drop behind whatever the teacher switches to.
- If a task's test cannot be made to pass without changing an interface another task defined, stop and report rather than silently renaming — later tasks were written against these names.
