# Playlist Editor + Classicy File Open Dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a sign-in-gated Playlist editor Classicy app that assembles full `PlaylistDefinition`s by picking items from a new reusable Classicy File Open dialog backed by desktop/filesystem/Directus volumes, with a read-only timeline visualization.

**Architecture:** Phase A adds generic primitives to the classicy library (tree selection/disabled states, a `ClassicyFileDialogVolume` interface, `ClassicyFileOpenDialog`); phase B implements the rt911 "911 Realtime Archive" volume (WS `sources` slugs for TV/radio, Directus REST for news/flights, all fetches serialized); phase C builds the `PlaylistEditor.app` (auth gating, My Playlists CRUD via `playlistApi`, per-kind entry editing, `PlaylistTimeline`). Spec: `plans/2026-07-17-playlist-editor-design.md`.

**Tech Stack:** classicy (React 19, Vite, SCSS, vitest, Storybook, biome, tabs), rt911 frontend (Vite + React + TS, vitest + @testing-library/react, Playwright), Directus REST.

## Global Constraints

- **Two repos.** Phase A in `/home/robbiebyrd/classicy` (branch `feat/file-open-dialog`, merged to `main` at task A4 — push to main auto-bumps + publishes to npm). Phases B/C in the rt911 repo (branch `feat/playlist-editor`). During B/C development run `pnpm use:local` from `packages/frontend` to link the local classicy build; run `pnpm use:published` before the final rt911 commit.
- **classicy conventions:** tab indentation, biome (`pnpm lint`), SCSS files start with `@use '.../AppearanceManager/styles/appearance';`, tests import from `@/__tests__/test-utils` (re-exports RTL + `userEvent` + `renderWithProviders`; global `afterEach(cleanup)` in setup), stories use `@storybook/react-vite` `Meta`/`StoryObj`. `src/index.ts` is barrelsby-generated — never hand-edit; run `pnpm generate-barrels`.
- **rt911 frontend conventions:** NO global RTL cleanup — every new test file declares its own `afterEach(() => { cleanup(); vi.clearAllMocks(); })`. Never fully `vi.mock("classicy")` — always the partial pattern `vi.mock("classicy", async (importOriginal) => ({ ...(await importOriginal()), ClassicyApp: ..., ClassicyWindow: ... }))` (full replacement breaks on new imports).
- **All Directus REST calls from the browser MUST be sequential** (api-beta concurrent-fetch body-mixing bug) — everything goes through the `directusQueue.ts` `enqueue()` added in task B1.
- **All times are UTC ISO strings on the virtual timeline.** Display timezone is fixed UTC-4 for editing/rendering (`DISPLAY_TZ_OFFSET_HOURS = -4`).
- **Nothing editor- or auth-shaped touches localStorage or the ClassicyStore.** Editor state is React-only.
- **Copy rules:** anonymous-gate message is exactly `You must be signed in to create playlists.`; dialog default title `Open`; network volume label `911 Realtime Archive`.
- `playlistApi` function names are `listMine(meId)`, `getPlaylist`, `createPlaylist(title, definition)`, `updatePlaylist(id, patch)`, `deletePlaylist(id)`, `duplicatePlaylist(id)`; errors `AuthRequiredError` / `ForbiddenError` from `Providers/Auth/authApi.ts`.
- `parsePlaylist(raw)` returns `{ definition: PlaylistDefinition | null, warnings: string[] }` — `null` = structurally invalid (block save); warnings never block, they prompt.

---

## Phase A — classicy library

### Task A1: `ClassicyTree` selection, disabled, and multi-button support

**Files:**
- Modify: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/Tree/ClassicyTree.tsx`
- Modify: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/Tree/ClassicyTree.scss`
- Modify: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/Tree/ClassicyTree.test.tsx` (append)
- Modify: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/Tree/ClassicyTree.stories.tsx` (append)

**Interfaces:**
- Consumes: existing `ClassicyTreeNode`, `ClassicyTreeNodeButton`, `ClassicyTriangle`, `ClassicyButton`.
- Produces (used by A3):
  - `ClassicyTreeNode` gains `disabled?: boolean; selectable?: boolean; buttons?: ClassicyTreeNodeButton[]`
  - `ClassicyTreeProps` gains `selectionMode?: "none" | "single" | "multi"` (default `"none"`), `selectedIds?: string[]`, `onSelectNode?: (id: string, node: ClassicyTreeNode, e: ReactMouseEvent | ReactKeyboardEvent) => void`, `onActivateNode?: (id: string, node: ClassicyTreeNode) => void` (leaf double-click)
  - Selection/disabled apply to **leaves only**; branches keep toggle-only behavior, except a `disabled` branch which neither toggles nor fires callbacks.

- [ ] **Step 1: Write the failing tests**

Append to `ClassicyTree.test.tsx` (keep the file's existing mocks — they already stub analytics, sound, and every `.scss` in the render tree):

```tsx
describe("ClassicyTree selection & disabled", () => {
	const leaf = (id: string, extra: Partial<ClassicyTreeNode> = {}): ClassicyTreeNode => ({
		id, label: id, ...extra,
	});
	const nodes: ClassicyTreeNode[] = [
		{ id: "folder", label: "folder", defaultOpen: true, children: [
			leaf("a"), leaf("b", { disabled: true }), leaf("c"),
		]},
	];

	it("fires onSelectNode for an enabled leaf when selectionMode is single", async () => {
		const user = userEvent.setup();
		const onSelectNode = vi.fn();
		render(<ClassicyTree nodes={nodes} selectionMode="single" selectedIds={[]} onSelectNode={onSelectNode} />);
		await user.click(screen.getByText("a"));
		expect(onSelectNode).toHaveBeenCalledTimes(1);
		expect(onSelectNode.mock.calls[0][0]).toBe("a");
	});

	it("does not fire onSelectNode for a disabled leaf, and marks it disabled", async () => {
		const user = userEvent.setup();
		const onSelectNode = vi.fn();
		render(<ClassicyTree nodes={nodes} selectionMode="single" selectedIds={[]} onSelectNode={onSelectNode} />);
		const row = screen.getByText("b").closest("li");
		expect(row?.querySelector(".classicyTreeNodeDisabled")).not.toBeNull();
		await user.click(screen.getByText("b"));
		expect(onSelectNode).not.toHaveBeenCalled();
	});

	it("renders the selected style for ids in selectedIds", () => {
		render(<ClassicyTree nodes={nodes} selectionMode="multi" selectedIds={["c"]} onSelectNode={() => {}} />);
		expect(screen.getByText("c").closest(".classicyTreeNodeLabelHolder")?.className)
			.toContain("classicyTreeNodeSelected");
	});

	it("fires onActivateNode on leaf double-click", async () => {
		const user = userEvent.setup();
		const onActivateNode = vi.fn();
		render(<ClassicyTree nodes={nodes} selectionMode="single" selectedIds={[]} onActivateNode={onActivateNode} />);
		await user.dblClick(screen.getByText("a"));
		expect(onActivateNode).toHaveBeenCalledWith("a", expect.objectContaining({ id: "a" }));
	});

	it("selects an enabled leaf with the keyboard (Enter)", async () => {
		const user = userEvent.setup();
		const onSelectNode = vi.fn();
		render(<ClassicyTree nodes={nodes} selectionMode="single" selectedIds={[]} onSelectNode={onSelectNode} />);
		screen.getByText("a").closest('[role="button"]')?.dispatchEvent(new FocusEvent("focus"));
		await user.type(screen.getByText("a").closest('[role="button"]') as HTMLElement, "{Enter}");
		expect(onSelectNode).toHaveBeenCalled();
	});

	it("keeps leaves inert when selectionMode is none (default)", async () => {
		const user = userEvent.setup();
		const onSelectNode = vi.fn();
		render(<ClassicyTree nodes={nodes} onSelectNode={onSelectNode} />);
		expect(screen.getByText("a").closest('[role="button"]')).toBeNull();
		await user.click(screen.getByText("a"));
		expect(onSelectNode).not.toHaveBeenCalled();
	});

	it("renders multiple leaf buttons from `buttons` and clicks don't select", async () => {
		const user = userEvent.setup();
		const onSelectNode = vi.fn();
		const onEdit = vi.fn();
		const withButtons: ClassicyTreeNode[] = [
			{ id: "f", label: "f", defaultOpen: true, children: [
				leaf("x", { buttons: [ { label: "Edit", onClickFunc: onEdit }, { label: "Remove" } ] }),
			]},
		];
		render(<ClassicyTree nodes={withButtons} selectionMode="single" selectedIds={[]} onSelectNode={onSelectNode} />);
		await user.click(screen.getByRole("button", { name: "Edit" }));
		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(onSelectNode).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/Tree/ClassicyTree.test.tsx`
Expected: the new `describe` block FAILS (unknown props are ignored by React, so failures are assertion failures like `onSelectNode` never called / class missing). Pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `ClassicyTree.tsx`:

```tsx
// type additions
export type ClassicyTreeSelectionMode = "none" | "single" | "multi";

export type ClassicyTreeNode = {
	id: string;
	label: string;
	leftIcon?: string;
	rightIcon?: string;
	children?: ClassicyTreeNode[];
	defaultOpen?: boolean;
	/** Leaf-only: a single small button (kept for back-compat; `buttons` wins if both set). */
	button?: ClassicyTreeNodeButton;
	/** Leaf-only: multiple small buttons rendered right of the label. */
	buttons?: ClassicyTreeNodeButton[];
	/** Grayed out; not clickable; branches also refuse to toggle. */
	disabled?: boolean;
	/** Leaf-only: opt out of selection while staying enabled-looking. Default true. */
	selectable?: boolean;
};

type ClassicyTreeProps = {
	nodes: ClassicyTreeNode[];
	direction?: ClassicyTriangleDirection;
	onToggleNode?: (id: string, open: boolean) => void;
	selectionMode?: ClassicyTreeSelectionMode;
	selectedIds?: string[];
	onSelectNode?: (id: string, node: ClassicyTreeNode, e: ReactMouseEvent | ReactKeyboardEvent) => void;
	onActivateNode?: (id: string, node: ClassicyTreeNode) => void;
};
```

(`import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react"` — the file already imports `KeyboardEvent`/`MouseEvent` types; reuse those names.)

`ClassicyTreeNodeItem` changes — thread the four new props down; inside the component:

```tsx
const canSelect =
	!hasChildren &&
	selectionMode !== "none" &&
	node.selectable !== false &&
	!node.disabled;
const isSelected = !hasChildren && (selectedIds ?? []).includes(node.id);
const leafButtons = node.buttons ?? (node.button ? [node.button] : []);

function toggle() {
	if (!hasChildren || node.disabled) return;   // disabled branches refuse to toggle
	const next = !open;
	setOpen(next);
	onToggleNode?.(node.id, next);
}
```

Leaf rendering replaces the current plain-leaf branch:

```tsx
) : canSelect ? (
	// biome-ignore lint/a11y/useSemanticElements: selectable row is a flex container with svg/img/span children incompatible with <button>
	<div
		role="button"
		tabIndex={0}
		aria-pressed={isSelected}
		className={classNames("classicyTreeNodeLabelHolder", "classicyTreeNodeLeaf", "classicyTreeNodeSelectable", {
			classicyTreeNodeSelected: isSelected,
		})}
		onClick={(e) => onSelectNode?.(node.id, node, e)}
		onDoubleClick={() => onActivateNode?.(node.id, node)}
		onKeyDown={(e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onSelectNode?.(node.id, node, e);
			}
		}}
	>
		{rowInner}
	</div>
) : (
	<div
		className={classNames("classicyTreeNodeLabelHolder", "classicyTreeNodeLeaf", {
			classicyTreeNodeDisabled: node.disabled,
			classicyTreeNodeSelected: isSelected,
		})}
	>
		{rowInner}
	</div>
)}
```

Branch row also gets `classicyTreeNodeDisabled` in its classNames when `node.disabled`, and its `tabIndex` becomes `node.disabled ? -1 : 0`.

Button rendering replaces the single-button block:

```tsx
{!hasChildren && leafButtons.map((b, i) => (
	<ClassicyButton
		key={i}
		buttonSize={"small"}
		margin={"sm"}
		isDefault={b.isDefault}
		disabled={b.disabled}
		depressed={b.depressed}
		onClickFunc={(e: MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			b.onClickFunc?.(e);
		}}
	>
		{b.label}
	</ClassicyButton>
))}
```

`ClassicyTree` itself just forwards `selectionMode = "none"`, `selectedIds`, `onSelectNode`, `onActivateNode` to every `ClassicyTreeNodeItem`.

`ClassicyTree.scss` additions (library conventions: dim text is `--color-system-05`, selection is `--color-select` bg + `--color-white` text):

```scss
.classicyTreeNodeDisabled {
	.classicyTreeNodeLabel {
		color: var(--color-system-05);
	}
	.classicyTreeNodeIcon {
		opacity: 0.5;
	}
	cursor: default;
	pointer-events: none;
}

.classicyTreeNodeSelectable {
	cursor: pointer;
}

.classicyTreeNodeSelected {
	background: var(--color-select);
	.classicyTreeNodeLabel {
		color: var(--color-white);
	}
}
```

Append a story to `ClassicyTree.stories.tsx`:

```tsx
export const SelectableWithDisabled: Story = {
	args: {
		selectionMode: "multi",
		selectedIds: ["kept"],
		nodes: [
			{ id: "root", label: "Documents", defaultOpen: true, children: [
				{ id: "kept", label: "Kept file" },
				{ id: "grayed", label: "Grayed file", disabled: true },
				{ id: "plain", label: "Plain file", buttons: [{ label: "Edit" }, { label: "Remove" }] },
			]},
		],
	},
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/Tree/ClassicyTree.test.tsx`
Expected: PASS (all pre-existing + 7 new).

- [ ] **Step 5: Commit**

```bash
cd /home/robbiebyrd/classicy && git checkout -b feat/file-open-dialog
git add src/SystemFolder/SystemResources/Tree/
git commit -m "feat(tree): selection modes, disabled nodes, multi-button leaves"
```

### Task A2: Volume interface + built-in filesystem/desktop volumes

**Files:**
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume.ts`
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume.test.ts`

**Interfaces:**
- Consumes: `ClassicyFileSystem` (`resolve`, `separator`, `fs`), `ClassicyFileSystemEntryFileType`, `ClassicyIcons`, `iconImageByType`.
- Produces (used by A3, B1, C3):

```ts
export type ClassicyFileDialogEntry = {
	id: string;                    // stable within the volume
	name: string;
	kind: "folder" | "file";
	fileType?: string;             // ClassicyFileSystemEntryFileType value or app-specific string
	icon?: string;
	meta?: Record<string, unknown>;
};
export type ClassicyFileDialogVolume = {
	id: string;
	label: string;
	icon?: string;
	list(path: string[]): Promise<ClassicyFileDialogEntry[]>;
};
export function desktopVolume(fs: ClassicyFileSystem): ClassicyFileDialogVolume;      // root = all top-level drives (classic Desktop level)
export function fileSystemVolume(fs: ClassicyFileSystem, drive: string): ClassicyFileDialogVolume;
```

Filesystem-backed entries carry `meta: { classicyPath: string }` — the colon-joined path usable with `ClassicyAppFinderOpenFile` / `FileEntry.path`.

- [ ] **Step 1: Write the failing tests**

`ClassicyFileDialogVolume.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClassicyFileSystem } from "@/SystemFolder/SystemResources/File/ClassicyFileSystem";
import { ClassicyFileSystemEntryFileType } from "@/SystemFolder/SystemResources/File/ClassicyFileSystemModel";
import { desktopVolume, fileSystemVolume } from "@/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume";

const FIXTURE = {
	"Macintosh HD": {
		_type: ClassicyFileSystemEntryFileType.Drive,
		Documents: {
			_type: ClassicyFileSystemEntryFileType.Directory,
			"Report.pdf": { _type: ClassicyFileSystemEntryFileType.Pdf },
			"notes.txt": { _type: ClassicyFileSystemEntryFileType.TextFile },
			Secret: { _type: ClassicyFileSystemEntryFileType.Directory, _invisible: true },
		},
	},
};

const fs = new ClassicyFileSystem("fileDialogTest", FIXTURE);

describe("fileSystemVolume", () => {
	it("lists a folder with folders first, files sorted, invisible entries hidden", async () => {
		const vol = fileSystemVolume(fs, "Macintosh HD");
		const entries = await vol.list(["Documents"]);
		expect(entries.map((e) => e.name)).toEqual(["Report.pdf", "notes.txt"]);
		expect(entries[0]).toMatchObject({
			kind: "file",
			fileType: "pdf",
			meta: { classicyPath: "Macintosh HD:Documents:Report.pdf" },
		});
	});
	it("lists the drive root at path []", async () => {
		const vol = fileSystemVolume(fs, "Macintosh HD");
		const entries = await vol.list([]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ name: "Documents", kind: "folder" });
	});
});

describe("desktopVolume", () => {
	it("lists top-level drives as folders at the root", async () => {
		const vol = desktopVolume(fs);
		const entries = await vol.list([]);
		expect(entries[0]).toMatchObject({ name: "Macintosh HD", kind: "folder", fileType: "drive" });
	});
	it("descends through a drive", async () => {
		const vol = desktopVolume(fs);
		const entries = await vol.list(["Macintosh HD", "Documents"]);
		expect(entries.map((e) => e.name)).toEqual(["Report.pdf", "notes.txt"]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`ClassicyFileDialogVolume.ts`:

```ts
import { ClassicyIcons } from "@/SystemFolder/ControlPanels/AppearanceManager/ClassicyIcons";
import { iconImageByType } from "@/SystemFolder/SystemResources/File/ClassicyFileBrowserUtils";
import type { ClassicyFileSystem } from "@/SystemFolder/SystemResources/File/ClassicyFileSystem";
import { ClassicyFileSystemEntryFileType } from "@/SystemFolder/SystemResources/File/ClassicyFileSystemModel";

export type ClassicyFileDialogEntry = {
	/** Stable identifier within the volume. */
	id: string;
	name: string;
	kind: "folder" | "file";
	/** A ClassicyFileSystemEntryFileType value, or any app-specific string. */
	fileType?: string;
	icon?: string;
	/** Opaque payload handed back to the dialog's caller on selection. */
	meta?: Record<string, unknown>;
};

export type ClassicyFileDialogVolume = {
	id: string;
	label: string;
	icon?: string;
	/** Lazy listing of one folder; called on expand. */
	list(path: string[]): Promise<ClassicyFileDialogEntry[]>;
};

const FOLDER_TYPES = new Set<string>([
	ClassicyFileSystemEntryFileType.Drive,
	ClassicyFileSystemEntryFileType.Directory,
]);

function listFsChildren(
	fs: ClassicyFileSystem,
	segments: string[],
): ClassicyFileDialogEntry[] {
	const target =
		segments.length === 0 ? fs.fs : fs.resolve(segments.join(fs.separator));
	if (!target || typeof target !== "object") {
		return [];
	}
	return Object.entries(target)
		.filter(
			([name, value]) =>
				!name.startsWith("_") &&
				value !== null &&
				typeof value === "object" &&
				"_type" in value &&
				!value._invisible,
		)
		.map(([name, value]) => {
			const path = [...segments, name].join(fs.separator);
			return {
				id: path,
				name,
				kind: (FOLDER_TYPES.has(value._type) ? "folder" : "file") as
					| "folder"
					| "file",
				fileType: value._type as string,
				icon: (value._icon as string) ?? iconImageByType(value._type),
				meta: { classicyPath: path },
			};
		})
		.sort((a, b) =>
			a.kind === b.kind
				? a.name.localeCompare(b.name)
				: a.kind === "folder"
					? -1
					: 1,
		);
}

/** The classic Desktop level: all mounted drives, then their contents. */
export function desktopVolume(fs: ClassicyFileSystem): ClassicyFileDialogVolume {
	return {
		id: "desktop",
		label: "Desktop",
		icon: ClassicyIcons.system.mac,
		list: (path) => Promise.resolve(listFsChildren(fs, path)),
	};
}

/** A single classic drive rooted at its own top level. */
export function fileSystemVolume(
	fs: ClassicyFileSystem,
	drive: string,
): ClassicyFileDialogVolume {
	return {
		id: `fs-${drive}`,
		label: drive,
		icon:
			(fs.resolve(drive)?._icon as string) ??
			ClassicyIcons.system.drives.disk,
		list: (path) => Promise.resolve(listFsChildren(fs, [drive, ...path])),
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/robbiebyrd/classicy
git add src/SystemFolder/SystemResources/FileDialog/
git commit -m "feat(file-dialog): volume provider interface + desktop/drive volumes"
```

### Task A3: `ClassicyFileOpenDialog`

**Files:**
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.tsx`
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.scss`
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.test.tsx`
- Create: `/home/robbiebyrd/classicy/src/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.stories.tsx`

**Interfaces:**
- Consumes: A1 tree props, A2 volume types, `ClassicyWindow`, `ClassicyButton`, `ClassicyPopUpMenu` (`options: {value,label}[]`, `selected`, `onChangeFunc(e) → e.target.value`).
- Produces (used by C3):

```ts
export type ClassicyFileOpenSelection = {
	volumeId: string;
	path: string[];                       // parent folder path (names) within the volume
	entry: ClassicyFileDialogEntry;
};
export type ClassicyFileOpenDialogProps = {
	id: string;
	appId: string;
	open: boolean;
	title?: string;                       // default "Open"
	volumes: ClassicyFileDialogVolume[];  // first = initially active
	selectionMode?: "single" | "multi";   // default "single"
	fileTypeFilters?: { label: string; types: string[] | null }[];
	onOpenFunc: (selections: ClassicyFileOpenSelection[]) => void;
	onCancelFunc?: () => void;
};
export const ClassicyFileOpenDialog: FC<ClassicyFileOpenDialogProps>;
```

**Internal model (implementation contract):** folder contents cached in `Map<cacheKey, ClassicyFileDialogEntry[] | "loading" | "error">` where `cacheKey = volumeId + "\u0000" + pathNames.join("\u0000")`. Tree node ids are cacheKey-style ids for the entry itself; a parallel `Map<string, { path: string[]; entry }>` resolves node id → selection payload. Loading placeholder = disabled leaf `Loading…`; error placeholder = leaf `Couldn't open this folder` with a `Retry` button. Filter changes prune newly disabled ids from the selection. Cache clears when `open` flips false→true (fresh dialog session) but persists across volume switches within a session.

- [ ] **Step 1: Write the failing tests**

`ClassicyFileOpenDialog.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/__tests__/test-utils";
import type { ClassicyFileDialogVolume } from "@/SystemFolder/SystemResources/FileDialog/ClassicyFileDialogVolume";
import { ClassicyFileOpenDialog } from "@/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog";

vi.mock("@/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.scss", () => ({}));

function makeVolume(overrides: Partial<ClassicyFileDialogVolume> = {}): ClassicyFileDialogVolume {
	return {
		id: "vol-a",
		label: "Volume A",
		list: vi.fn(async (path: string[]) => {
			if (path.length === 0) {
				return [
					{ id: "docs", name: "Documents", kind: "folder" as const },
					{ id: "movie", name: "movie.mov", kind: "file" as const, fileType: "video" },
					{ id: "song", name: "song.mp3", kind: "file" as const, fileType: "audio" },
				];
			}
			return [{ id: "docs/inner", name: "inner.pdf", kind: "file" as const, fileType: "pdf" }];
		}),
		...overrides,
	};
}

const baseProps = {
	id: "test-dialog",
	appId: "Test.app",
	open: true,
	onOpenFunc: vi.fn(),
};

describe("ClassicyFileOpenDialog", () => {
	it("lists the active volume root on open", async () => {
		renderWithProviders(<ClassicyFileOpenDialog {...baseProps} volumes={[makeVolume()]} />);
		expect(await screen.findByText("movie.mov")).toBeInTheDocument();
		expect(screen.getByText("Documents")).toBeInTheDocument();
	});

	it("expands a folder lazily and shows its children", async () => {
		const user = userEvent.setup();
		const vol = makeVolume();
		renderWithProviders(<ClassicyFileOpenDialog {...baseProps} volumes={[vol]} />);
		await user.click(await screen.findByText("Documents"));
		expect(await screen.findByText("inner.pdf")).toBeInTheDocument();
		expect(vol.list).toHaveBeenCalledWith(["Documents"]);
	});

	it("shows a retry row when list() rejects, and retries on Retry", async () => {
		const user = userEvent.setup();
		let fail = true;
		const vol = makeVolume({
			list: vi.fn(async (path: string[]) => {
				if (path.length === 0) return [{ id: "docs", name: "Documents", kind: "folder" as const }];
				if (fail) { fail = false; throw new Error("boom"); }
				return [{ id: "docs/late", name: "late.txt", kind: "file" as const, fileType: "text_file" }];
			}),
		});
		renderWithProviders(<ClassicyFileOpenDialog {...baseProps} volumes={[vol]} />);
		await user.click(await screen.findByText("Documents"));
		expect(await screen.findByText("Couldn't open this folder")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("late.txt")).toBeInTheDocument();
	});

	it("grays files not matching the active filter and drops them from selection on filter change", async () => {
		const user = userEvent.setup();
		renderWithProviders(
			<ClassicyFileOpenDialog
				{...baseProps}
				volumes={[makeVolume()]}
				selectionMode="multi"
				fileTypeFilters={[
					{ label: "All Items", types: null },
					{ label: "Movies", types: ["video"] },
				]}
			/>,
		);
		await user.click(await screen.findByText("song.mp3"));
		await user.selectOptions(screen.getByRole("combobox", { name: /show/i }), "1");
		const songHolder = screen.getByText("song.mp3").closest("li");
		expect(songHolder?.querySelector(".classicyTreeNodeDisabled")).not.toBeNull();
		await user.click(screen.getByRole("button", { name: "Open" }));
		expect(baseProps.onOpenFunc).not.toHaveBeenCalled();  // selection was pruned → Open disabled
	});

	it("returns the selection payload on Open (single mode replaces)", async () => {
		const user = userEvent.setup();
		const onOpenFunc = vi.fn();
		renderWithProviders(
			<ClassicyFileOpenDialog {...baseProps} onOpenFunc={onOpenFunc} volumes={[makeVolume()]} />,
		);
		await user.click(await screen.findByText("movie.mov"));
		await user.click(screen.getByText("song.mp3"));
		await user.click(screen.getByRole("button", { name: "Open" }));
		expect(onOpenFunc).toHaveBeenCalledTimes(1);
		const selections = onOpenFunc.mock.calls[0][0];
		expect(selections).toHaveLength(1);
		expect(selections[0]).toMatchObject({
			volumeId: "vol-a",
			path: [],
			entry: { id: "song", name: "song.mp3" },
		});
	});

	it("opens immediately on double-click of an enabled file", async () => {
		const user = userEvent.setup();
		const onOpenFunc = vi.fn();
		renderWithProviders(
			<ClassicyFileOpenDialog {...baseProps} onOpenFunc={onOpenFunc} volumes={[makeVolume()]} />,
		);
		await user.dblClick(await screen.findByText("movie.mov"));
		expect(onOpenFunc).toHaveBeenCalledTimes(1);
		expect(onOpenFunc.mock.calls[0][0][0].entry.id).toBe("movie");
	});

	it("switches volumes via the popup and resets the selection", async () => {
		const user = userEvent.setup();
		const volB = makeVolume({
			id: "vol-b",
			label: "Volume B",
			list: vi.fn(async () => [{ id: "bfile", name: "b.txt", kind: "file" as const, fileType: "text_file" }]),
		});
		renderWithProviders(
			<ClassicyFileOpenDialog {...baseProps} volumes={[makeVolume(), volB]} />,
		);
		await user.click(await screen.findByText("movie.mov"));
		await user.selectOptions(screen.getByRole("combobox", { name: /volume/i }), "vol-b");
		expect(await screen.findByText("b.txt")).toBeInTheDocument();
		const openButton = screen.getByRole("button", { name: "Open" }) as HTMLButtonElement;
		expect(openButton.disabled).toBe(true);
	});

	it("cancels on Cancel and on Escape", async () => {
		const user = userEvent.setup();
		const onCancelFunc = vi.fn();
		renderWithProviders(
			<ClassicyFileOpenDialog {...baseProps} onCancelFunc={onCancelFunc} volumes={[makeVolume()]} />,
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancelFunc).toHaveBeenCalledTimes(1);
		await user.keyboard("{Escape}");
		expect(onCancelFunc).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/FileDialog/ClassicyFileOpenDialog.test.tsx`
Expected: FAIL — component module does not exist.

- [ ] **Step 3: Implement the component**

`ClassicyFileOpenDialog.tsx` (complete):

```tsx
import "./ClassicyFileOpenDialog.scss";
import {
	type FC as FunctionalComponent,
	type KeyboardEvent,
	type MouseEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyPopUpMenu } from "@/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu";
import {
	ClassicyTree,
	type ClassicyTreeNode,
} from "@/SystemFolder/SystemResources/Tree/ClassicyTree";
import { ClassicyWindow } from "@/SystemFolder/SystemResources/Window/ClassicyWindow";
import type {
	ClassicyFileDialogEntry,
	ClassicyFileDialogVolume,
} from "./ClassicyFileDialogVolume";

export type ClassicyFileOpenSelection = {
	volumeId: string;
	path: string[];
	entry: ClassicyFileDialogEntry;
};

export type ClassicyFileOpenDialogProps = {
	id: string;
	appId: string;
	open: boolean;
	title?: string;
	volumes: ClassicyFileDialogVolume[];
	selectionMode?: "single" | "multi";
	fileTypeFilters?: { label: string; types: string[] | null }[];
	onOpenFunc: (selections: ClassicyFileOpenSelection[]) => void;
	onCancelFunc?: () => void;
};

const SEP = "\u0000";
type FolderState = ClassicyFileDialogEntry[] | "loading" | "error";

const cacheKey = (volumeId: string, path: string[]) =>
	[volumeId, ...path].join(SEP);

export const ClassicyFileOpenDialog: FunctionalComponent<
	ClassicyFileOpenDialogProps
> = ({
	id,
	appId,
	open,
	title = "Open",
	volumes,
	selectionMode = "single",
	fileTypeFilters,
	onOpenFunc,
	onCancelFunc,
}) => {
	const [activeVolumeId, setActiveVolumeId] = useState(volumes[0]?.id);
	const [folders, setFolders] = useState<Map<string, FolderState>>(new Map());
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [filterIndex, setFilterIndex] = useState(0);
	// node id → selection payload, rebuilt on every render pass over the cache
	const nodeIndex = useRef(new Map<string, ClassicyFileOpenSelection>());

	const activeVolume = volumes.find((v) => v.id === activeVolumeId);
	const activeTypes = fileTypeFilters?.[filterIndex]?.types ?? null;

	const setFolder = (key: string, state: FolderState) =>
		setFolders((prev) => new Map(prev).set(key, state));

	const loadFolder = (volume: ClassicyFileDialogVolume, path: string[]) => {
		const key = cacheKey(volume.id, path);
		setFolder(key, "loading");
		volume
			.list(path)
			.then((entries) => setFolder(key, entries))
			.catch(() => setFolder(key, "error"));
	};

	// fresh dialog session: reset caches, load the first volume's root
	useEffect(() => {
		if (!open || volumes.length === 0) return;
		setFolders(new Map());
		setSelectedIds([]);
		setFilterIndex(0);
		setActiveVolumeId(volumes[0].id);
		loadFolder(volumes[0], []);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// load a volume root on first switch to it
	useEffect(() => {
		if (!open || !activeVolume) return;
		if (!folders.has(cacheKey(activeVolume.id, []))) {
			loadFolder(activeVolume, []);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeVolumeId, open]);

	const isEntryDisabled = (entry: ClassicyFileDialogEntry) =>
		entry.kind === "file" &&
		activeTypes !== null &&
		!activeTypes.includes(entry.fileType ?? "");

	const buildNodes = (
		volume: ClassicyFileDialogVolume,
		path: string[],
	): ClassicyTreeNode[] => {
		const state = folders.get(cacheKey(volume.id, path));
		if (state === "loading" || state === undefined) {
			return [
				{ id: `${cacheKey(volume.id, path)}${SEP}#loading`, label: "Loading…", disabled: true },
			];
		}
		if (state === "error") {
			return [
				{
					id: `${cacheKey(volume.id, path)}${SEP}#error`,
					label: "Couldn't open this folder",
					selectable: false,
					buttons: [
						{ label: "Retry", onClickFunc: () => loadFolder(volume, path) },
					],
				},
			];
		}
		return state.map((entry) => {
			if (entry.kind === "folder") {
				// A folder node's id IS its children's cache key, so the toggle
				// handler can split it straight back into path names.
				return {
					id: cacheKey(volume.id, [...path, entry.name]),
					label: entry.name,
					leftIcon: entry.icon,
					children: buildNodes(volume, [...path, entry.name]),
				};
			}
			const nodeId = `${cacheKey(volume.id, path)}${SEP}${entry.id}`;
			nodeIndex.current.set(nodeId, { volumeId: volume.id, path, entry });
			return {
				id: nodeId,
				label: entry.name,
				leftIcon: entry.icon,
				disabled: isEntryDisabled(entry),
			};
		});
	};

	nodeIndex.current = new Map();
	const nodes = useMemo(
		() => (activeVolume ? buildNodes(activeVolume, []) : []),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[activeVolume, folders, filterIndex],
	);

	// prune selections that the current filter disabled or a reload removed
	const liveSelectedIds = selectedIds.filter((sid) =>
		nodeIndex.current.has(sid),
	);

	const handleFolderToggle = (nodeId: string, isOpen: boolean) => {
		if (!activeVolume || !isOpen) return;
		if (nodeId.includes(`${SEP}#`)) return; // placeholder rows
		if (!folders.has(nodeId)) {
			const [, ...pathNames] = nodeId.split(SEP);
			loadFolder(activeVolume, pathNames);
		}
	};

	const handleSelect = (nodeId: string, _node: ClassicyTreeNode, e: unknown) => {
		if (!nodeIndex.current.has(nodeId)) return;
		if (selectionMode === "single") {
			setSelectedIds([nodeId]);
			return;
		}
		const ev = e as MouseEvent;
		if (ev?.metaKey || ev?.ctrlKey) {
			setSelectedIds((prev) =>
				prev.includes(nodeId)
					? prev.filter((x) => x !== nodeId)
					: [...prev, nodeId],
			);
		} else if (ev?.shiftKey && selectedIds.length > 0) {
			// range within the same parent folder
			const anchor = selectedIds[selectedIds.length - 1];
			const parentOf = (nid: string) => nid.slice(0, nid.lastIndexOf(SEP));
			if (parentOf(anchor) === parentOf(nodeId)) {
				const siblings = [...nodeIndex.current.keys()].filter(
					(nid) => parentOf(nid) === parentOf(nodeId),
				);
				const [a, b] = [siblings.indexOf(anchor), siblings.indexOf(nodeId)];
				const range = siblings.slice(Math.min(a, b), Math.max(a, b) + 1);
				setSelectedIds((prev) => [...new Set([...prev, ...range])]);
			} else {
				setSelectedIds([nodeId]);
			}
		} else {
			setSelectedIds([nodeId]);
		}
	};

	const commitOpen = (ids: string[]) => {
		const selections = ids
			.map((nid) => nodeIndex.current.get(nid))
			.filter((s): s is ClassicyFileOpenSelection => s !== undefined);
		if (selections.length > 0) {
			onOpenFunc(selections);
		}
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onCancelFunc?.();
		} else if (e.key === "Enter" && liveSelectedIds.length > 0) {
			e.preventDefault();
			commitOpen(liveSelectedIds);
		}
	};

	if (!open) {
		return null;
	}

	return (
		<ClassicyWindow
			id={id}
			appId={appId}
			title={title}
			modal={true}
			closable={true}
			zoomable={false}
			collapsable={false}
			resizable={false}
			scrollable={false}
			initialSize={[440, 400]}
			initialPosition={[180, 120]}
			onCloseFunc={() => onCancelFunc?.()}
		>
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: dialog-level keyboard shortcuts */}
			<div className={"classicyFileOpenDialogBody"} onKeyDown={handleKeyDown}>
				<ClassicyPopUpMenu
					id={`${id}-volume`}
					label={"Volume"}
					labelPosition={"left"}
					options={volumes.map((v) => ({ value: v.id, label: v.label }))}
					selected={activeVolumeId}
					onChangeFunc={(e) => {
						setActiveVolumeId(e.target.value);
						setSelectedIds([]);
					}}
				/>
				<div className={"classicyFileOpenDialogWell"}>
					<ClassicyTree
						nodes={nodes}
						selectionMode={selectionMode === "multi" ? "multi" : "single"}
						selectedIds={liveSelectedIds}
						onSelectNode={handleSelect}
						onActivateNode={(nodeId) => commitOpen([nodeId])}
						onToggleNode={handleFolderToggle}
					/>
				</div>
				<div className={"classicyFileOpenDialogFooter"}>
					{fileTypeFilters && fileTypeFilters.length > 0 && (
						<ClassicyPopUpMenu
							id={`${id}-filter`}
							label={"Show"}
							labelPosition={"left"}
							options={fileTypeFilters.map((f, i) => ({
								value: String(i),
								label: f.label,
							}))}
							selected={String(filterIndex)}
							onChangeFunc={(e) => setFilterIndex(Number(e.target.value))}
						/>
					)}
					<div className={"classicyFileOpenDialogActions"}>
						<ClassicyButton onClickFunc={() => onCancelFunc?.()}>
							Cancel
						</ClassicyButton>
						<ClassicyButton
							isDefault={true}
							disabled={liveSelectedIds.length === 0}
							onClickFunc={() => commitOpen(liveSelectedIds)}
						>
							Open
						</ClassicyButton>
					</div>
				</div>
			</div>
		</ClassicyWindow>
	);
};
```

**Separator note:** `SEP` is the NUL character (`"\u0000"` — write the escape sequence in source, never a literal byte). It cannot appear in volume ids or entry names, so `nodeId.split(SEP)` recovers path segments losslessly even for names with spaces like `Notable Flights`.

`ClassicyFileOpenDialog.scss`:

```scss
@use '../../ControlPanels/AppearanceManager/styles/appearance';

.classicyFileOpenDialogBody {
	display: flex;
	flex-direction: column;
	gap: calc(var(--window-padding-size) * 1);
	padding: var(--window-padding-size);
	height: 100%;
	box-sizing: border-box;
}

.classicyFileOpenDialogWell {
	flex: 1;
	min-height: 220px;
	overflow-y: auto;
	background: var(--color-white);
	border: var(--window-border-size) solid var(--color-window-border);
	box-shadow:
		inset var(--window-border-size) var(--window-border-size) 0 var(--color-system-06),
		inset calc(var(--window-border-size) * -1) calc(var(--window-border-size) * -1) 0 var(--color-system-01);
}

.classicyFileOpenDialogFooter {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.classicyFileOpenDialogActions {
	display: flex;
	margin-left: auto;
}
```

`ClassicyFileOpenDialog.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClassicyFileOpenDialog } from "./ClassicyFileOpenDialog";
import type { ClassicyFileDialogVolume } from "./ClassicyFileDialogVolume";

const demoVolume: ClassicyFileDialogVolume = {
	id: "demo",
	label: "Demo Volume",
	list: async (path) =>
		path.length === 0
			? [
					{ id: "folder", name: "Folder", kind: "folder" },
					{ id: "movie", name: "movie.mov", kind: "file", fileType: "video" },
					{ id: "song", name: "song.mp3", kind: "file", fileType: "audio" },
				]
			: [{ id: "nested", name: "nested.pdf", kind: "file", fileType: "pdf" }],
};

const meta = {
	title: "Dialogs/FileOpenDialog",
	component: ClassicyFileOpenDialog,
} satisfies Meta<typeof ClassicyFileOpenDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		id: "story-file-open",
		appId: "story-file-open",
		open: true,
		volumes: [demoVolume],
		selectionMode: "multi",
		fileTypeFilters: [
			{ label: "All Items", types: null },
			{ label: "Movies", types: ["video"] },
		],
		onOpenFunc: (selections) => console.log(selections),
	},
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/robbiebyrd/classicy && pnpm exec vitest run src/SystemFolder/SystemResources/FileDialog/`
Expected: PASS (A2's 4 + A3's 8). If `renderWithProviders` doesn't satisfy ClassicyWindow's AppManager requirement, check how existing window-rendering tests mock it and mirror that exactly (do not invent a new harness).

- [ ] **Step 5: Commit**

```bash
cd /home/robbiebyrd/classicy
git add src/SystemFolder/SystemResources/FileDialog/
git commit -m "feat(file-dialog): ClassicyFileOpenDialog with volumes, filters, multi-select"
```

### Task A4: Barrels, full verification, merge, publish

**Files:**
- Modify (generated): `/home/robbiebyrd/classicy/src/index.ts`

- [ ] **Step 1: Regenerate barrels**

Run: `cd /home/robbiebyrd/classicy && pnpm generate-barrels && grep -n "FileDialog" src/index.ts`
Expected: two new `export * from "./SystemFolder/SystemResources/FileDialog/..."` lines.

- [ ] **Step 2: Full test + lint + build**

Run: `cd /home/robbiebyrd/classicy && pnpm test && pnpm lint && pnpm build`
Expected: all pass. Fix anything biome flags (tabs, import order) before proceeding.

- [ ] **Step 3: Commit, merge to main, push (this publishes)**

```bash
cd /home/robbiebyrd/classicy
git add -A && git commit -m "chore: regenerate barrels for FileDialog exports"
git checkout main && git pull --ff-only && git merge --no-ff feat/file-open-dialog -m "feat: file open dialog + tree selection"
git push origin main
```

- [ ] **Step 4: Verify the npm release**

Run: `sleep 180 && npm view classicy version` (CI takes a couple of minutes)
Expected: version > 0.41.x current. Note the released version for the B/C phase.

---

## Phase B — rt911 Directus network volume

### Task B0: Directus public-read permissions for News browsing — **USER CHECKPOINT (prod change)**

**No code files.** This is an ops prerequisite, same shape as the auth spec's "step zero". **Ask the user to approve/perform before executing** — it changes prod API surface:

- Public policy gains **read on `news_items`**: fields `id,title,source,start_date` only, item rule `{ "approved": { "_eq": true } }`.
- Public policy gains **read on `sources`**: fields `id,slug,title` only (needed to name News publication folders).

Directus 12 is policy-based (README-app precedent: attach permissions to the public policy, not the role).

- [ ] **Step 1: Get user approval, then apply via the Directus admin UI (or ask the user to).**

- [ ] **Step 2: Verify with sequential probes**

```bash
curl -sg --max-time 10 "https://api-beta.911realtime.org/items/sources?limit=2&fields=id,slug,title"
curl -sg --max-time 10 "https://api-beta.911realtime.org/items/news_items?limit=2&fields=id,title,source,start_date&filter[approved][_eq]=true"
curl -sg --max-time 10 "https://api-beta.911realtime.org/items/news_items?limit=1&fields=id&aggregate[count]=*&groupBy=source"
```

Expected: all three return `{"data":[...]}` (no FORBIDDEN). Record whether `source` returns an id (FK) — B1 assumes it does. If the aggregate/groupBy probe 403s or errors, B1's publication listing falls back to grouping the plain field (`fields=source` + client-side distinct over a paginated scan capped at 3 pages × 1000) — implement the groupBy path only if the probe succeeds.

### Task B1: `directusQueue` + `directusVolume`

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/directusQueue.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/directusQueue.test.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/directusVolume.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/directusVolume.test.ts`

**Interfaces:**
- Consumes: `ClassicyFileDialogEntry`, `ClassicyFileDialogVolume`, `ClassicyIcons` from `classicy`; `NOTABLE_FLIGHTS` from `../FlightTracker/notableFlights`.
- Produces (used by C3, C4):

```ts
// directusQueue.ts
export const DIRECTUS_URL: string;
export function enqueue<T>(job: () => Promise<T>): Promise<T>;   // global serial queue
export function directusGet(pathAndQuery: string, fetchFn?: typeof fetch): Promise<unknown[]>; // enqueued GET → body.data, throws on !ok

// directusVolume.ts
export const MEDIA_FILE_TYPES: { tv: "tv-channel"; radio: "radio-station"; news: "news-document"; flight: "flight" };
export type DirectusVolumeOptions = {
	tvSlugs: () => string[];        // AvailableSources.video at call time
	radioSlugs: () => string[];     // AvailableSources.audio
	fetchFn?: typeof fetch;
};
export function createDirectusVolume(opts: DirectusVolumeOptions): ClassicyFileDialogVolume; // id "rt911-archive", label "911 Realtime Archive"
```

Leaf `meta` contracts (consumed verbatim by the editor): TV `{ app: "tv", itemId: slug }`; Radio `{ app: "radio", itemId: slug }`; News `{ app: "news", itemId: String(id), publishedAt: start_date }`; Flight `{ app: "flights", itemId: flight, departure: wheels_off_utc, arrival: wheels_on_utc }`.

**Folder layout produced by `list(path)`:**

| `path` | returns |
|---|---|
| `[]` | folders `TV Channels`, `Radio Stations`, `News`, `Flights` |
| `["TV Channels"]` | flat tv-channel files from `tvSlugs()` |
| `["Radio Stations"]` | flat radio-station files from `radioSlugs()` |
| `["News"]` | one folder per publication: `sources` rows (id,slug,title) that appear in the news groupBy — folder name = `title \|\| slug`, folder entry id = `news-src-${id}` |
| `["News", <pub>]` | news-document files: `?filter[source][_eq]=<id>&filter[approved][_eq]=true&fields=id,title,start_date&sort=start_date&limit=1000` — name = title, entry id = `news-${id}` |
| `["Flights"]` | folder `Notable Flights` + one folder per airline (see `AIRLINES` below) |
| `["Flights", "Notable Flights"]` | the four `NOTABLE_FLIGHTS` on 2001-09-11, fetched sequentially |
| `["Flights", <airline>]` | date folders `2001-09-09` … `2001-09-18` |
| `["Flights", <airline>, <date>]` | flight files: `?filter[flight][_starts_with]=<code>&filter[flight_date][_eq]=<date>&fields=flight,origin,scheduled_dest,wheels_off_utc,wheels_on_utc&sort=flight&limit=3000` — name = `` `${flight} — ${origin}→${scheduled_dest}` `` |

```ts
export const AIRLINES: [code: string, name: string][] = [
	["AA", "American Airlines"], ["UA", "United Airlines"], ["DL", "Delta Air Lines"],
	["US", "US Airways"], ["CO", "Continental Airlines"], ["NW", "Northwest Airlines"],
	["TW", "Trans World Airlines"], ["WN", "Southwest Airlines"], ["AS", "Alaska Airlines"],
	["HP", "America West Airlines"],
];
export const FLIGHT_DATES = ["2001-09-09","2001-09-10","2001-09-11","2001-09-12","2001-09-13","2001-09-14","2001-09-15","2001-09-16","2001-09-17","2001-09-18"];
```

Per-folder results cached in a module-level `Map<string, ClassicyFileDialogEntry[]>` keyed by `path.join("/")` — a `list()` hit returns the cached array without enqueueing. Export `__clearDirectusVolumeCache()` for tests.

- [ ] **Step 1: Write the failing queue tests**

`directusQueue.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { directusGet, enqueue } from "./directusQueue";

afterEach(() => vi.clearAllMocks());

describe("enqueue", () => {
	it("runs jobs strictly one at a time, in order", async () => {
		let running = 0;
		let maxRunning = 0;
		const order: number[] = [];
		const job = (n: number) => async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 5));
			order.push(n);
			running -= 1;
			return n;
		};
		const results = await Promise.all([enqueue(job(1)), enqueue(job(2)), enqueue(job(3))]);
		expect(maxRunning).toBe(1);
		expect(order).toEqual([1, 2, 3]);
		expect(results).toEqual([1, 2, 3]);
	});

	it("keeps the chain alive after a rejection", async () => {
		await expect(enqueue(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await expect(enqueue(async () => "ok")).resolves.toBe("ok");
	});
});

describe("directusGet", () => {
	it("GETs DIRECTUS_URL + path and unwraps data", async () => {
		const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1 }] })));
		const rows = await directusGet("/items/sources?fields=id", fetchFn as unknown as typeof fetch);
		expect(rows).toEqual([{ id: 1 }]);
		expect(fetchFn.mock.calls[0][0]).toContain("/items/sources?fields=id");
	});

	it("throws on a non-ok response", async () => {
		const fetchFn = vi.fn(async () => new Response("{}", { status: 403 }));
		await expect(directusGet("/items/nope", fetchFn as unknown as typeof fetch)).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/directusQueue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `directusQueue.ts`**

```ts
// Serialized Directus REST access. api-beta MIXES the response bodies of
// concurrent browser fetches (verified 2026-07-15), so every REST call in the
// editor and its volume goes through this single global chain.
export const DIRECTUS_URL: string =
	import.meta.env?.VITE_DIRECTUS_URL ?? "https://api-beta.911realtime.org";

let chain: Promise<unknown> = Promise.resolve();

export function enqueue<T>(job: () => Promise<T>): Promise<T> {
	const next = chain.then(job, job);
	chain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function directusGet(
	pathAndQuery: string,
	fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
	return enqueue(async () => {
		const res = await fetchFn(`${DIRECTUS_URL}${pathAndQuery}`);
		if (!res.ok) {
			throw new Error(`directus GET ${pathAndQuery} failed: ${res.status}`);
		}
		const body = (await res.json()) as { data?: unknown[] };
		return body.data ?? [];
	});
}
```

- [ ] **Step 4: Run queue tests — PASS, then write the failing volume tests**

`directusVolume.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__clearDirectusVolumeCache,
	createDirectusVolume,
	MEDIA_FILE_TYPES,
} from "./directusVolume";

const sourcesRows = [
	{ id: 7, slug: "nyt", title: "New York Times" },
	{ id: 9, slug: "wapo", title: "Washington Post" },
];
const groupRows = [{ source: 7 }, { source: 9 }];
const newsRows = [
	{ id: 101, title: "Morning Edition", start_date: "2001-09-11T10:00:00Z" },
];
const flightRows = [
	{ flight: "AA11", origin: "BOS", scheduled_dest: "LAX", wheels_off_utc: "2001-09-11T11:59:00.000Z", wheels_on_utc: null },
];

function fetchFor(url: string): unknown[] {
	if (url.includes("/items/sources")) return sourcesRows;
	if (url.includes("groupBy=source")) return groupRows;
	if (url.includes("/items/news_items")) return newsRows;
	if (url.includes("/items/flight_tracks")) return flightRows;
	throw new Error(`unexpected url ${url}`);
}

let inFlight = 0;
let maxInFlight = 0;
const fetchFn = vi.fn(async (url: string) => {
	inFlight += 1;
	maxInFlight = Math.max(maxInFlight, inFlight);
	await new Promise((r) => setTimeout(r, 2));
	inFlight -= 1;
	return new Response(JSON.stringify({ data: fetchFor(url) }));
});

const volume = () =>
	createDirectusVolume({
		tvSlugs: () => ["ABC", "CNN"],
		radioSlugs: () => ["FDNY-Manhattan"],
		fetchFn: fetchFn as unknown as typeof fetch,
	});

beforeEach(() => {
	__clearDirectusVolumeCache();
	maxInFlight = 0;
});
afterEach(() => vi.clearAllMocks());

describe("createDirectusVolume", () => {
	it("lists the four top folders without fetching", async () => {
		const entries = await volume().list([]);
		expect(entries.map((e) => e.name)).toEqual(["TV Channels", "Radio Stations", "News", "Flights"]);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("lists TV channels from the injected slugs with playlist meta", async () => {
		const entries = await volume().list(["TV Channels"]);
		expect(entries[0]).toMatchObject({
			name: "ABC", kind: "file", fileType: MEDIA_FILE_TYPES.tv,
			meta: { app: "tv", itemId: "ABC" },
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("lists News publications from sources + groupBy", async () => {
		const entries = await volume().list(["News"]);
		expect(entries.map((e) => e.name)).toEqual(["New York Times", "Washington Post"]);
		expect(entries[0].kind).toBe("folder");
	});

	it("lists a publication's documents with publishedAt meta", async () => {
		const vol = volume();
		await vol.list(["News"]);
		const entries = await vol.list(["News", "New York Times"]);
		expect(entries[0]).toMatchObject({
			name: "Morning Edition", fileType: MEDIA_FILE_TYPES.news,
			meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" },
		});
	});

	it("lists notable flights with departure/arrival meta", async () => {
		const entries = await volume().list(["Flights", "Notable Flights"]);
		expect(entries[0]).toMatchObject({
			fileType: MEDIA_FILE_TYPES.flight,
			meta: { app: "flights", itemId: "AA11", departure: "2001-09-11T11:59:00.000Z", arrival: null },
		});
	});

	it("lists airline → dates → flights", async () => {
		const vol = volume();
		const airlines = await vol.list(["Flights"]);
		expect(airlines[0].name).toBe("Notable Flights");
		expect(airlines.find((e) => e.name === "American Airlines")).toBeTruthy();
		const dates = await vol.list(["Flights", "American Airlines"]);
		expect(dates.map((d) => d.name)).toContain("2001-09-11");
		const flights = await vol.list(["Flights", "American Airlines", "2001-09-11"]);
		expect(flights[0].name).toBe("AA11 — BOS→LAX");
	});

	it("never overlaps fetches and caches per-folder results", async () => {
		const vol = volume();
		await Promise.all([vol.list(["News"]), vol.list(["Flights", "Notable Flights"])]);
		expect(maxInFlight).toBe(1);
		const calls = fetchFn.mock.calls.length;
		await vol.list(["News"]);
		expect(fetchFn.mock.calls.length).toBe(calls); // cache hit
	});
});
```

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/directusVolume.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `directusVolume.ts`**

```ts
import type { ClassicyFileDialogEntry, ClassicyFileDialogVolume } from "classicy";
import { ClassicyIcons } from "classicy";
import { NOTABLE_FLIGHTS } from "../FlightTracker/notableFlights";
import { directusGet } from "./directusQueue";

export const MEDIA_FILE_TYPES = {
	tv: "tv-channel",
	radio: "radio-station",
	news: "news-document",
	flight: "flight",
} as const;

export const AIRLINES: [string, string][] = [
	["AA", "American Airlines"], ["UA", "United Airlines"], ["DL", "Delta Air Lines"],
	["US", "US Airways"], ["CO", "Continental Airlines"], ["NW", "Northwest Airlines"],
	["TW", "Trans World Airlines"], ["WN", "Southwest Airlines"], ["AS", "Alaska Airlines"],
	["HP", "America West Airlines"],
];

export const FLIGHT_DATES = [
	"2001-09-09", "2001-09-10", "2001-09-11", "2001-09-12", "2001-09-13",
	"2001-09-14", "2001-09-15", "2001-09-16", "2001-09-17", "2001-09-18",
];

export type DirectusVolumeOptions = {
	tvSlugs: () => string[];
	radioSlugs: () => string[];
	fetchFn?: typeof fetch;
};

const cache = new Map<string, ClassicyFileDialogEntry[]>();
// publication folder name → source row id, filled when ["News"] is listed
const publicationIds = new Map<string, number>();

export function __clearDirectusVolumeCache(): void {
	cache.clear();
	publicationIds.clear();
}

const folder = (id: string, name: string, icon?: string): ClassicyFileDialogEntry => ({
	id, name, kind: "folder", icon: icon ?? ClassicyIcons.system.folders.directory,
});

const FLIGHT_FIELDS = "flight,origin,scheduled_dest,wheels_off_utc,wheels_on_utc";

type FlightRow = {
	flight: string; origin: string; scheduled_dest: string;
	wheels_off_utc: string | null; wheels_on_utc: string | null;
};

const flightEntry = (row: FlightRow): ClassicyFileDialogEntry => ({
	id: `flight-${row.flight}`,
	name: `${row.flight} — ${row.origin}→${row.scheduled_dest}`,
	kind: "file",
	fileType: MEDIA_FILE_TYPES.flight,
	meta: {
		app: "flights",
		itemId: row.flight,
		departure: row.wheels_off_utc,
		arrival: row.wheels_on_utc,
	},
});

export function createDirectusVolume(
	opts: DirectusVolumeOptions,
): ClassicyFileDialogVolume {
	const { tvSlugs, radioSlugs, fetchFn } = opts;

	const cached = async (
		key: string,
		make: () => Promise<ClassicyFileDialogEntry[]>,
	): Promise<ClassicyFileDialogEntry[]> => {
		const hit = cache.get(key);
		if (hit) return hit;
		const made = await make();
		cache.set(key, made);
		return made;
	};

	const list = async (path: string[]): Promise<ClassicyFileDialogEntry[]> => {
		const key = path.join("/");

		if (path.length === 0) {
			return [
				folder("tv", "TV Channels"),
				folder("radio", "Radio Stations"),
				folder("news", "News"),
				folder("flights", "Flights"),
			];
		}

		if (path[0] === "TV Channels") {
			return tvSlugs().map((slug) => ({
				id: `tv-${slug}`, name: slug, kind: "file" as const,
				fileType: MEDIA_FILE_TYPES.tv, meta: { app: "tv", itemId: slug },
			}));
		}

		if (path[0] === "Radio Stations") {
			return radioSlugs().map((slug) => ({
				id: `radio-${slug}`, name: slug, kind: "file" as const,
				fileType: MEDIA_FILE_TYPES.radio, meta: { app: "radio", itemId: slug },
			}));
		}

		if (path[0] === "News" && path.length === 1) {
			return cached(key, async () => {
				const sources = (await directusGet(
					"/items/sources?fields=id,slug,title&limit=500", fetchFn,
				)) as { id: number; slug: string; title: string | null }[];
				const groups = (await directusGet(
					"/items/news_items?aggregate[count]=*&groupBy=source", fetchFn,
				)) as { source: number }[];
				const withNews = new Set(groups.map((g) => g.source));
				return sources
					.filter((s) => withNews.has(s.id))
					.map((s) => {
						const name = s.title || s.slug;
						publicationIds.set(name, s.id);
						return folder(`news-src-${s.id}`, name);
					})
					.sort((a, b) => a.name.localeCompare(b.name));
			});
		}

		if (path[0] === "News" && path.length === 2) {
			const sourceId = publicationIds.get(path[1]);
			if (sourceId === undefined) return [];
			return cached(key, async () => {
				const rows = (await directusGet(
					`/items/news_items?filter[source][_eq]=${sourceId}&filter[approved][_eq]=true&fields=id,title,start_date&sort=start_date&limit=1000`,
					fetchFn,
				)) as { id: number; title: string; start_date: string }[];
				return rows.map((r) => ({
					id: `news-${r.id}`, name: r.title, kind: "file" as const,
					fileType: MEDIA_FILE_TYPES.news,
					meta: { app: "news", itemId: String(r.id), publishedAt: r.start_date },
				}));
			});
		}

		if (path[0] === "Flights" && path.length === 1) {
			return [
				folder("notable", "Notable Flights"),
				...AIRLINES.map(([code, name]) => folder(`airline-${code}`, name)),
			];
		}

		if (path[0] === "Flights" && path[1] === "Notable Flights") {
			return cached(key, async () => {
				const entries: ClassicyFileDialogEntry[] = [];
				for (const callsign of NOTABLE_FLIGHTS) {
					const rows = (await directusGet(
						`/items/flight_tracks?filter[flight][_eq]=${callsign}&filter[flight_date][_eq]=2001-09-11&fields=${FLIGHT_FIELDS}&limit=1`,
						fetchFn,
					)) as FlightRow[];
					if (rows[0]) entries.push(flightEntry(rows[0]));
				}
				return entries;
			});
		}

		if (path[0] === "Flights" && path.length === 2) {
			return FLIGHT_DATES.map((d) => folder(`date-${path[1]}-${d}`, d));
		}

		if (path[0] === "Flights" && path.length === 3) {
			const code = AIRLINES.find(([, name]) => name === path[1])?.[0];
			if (!code) return [];
			return cached(key, async () => {
				const rows = (await directusGet(
					`/items/flight_tracks?filter[flight][_starts_with]=${code}&filter[flight_date][_eq]=${path[2]}&fields=${FLIGHT_FIELDS}&sort=flight&limit=3000`,
					fetchFn,
				)) as FlightRow[];
				return rows.map(flightEntry);
			});
		}

		return [];
	};

	return {
		id: "rt911-archive",
		label: "911 Realtime Archive",
		icon: ClassicyIcons.system.drives.networkDrive,
		list,
	};
}
```

- [ ] **Step 6: Run both test files — PASS. Commit**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/`
Expected: PASS.

```bash
cd /home/robbiebyrd/rt911 && git checkout -b feat/playlist-editor
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "feat(playlist-editor): serialized Directus queue + 911 Realtime Archive volume"
```

---

## Phase C — Playlist editor app

### Task C1: App scaffold, auth gating, desktop registration

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/app.png` (copy `packages/frontend/src/Applications/Account/app.png` as the placeholder icon: `cp packages/frontend/src/Applications/Account/app.png packages/frontend/src/Applications/PlaylistEditor/app.png` — user will supply final art)
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.test.tsx`
- Modify: `packages/frontend/src/Desktop.tsx` (add import + `<PlaylistEditor />` child beside `<Account />`)

**Interfaces:**
- Consumes: `useAuth()` (`status`), classicy `ClassicyApp`, `ClassicyWindow`, `ClassicyButton`, `quitAppHelper`, `quitMenuItemHelper`, `useAppManagerDispatch`, `registerClassicyIcons`, `ClassicyIcons`.
- Produces: `appId = "PlaylistEditor.app"`, `appName = "Playlists"`; renders `<PlaylistEditorMain />` (C3) when signed in — for this task, a placeholder `<div>My Playlists</div>` that C2 replaces.

Constants (exact copy): `GATE_MESSAGE = "You must be signed in to create playlists."`.

- [ ] **Step 1: Write the failing tests**

`PlaylistEditor.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const dispatchMock = vi.fn();
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	ClassicyWindow: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
		<div data-testid={`window-${title}`}>{children}</div>
	),
	useAppManagerDispatch: () => dispatchMock,
}));

const mockAuth = vi.hoisted(() => ({
	status: "anonymous" as string,
	user: null as { id: string } | null,
}));
vi.mock("../../Providers/Auth/AuthContext", () => ({
	useAuth: () => mockAuth,
}));

import { PlaylistEditor } from "./PlaylistEditor";

beforeEach(() => {
	mockAuth.status = "anonymous";
	mockAuth.user = null;
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistEditor gating", () => {
	it("shows the sign-in alert with a Quit button when anonymous", () => {
		render(<PlaylistEditor />);
		expect(screen.getByText("You must be signed in to create playlists.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Quit" })).toBeInTheDocument();
		expect(screen.queryByText("My Playlists")).toBeNull();
	});

	it("dispatches a quit action when Quit is clicked", () => {
		render(<PlaylistEditor />);
		fireEvent.click(screen.getByRole("button", { name: "Quit" }));
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({ app: expect.objectContaining({ id: "PlaylistEditor.app" }) }),
		);
	});

	it("renders neither alert nor editor while auth is loading", () => {
		mockAuth.status = "loading";
		render(<PlaylistEditor />);
		expect(screen.queryByText("You must be signed in to create playlists.")).toBeNull();
		expect(screen.queryByText("My Playlists")).toBeNull();
	});

	it("renders the editor when signed in", () => {
		mockAuth.status = "signedIn";
		mockAuth.user = { id: "u1" };
		render(<PlaylistEditor />);
		expect(screen.getByText("My Playlists")).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PlaylistEditor.test.tsx` → FAIL (no module).

- [ ] **Step 3: Implement**

`PlaylistEditor.tsx`:

```tsx
import {
	ClassicyApp,
	ClassicyButton,
	ClassicyIcons,
	ClassicyWindow,
	quitAppHelper,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManagerDispatch,
} from "classicy";
import { useMemo } from "react";
import { useAuth } from "../../Providers/Auth/AuthContext";
import appIconPng from "./app.png";

const appId = "PlaylistEditor.app";
const appName = "Playlists";
export const GATE_MESSAGE = "You must be signed in to create playlists.";

const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		playlistEditor: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.playlistEditor.app;

export function PlaylistEditor() {
	const { status } = useAuth();
	const dispatch = useAppManagerDispatch();

	const appMenu = useMemo(
		() => [
			{
				id: "file",
				title: "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[],
	);

	const quit = () => dispatch(quitAppHelper(appId, appName, appIcon));

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="playlist_editor_main"
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
				<ClassicyWindow
					id="playlist_editor_main"
					appId={appId}
					title={appName}
					icon={appIcon}
					closable={true}
					resizable={true}
					zoomable={true}
					collapsable={false}
					scrollable={true}
					initialSize={[640, 480]}
					initialPosition={[140, 90]}
					appMenu={appMenu}
				>
					<div>My Playlists</div>
				</ClassicyWindow>
			)}
			{/* status === "loading": render no window; auth resolves within a tick of boot */}
		</ClassicyApp>
	);
}
```

`Desktop.tsx`: add `import { PlaylistEditor } from "./Applications/PlaylistEditor/PlaylistEditor";` and a `<PlaylistEditor />` child next to `<Account />`.

- [ ] **Step 4: Run tests — PASS.** Also run the full frontend suite to catch Desktop.tsx fallout: `pnpm --filter @rt911/frontend exec vitest run`

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/ packages/frontend/src/Desktop.tsx
git commit -m "feat(playlist-editor): app scaffold with sign-in gating and Quit alert"
```

### Task C2: My Playlists view

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistList.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistList.test.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.tsx` (replace the `<div>My Playlists</div>` placeholder with view switching)

**Interfaces:**
- Consumes: `listMine`, `getPlaylist`, `createPlaylist`, `deletePlaylist`, `duplicatePlaylist`, `PlaylistSummary`, `PlaylistRecord` from `../../Providers/Auth/playlistApi`; `useAuth().user.id`.
- Produces:

```tsx
export function PlaylistList(props: {
	meId: string;
	onOpen: (record: PlaylistRecord) => void;   // C3 consumes: switches to editor view
}): JSX.Element;
```

Behavior: on mount, `listMine(meId)`; renders rows (title, status, `date_updated`) with a selected row; buttons **New** (`createPlaylist("Untitled Playlist", { version: 1, mode: "annotate", entries: [] })` then `onOpen`), **Open** (`getPlaylist(selected.id)` → `onOpen`), **Duplicate** (`duplicatePlaylist(selected.id)` then refresh), **Delete** (inline confirm strip "Delete `<title>`? Delete / Cancel" — no nested modal windows), **Copy Link** (published rows only: `navigator.clipboard.writeText(`${location.origin}/?playlist=${selected.id}`)`). All api calls `await`ed serially in handlers (never `Promise.all`). `AuthRequiredError` bubbles to PlaylistEditor's gate (status flips via `refresh()` elsewhere); render other errors as an inline message row.

- [ ] **Step 1: Write the failing tests**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
	listMine: vi.fn(),
	getPlaylist: vi.fn(),
	createPlaylist: vi.fn(),
	deletePlaylist: vi.fn(),
	duplicatePlaylist: vi.fn(),
}));
vi.mock("../../Providers/Auth/playlistApi", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...api,
}));

import { PlaylistList } from "./PlaylistList";

const rows = [
	{ id: "p1", title: "Lesson One", status: "draft", date_updated: "2026-07-16T00:00:00Z", user_created: "u1" },
	{ id: "p2", title: "Lesson Two", status: "published", date_updated: null, user_created: "u1" },
];

beforeEach(() => {
	api.listMine.mockResolvedValue(rows);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PlaylistList", () => {
	it("lists the teacher's playlists", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		expect(await screen.findByText("Lesson One")).toBeInTheDocument();
		expect(screen.getByText("Lesson Two")).toBeInTheDocument();
		expect(api.listMine).toHaveBeenCalledWith("u1");
	});

	it("creates and opens a new playlist via New", async () => {
		const record = { id: "p3", title: "Untitled Playlist", status: "draft", definition: { version: 1, mode: "annotate", entries: [] }, date_updated: null, user_created: "u1" };
		api.createPlaylist.mockResolvedValue(record);
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		await screen.findByText("Lesson One");
		fireEvent.click(screen.getByRole("button", { name: "New" }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
		expect(api.createPlaylist).toHaveBeenCalledWith("Untitled Playlist", { version: 1, mode: "annotate", entries: [] });
	});

	it("opens the selected playlist", async () => {
		const record = { ...rows[0], definition: { version: 1, mode: "restrict", entries: [] } };
		api.getPlaylist.mockResolvedValue(record);
		const onOpen = vi.fn();
		render(<PlaylistList meId="u1" onOpen={onOpen} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledWith(record));
	});

	it("requires confirmation before delete, then refreshes", async () => {
		api.deletePlaylist.mockResolvedValue(undefined);
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(api.deletePlaylist).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete “Lesson One”" }));
		await waitFor(() => expect(api.deletePlaylist).toHaveBeenCalledWith("p1"));
		expect(api.listMine).toHaveBeenCalledTimes(2);
	});

	it("shows Copy Link only for published playlists", async () => {
		render(<PlaylistList meId="u1" onOpen={() => {}} />);
		fireEvent.click(await screen.findByText("Lesson One"));
		expect(screen.queryByRole("button", { name: "Copy Link" })).toBeNull();
		fireEvent.click(screen.getByText("Lesson Two"));
		expect(screen.getByRole("button", { name: "Copy Link" })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run — FAIL (no module).**

- [ ] **Step 3: Implement `PlaylistList.tsx`**

```tsx
import { ClassicyButton } from "classicy";
import { useCallback, useEffect, useState } from "react";
import {
	createPlaylist,
	deletePlaylist,
	duplicatePlaylist,
	getPlaylist,
	listMine,
	type PlaylistRecord,
	type PlaylistSummary,
} from "../../Providers/Auth/playlistApi";

const EMPTY_DEFINITION = { version: 1 as const, mode: "annotate" as const, entries: [] };

export function PlaylistList({
	meId,
	onOpen,
}: {
	meId: string;
	onOpen: (record: PlaylistRecord) => void;
}) {
	const [rowsState, setRows] = useState<PlaylistSummary[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setRows(await listMine(meId));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't load playlists.");
		}
	}, [meId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selected = rowsState.find((r) => r.id === selectedId) ?? null;

	const run = (job: () => Promise<void>) => () => {
		setError(null);
		void job().catch((e) =>
			setError(e instanceof Error ? e.message : "Something went wrong."),
		);
	};

	return (
		<div className="playlistList">
			{error && <p className="playlistListError">{error}</p>}
			<ul className="playlistListRows">
				{rowsState.map((r) => (
					<li key={r.id}>
						<button
							type="button"
							className={r.id === selectedId ? "playlistRowSelected" : undefined}
							onClick={() => {
								setSelectedId(r.id);
								setConfirmingDelete(false);
							}}
						>
							{r.title}
							<span className="playlistRowStatus">{r.status}</span>
							<span className="playlistRowDate">{r.date_updated ?? ""}</span>
						</button>
					</li>
				))}
			</ul>
			{confirmingDelete && selected && (
				<div className="playlistDeleteConfirm">
					<span>{`Delete “${selected.title}”? This cannot be undone.`}</span>
					<ClassicyButton
						onClickFunc={run(async () => {
							await deletePlaylist(selected.id);
							setConfirmingDelete(false);
							setSelectedId(null);
							await refresh();
						})}
					>
						{`Delete “${selected.title}”`}
					</ClassicyButton>
					<ClassicyButton onClickFunc={() => setConfirmingDelete(false)}>
						Cancel
					</ClassicyButton>
				</div>
			)}
			<div className="playlistListActions">
				<ClassicyButton
					onClickFunc={run(async () => {
						const record = await createPlaylist("Untitled Playlist", EMPTY_DEFINITION);
						onOpen(record);
					})}
				>
					New
				</ClassicyButton>
				<ClassicyButton
					disabled={!selected}
					onClickFunc={run(async () => {
						if (selected) onOpen(await getPlaylist(selected.id));
					})}
				>
					Open
				</ClassicyButton>
				<ClassicyButton
					disabled={!selected}
					onClickFunc={run(async () => {
						if (selected) {
							await duplicatePlaylist(selected.id);
							await refresh();
						}
					})}
				>
					Duplicate
				</ClassicyButton>
				<ClassicyButton disabled={!selected} onClickFunc={() => setConfirmingDelete(true)}>
					Delete
				</ClassicyButton>
				{selected?.status === "published" && (
					<ClassicyButton
						onClickFunc={() =>
							void navigator.clipboard.writeText(
								`${location.origin}/?playlist=${selected.id}`,
							)
						}
					>
						Copy Link
					</ClassicyButton>
				)}
			</div>
		</div>
	);
}
```

In `PlaylistEditor.tsx`, replace the placeholder with:

```tsx
const [openRecord, setOpenRecord] = useState<PlaylistRecord | null>(null);
// ... inside the signedIn window:
{openRecord === null ? (
	<PlaylistList meId={user?.id ?? ""} onOpen={setOpenRecord} />
) : (
	<div>Editor: {openRecord.title}</div>  // replaced in C3
)}
```

- [ ] **Step 4: Run tests — PASS. Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "feat(playlist-editor): My Playlists list with CRUD + Copy Link"
```

### Task C3: Editor state, entry tree, per-kind forms, file-open wiring

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/editorState.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/editorState.test.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/EntryForm.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/EntryForm.test.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.test.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.tsx` (mount `PlaylistEditorMain`)

**Interfaces:**
- Consumes: `PlaylistEntry`/`PlaylistDefinition`/`PLAYLIST_APPS` from `../../Providers/Playlist/playlistTypes`; `parsePlaylist`; `ClassicyFileOpenDialog`, `ClassicyFileOpenSelection`, `desktopVolume`, `fileSystemVolume`, `ClassicyTree`, `ClassicyDatePicker`, `ClassicyTimePicker`, `ClassicyPopUpMenu`, `ClassicyInput`(text) from classicy; `useClassicyFileSystem()` from classicy for the fs instance; `createDirectusVolume` + `MEDIA_FILE_TYPES` (B1); `useMediaStream().sources` for tv/radio slugs.
- Produces:

```ts
// editorState.ts — pure reducer, exhaustively unit-tested
export type EditorEntry = {
	uid: string;                    // editor-local stable key ("e1", "e2", …)
	entry: PlaylistEntry;
	timelineMeta?: { publishedAt?: string | null; departure?: string | null; arrival?: string | null };
};
export type EditorState = {
	playlistId: string;
	title: string;
	mode: "restrict" | "annotate";
	status: "draft" | "published";
	entries: EditorEntry[];
	selectedUid: string | null;
	dirty: boolean;
	nextUid: number;
};
export type EditorAction =
	| { type: "load"; record: PlaylistRecord }
	| { type: "setTitle"; title: string }
	| { type: "setMode"; mode: "restrict" | "annotate" }
	| { type: "setStatus"; status: "draft" | "published" }
	| { type: "addEntries"; entries: { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[] }
	| { type: "updateEntry"; uid: string; entry: PlaylistEntry }
	| { type: "removeEntry"; uid: string }
	| { type: "select"; uid: string | null }
	| { type: "markSaved" };
export function editorReducer(state: EditorState, action: EditorAction): EditorState;
export function initialEditorState(record: PlaylistRecord): EditorState;   // parses record.definition via parsePlaylist; invalid → empty entries + warning surfaced by caller
export function assembleDefinition(state: EditorState): PlaylistDefinition; // strips uid/timelineMeta
export const DISPLAY_TZ_OFFSET_HOURS = -4;
export function displayWallClockToUtcIso(d: Date): string;
export function utcIsoToDisplayWallClock(iso: string): Date;
export function selectionsToEntries(selections: ClassicyFileOpenSelection[]): { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[];
// media selections (meta.app present) → MediaEntry; local-volume selections (meta.classicyPath) → FileEntry with at = "" (form fills it)
```

- `EntryForm.tsx`: `function EntryForm({ value, onChange }: { value: EditorEntry; onChange: (entry: PlaylistEntry) => void })` — switch on `value.entry.kind`; media: start/end date+time pickers (each nullable via an "unbounded" checkbox) + focus popup (none/once/locked); app: appId popup (options: known app ids `["TimeMachine.app","TV.app","RadioScanner.app","News.app","FlightTracker.app","Browser.app","PDFViewer.app","Weather.app"]`) — `disabled: true` fixed; settings: appId popup + JSON textarea validated on blur (`JSON.parse` → error label on failure); file: read-only path + at pickers; jump: at/to pickers; browser: url text input + at/closeAt pickers.
- `PlaylistEditorMain.tsx`: `function PlaylistEditorMain({ record, onBack }: { record: PlaylistRecord; onBack: () => void })` — composes title input, mode radio, status popup, entry tree (branches Media/Apps/Settings/Files/Jumps/Browser; leaf label = summary like `TV · ABC` or `Jump → 09:03`; leaf `buttons: [Edit, Remove]`), Add-entry buttons (`Add Media…`, `Add File…`, `Add App Rule`, `Add Settings`, `Add Jump`, `Add Browser`), the `EntryForm` for the selected entry, the C4 timeline (placeholder `<div data-testid="timeline-slot" />` until C4), and the C5 save bar (placeholder Save button wired in C5). `Add Media…` opens `ClassicyFileOpenDialog` with volumes `[desktopVolume(fs), fileSystemVolume(fs, "Macintosh HD"), createDirectusVolume({ tvSlugs: () => sources.video, radioSlugs: () => sources.audio })]`, `selectionMode="multi"`, `fileTypeFilters=[{label:"All Media",types:Object.values(MEDIA_FILE_TYPES)},{label:"TV Channels",types:["tv-channel"]},{label:"Radio Stations",types:["radio-station"]},{label:"News",types:["news-document"]},{label:"Flights",types:["flight"]}]`. `Add File…` opens it with local volumes only, `selectionMode="single"`, no filters.

- [ ] **Step 1: Write the failing reducer tests** (`editorState.test.ts` — table-driven; the heart of the task)

```ts
import { describe, expect, it } from "vitest";
import {
	assembleDefinition,
	displayWallClockToUtcIso,
	editorReducer,
	initialEditorState,
	selectionsToEntries,
	utcIsoToDisplayWallClock,
} from "./editorState";

const record = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: {
		version: 1, mode: "restrict",
		entries: [{ kind: "media", app: "tv", itemId: "ABC" }],
	},
};

describe("initialEditorState", () => {
	it("loads a valid definition into uid-keyed entries", () => {
		const s = initialEditorState(record);
		expect(s.entries).toHaveLength(1);
		expect(s.entries[0].uid).toBe("e1");
		expect(s.entries[0].entry).toMatchObject({ kind: "media", itemId: "ABC" });
		expect(s.dirty).toBe(false);
	});
	it("falls back to zero entries on a structurally invalid definition", () => {
		const s = initialEditorState({ ...record, definition: { nope: true } });
		expect(s.entries).toEqual([]);
	});
});

describe("editorReducer", () => {
	const base = initialEditorState(record);
	it("addEntries appends with fresh uids and marks dirty", () => {
		const s = editorReducer(base, {
			type: "addEntries",
			entries: [{ entry: { kind: "media", app: "radio", itemId: "FDNY-Manhattan" } }],
		});
		expect(s.entries).toHaveLength(2);
		expect(s.entries[1].uid).toBe("e2");
		expect(s.dirty).toBe(true);
	});
	it("updateEntry replaces by uid", () => {
		const s = editorReducer(base, {
			type: "updateEntry", uid: "e1",
			entry: { kind: "media", app: "tv", itemId: "ABC", start: "2001-09-11T12:00:00.000Z" },
		});
		expect(s.entries[0].entry).toMatchObject({ start: "2001-09-11T12:00:00.000Z" });
		expect(s.dirty).toBe(true);
	});
	it("removeEntry drops by uid and clears a matching selection", () => {
		const selected = editorReducer(base, { type: "select", uid: "e1" });
		const s = editorReducer(selected, { type: "removeEntry", uid: "e1" });
		expect(s.entries).toEqual([]);
		expect(s.selectedUid).toBeNull();
	});
	it("markSaved clears dirty", () => {
		const dirty = editorReducer(base, { type: "setTitle", title: "New" });
		expect(dirty.dirty).toBe(true);
		expect(editorReducer(dirty, { type: "markSaved" }).dirty).toBe(false);
	});
});

describe("assembleDefinition", () => {
	it("strips editor-local fields", () => {
		const def = assembleDefinition(initialEditorState(record));
		expect(def).toEqual({
			version: 1, mode: "restrict",
			entries: [{ kind: "media", app: "tv", itemId: "ABC" }],
		});
	});
});

describe("timezone helpers", () => {
	it("round-trips a display wall clock through UTC ISO", () => {
		const iso = "2001-09-11T12:40:00.000Z"; // 08:40 EDT
		const wall = utcIsoToDisplayWallClock(iso);
		expect(wall.getHours()).toBe(8);
		expect(wall.getMinutes()).toBe(40);
		expect(displayWallClockToUtcIso(wall)).toBe(iso);
	});
});

describe("selectionsToEntries", () => {
	it("maps media meta to MediaEntry with timelineMeta", () => {
		const out = selectionsToEntries([
			{
				volumeId: "rt911-archive", path: ["News", "NYT"],
				entry: { id: "news-101", name: "Doc", kind: "file", fileType: "news-document",
					meta: { app: "news", itemId: "101", publishedAt: "2001-09-11T10:00:00Z" } },
			},
		]);
		expect(out[0].entry).toEqual({ kind: "media", app: "news", itemId: "101" });
		expect(out[0].timelineMeta).toEqual({ publishedAt: "2001-09-11T10:00:00Z" });
	});
	it("maps classicyPath meta to a FileEntry", () => {
		const out = selectionsToEntries([
			{
				volumeId: "fs-Macintosh HD", path: ["Documents"],
				entry: { id: "x", name: "WTC1.pdf", kind: "file", fileType: "pdf",
					meta: { classicyPath: "Macintosh HD:Documents:WTC1.pdf" } },
			},
		]);
		expect(out[0].entry).toEqual({ kind: "file", path: "Macintosh HD:Documents:WTC1.pdf", at: "" });
	});
});
```

- [ ] **Step 2: Run — FAIL. Implement `editorState.ts`**

```ts
import type { ClassicyFileOpenSelection } from "classicy";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import type {
	PlaylistDefinition,
	PlaylistEntry,
} from "../../Providers/Playlist/playlistTypes";
import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";

export const DISPLAY_TZ_OFFSET_HOURS = -4;

export type EditorEntry = {
	uid: string;
	entry: PlaylistEntry;
	timelineMeta?: {
		publishedAt?: string | null;
		departure?: string | null;
		arrival?: string | null;
	};
};

export type EditorState = {
	playlistId: string;
	title: string;
	mode: "restrict" | "annotate";
	status: "draft" | "published";
	entries: EditorEntry[];
	selectedUid: string | null;
	dirty: boolean;
	nextUid: number;
};

export type EditorAction =
	| { type: "load"; record: PlaylistRecord }
	| { type: "setTitle"; title: string }
	| { type: "setMode"; mode: "restrict" | "annotate" }
	| { type: "setStatus"; status: "draft" | "published" }
	| {
			type: "addEntries";
			entries: { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[];
	  }
	| { type: "updateEntry"; uid: string; entry: PlaylistEntry }
	| { type: "removeEntry"; uid: string }
	| { type: "select"; uid: string | null }
	| { type: "markSaved" };

export function initialEditorState(record: PlaylistRecord): EditorState {
	const parsed = parsePlaylist(record.definition);
	const entries = (parsed.definition?.entries ?? []).map((entry, i) => ({
		uid: `e${i + 1}`,
		entry,
	}));
	return {
		playlistId: record.id,
		title: record.title,
		mode: parsed.definition?.mode ?? "annotate",
		status: record.status === "published" ? "published" : "draft",
		entries,
		selectedUid: null,
		dirty: false,
		nextUid: entries.length + 1,
	};
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
	switch (action.type) {
		case "load":
			return initialEditorState(action.record);
		case "setTitle":
			return { ...state, title: action.title, dirty: true };
		case "setMode":
			return { ...state, mode: action.mode, dirty: true };
		case "setStatus":
			return { ...state, status: action.status, dirty: true };
		case "addEntries": {
			let next = state.nextUid;
			const added = action.entries.map((e) => ({
				uid: `e${next++}`,
				entry: e.entry,
				timelineMeta: e.timelineMeta,
			}));
			return { ...state, entries: [...state.entries, ...added], nextUid: next, dirty: true };
		}
		case "updateEntry":
			return {
				...state,
				entries: state.entries.map((e) =>
					e.uid === action.uid ? { ...e, entry: action.entry } : e,
				),
				dirty: true,
			};
		case "removeEntry":
			return {
				...state,
				entries: state.entries.filter((e) => e.uid !== action.uid),
				selectedUid: state.selectedUid === action.uid ? null : state.selectedUid,
				dirty: true,
			};
		case "select":
			return { ...state, selectedUid: action.uid };
		case "markSaved":
			return { ...state, dirty: false };
	}
}

export function assembleDefinition(state: EditorState): PlaylistDefinition {
	return { version: 1, mode: state.mode, entries: state.entries.map((e) => e.entry) };
}

export function displayWallClockToUtcIso(d: Date): string {
	const utcMs =
		Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) -
		DISPLAY_TZ_OFFSET_HOURS * 3600_000;
	return new Date(utcMs).toISOString();
}

export function utcIsoToDisplayWallClock(iso: string): Date {
	const displayMs = playlistUtcMs(iso) + DISPLAY_TZ_OFFSET_HOURS * 3600_000;
	const u = new Date(displayMs);
	return new Date(
		u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
		u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds(),
	);
}

export function selectionsToEntries(
	selections: ClassicyFileOpenSelection[],
): { entry: PlaylistEntry; timelineMeta?: EditorEntry["timelineMeta"] }[] {
	return selections.flatMap((sel) => {
		const meta = sel.entry.meta ?? {};
		if (typeof meta.app === "string" && typeof meta.itemId === "string") {
			const timelineMeta: EditorEntry["timelineMeta"] = {};
			if ("publishedAt" in meta) timelineMeta.publishedAt = meta.publishedAt as string | null;
			if ("departure" in meta) timelineMeta.departure = meta.departure as string | null;
			if ("arrival" in meta) timelineMeta.arrival = meta.arrival as string | null;
			return [{
				entry: {
					kind: "media",
					app: meta.app as "tv" | "radio" | "news" | "flights",
					itemId: meta.itemId,
				} as PlaylistEntry,
				timelineMeta: Object.keys(timelineMeta).length > 0 ? timelineMeta : undefined,
			}];
		}
		if (typeof meta.classicyPath === "string") {
			return [{ entry: { kind: "file", path: meta.classicyPath, at: "" } as PlaylistEntry }];
		}
		return [];
	});
}
```

- [ ] **Step 3: Run reducer tests — PASS.**

- [ ] **Step 4: Write failing `EntryForm` tests, then implement**

`EntryForm.test.tsx` (representative — media windows and settings JSON validation):

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntryForm } from "./EntryForm";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("EntryForm", () => {
	it("edits a media entry's focus mode", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "media", app: "tv", itemId: "ABC" } }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByRole("combobox", { name: /focus/i }), { target: { value: "locked" } });
		expect(onChange).toHaveBeenCalledWith({ kind: "media", app: "tv", itemId: "ABC", focus: "locked" });
	});

	it("flags invalid settings JSON on blur without calling onChange", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "settings", appId: "TV.app", values: {} } }}
				onChange={onChange}
			/>,
		);
		const area = screen.getByRole("textbox", { name: /values/i });
		fireEvent.change(area, { target: { value: "{not json" } });
		fireEvent.blur(area);
		expect(screen.getByText(/invalid JSON/i)).toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("edits a browser entry's url", () => {
		const onChange = vi.fn();
		render(
			<EntryForm
				value={{ uid: "e1", entry: { kind: "browser", url: "http://cnn.com", at: "2001-09-11T13:00:00.000Z" } }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByRole("textbox", { name: /url/i }), { target: { value: "http://nyt.com" } });
		expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ url: "http://nyt.com" }));
	});
});
```

`EntryForm.tsx` — one component, switch on kind. Datetime sub-editor used by every timed field:

```tsx
import { ClassicyDatePicker, ClassicyTimePicker } from "classicy";
import { useState } from "react";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import {
	displayWallClockToUtcIso,
	type EditorEntry,
	utcIsoToDisplayWallClock,
} from "./editorState";

const TIMELINE_MIN = new Date(2001, 8, 9);   // Sept 9 2001 (display wall clock)
const TIMELINE_MAX = new Date(2001, 8, 18, 23, 59, 59);
const KNOWN_APP_IDS = [
	"TimeMachine.app", "TV.app", "RadioScanner.app", "News.app",
	"FlightTracker.app", "Browser.app", "PDFViewer.app", "Weather.app",
];

function DateTimeField({
	label, value, optional, onChange,
}: {
	label: string;
	value: string | undefined;
	optional?: boolean;               // renders the "unbounded" checkbox
	onChange: (iso: string | undefined) => void;
}) {
	const wall = value ? utcIsoToDisplayWallClock(value) : null;
	const setFrom = (d: Date) => onChange(displayWallClockToUtcIso(d));
	return (
		<fieldset className="entryFormField">
			<legend>{label}</legend>
			{optional && (
				<label>
					<input
						type="checkbox"
						checked={value === undefined}
						onChange={(e) =>
							onChange(e.target.checked ? undefined : displayWallClockToUtcIso(new Date(2001, 8, 11, 8, 40)))
						}
					/>
					unbounded
				</label>
			)}
			{value !== undefined && (
				<>
					<ClassicyDatePicker
						id={`${label}-date`}
						prefillValue={wall ?? undefined}
						minValue={TIMELINE_MIN}
						maxValue={TIMELINE_MAX}
						onChangeFunc={(d) => {
							const merged = new Date(d);
							if (wall) merged.setHours(wall.getHours(), wall.getMinutes(), wall.getSeconds());
							setFrom(merged);
						}}
					/>
					<ClassicyTimePicker
						id={`${label}-time`}
						prefillValue={wall ?? undefined}
						onChangeFunc={(d) => {
							const merged = wall ? new Date(wall) : new Date(2001, 8, 11);
							merged.setHours(d.getHours(), d.getMinutes(), d.getSeconds());
							setFrom(merged);
						}}
					/>
				</>
			)}
		</fieldset>
	);
}
```

(If `ClassicyTimePicker.onChangeFunc` turns out to deliver something other than a `Date` at implementation time, read its `.d.ts` in `node_modules/classicy/dist/types` and adapt the two `onChangeFunc` lambdas only — the `DateTimeField` contract with the rest of the form stays `(iso|undefined) → onChange`.)

The `EntryForm` switch (complete):

```tsx
export function EntryForm({
	value,
	onChange,
}: {
	value: EditorEntry;
	onChange: (entry: PlaylistEntry) => void;
}) {
	const e = value.entry;
	const [jsonError, setJsonError] = useState(false);
	const [jsonDraft, setJsonDraft] = useState<string | null>(null);

	switch (e.kind) {
		case "media":
			return (
				<div className="entryForm">
					<p>{`${e.app.toUpperCase()} · ${e.itemId}`}</p>
					<DateTimeField label="Start" optional value={e.start} onChange={(start) => onChange({ ...e, start })} />
					<DateTimeField label="End" optional value={e.end} onChange={(end) => onChange({ ...e, end })} />
					<label>
						Focus
						<select
							aria-label="Focus"
							value={e.focus ?? "none"}
							onChange={(ev) =>
								onChange({ ...e, focus: ev.target.value === "none" ? undefined : (ev.target.value as "once" | "locked") })
							}
						>
							<option value="none">None</option>
							<option value="once">Once</option>
							<option value="locked">Locked</option>
						</select>
					</label>
				</div>
			);
		case "app":
			return (
				<div className="entryForm">
					<label>
						App
						<select aria-label="App" value={e.appId} onChange={(ev) => onChange({ ...e, appId: ev.target.value })}>
							{KNOWN_APP_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
						</select>
					</label>
					<p>This app will be disabled for the whole session.</p>
				</div>
			);
		case "settings":
			return (
				<div className="entryForm">
					<label>
						App
						<select aria-label="App" value={e.appId} onChange={(ev) => onChange({ ...e, appId: ev.target.value })}>
							{KNOWN_APP_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
						</select>
					</label>
					<label>
						Values
						<textarea
							aria-label="Values"
							defaultValue={JSON.stringify(e.values, null, 2)}
							onChange={(ev) => setJsonDraft(ev.target.value)}
							onBlur={() => {
								if (jsonDraft === null) return;
								try {
									onChange({ ...e, values: JSON.parse(jsonDraft) });
									setJsonError(false);
								} catch {
									setJsonError(true);
								}
							}}
						/>
					</label>
					{jsonError && <p className="entryFormError">Invalid JSON — not applied.</p>}
					<label>
						<input type="checkbox" checked={e.locked ?? false}
							onChange={(ev) => onChange({ ...e, locked: ev.target.checked || undefined })} />
						Locked (revert student changes)
					</label>
				</div>
			);
		case "file":
			return (
				<div className="entryForm">
					<p>{e.path}</p>
					<DateTimeField label="Open at" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
				</div>
			);
		case "jump":
			return (
				<div className="entryForm">
					<DateTimeField label="When clock reaches" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
					<DateTimeField label="Jump to" value={e.to || undefined} onChange={(to) => onChange({ ...e, to: to ?? "" })} />
				</div>
			);
		case "browser":
			return (
				<div className="entryForm">
					<label>
						URL
						<input aria-label="URL" type="text" value={e.url} onChange={(ev) => onChange({ ...e, url: ev.target.value })} />
					</label>
					<DateTimeField label="Open at" value={e.at || undefined} onChange={(at) => onChange({ ...e, at: at ?? "" })} />
					<DateTimeField label="Close at" optional value={e.closeAt} onChange={(closeAt) => onChange({ ...e, closeAt })} />
				</div>
			);
	}
}
```

(Native `<select>`/`<textarea>`/`<input type=text>` are deliberate here — `ClassicyPopUpMenu` wraps a native select with the same semantics, and the SignInForm precedent already uses plain inputs styled by app CSS; swap in Classicy controls 1:1 during visual polish if desired without changing tests.)

- [ ] **Step 5: Write failing `PlaylistEditorMain` tests, then implement**

`PlaylistEditorMain.test.tsx` (mocks `ClassicyFileOpenDialog` to a stub that exposes its props; mocks `useMediaStream` to `{ sources: { video: ["ABC"], audio: ["KCBS"], pager: [], usenet: [] } }`; mocks `useClassicyFileSystem` to a fixture fs):

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<typeof import("classicy")>()),
	ClassicyFileOpenDialog: (props: Record<string, unknown>) => {
		dialogProps.current = props;
		return props.open ? <div data-testid="file-open-dialog" /> : null;
	},
	useClassicyFileSystem: () => ({ fs: {}, separator: ":", resolve: () => undefined }),
}));
vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({ sources: { video: ["ABC"], audio: ["KCBS"], pager: [], usenet: [] } }),
}));

import { PlaylistEditorMain } from "./PlaylistEditorMain";

const record = {
	id: "p1", title: "Lesson", status: "draft" as const, date_updated: null, user_created: "u1",
	definition: { version: 1, mode: "restrict", entries: [{ kind: "media", app: "tv", itemId: "ABC" }] },
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	dialogProps.current = null;
});

describe("PlaylistEditorMain", () => {
	it("renders entry-kind branches and the loaded entry", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		expect(screen.getByText("Media")).toBeInTheDocument();
		expect(screen.getByText("TV · ABC")).toBeInTheDocument();
	});

	it("opens the file dialog in multi mode for Add Media…", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		expect(screen.getByTestId("file-open-dialog")).toBeInTheDocument();
		expect(dialogProps.current?.selectionMode).toBe("multi");
		expect((dialogProps.current?.volumes as { id: string }[]).map((v) => v.id))
			.toEqual(["desktop", "fs-Macintosh HD", "rt911-archive"]);
	});

	it("adds entries from a dialog selection", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add Media…" }));
		(dialogProps.current?.onOpenFunc as (s: unknown[]) => void)([
			{ volumeId: "rt911-archive", path: ["Radio Stations"],
				entry: { id: "radio-KCBS", name: "KCBS", kind: "file", fileType: "radio-station",
					meta: { app: "radio", itemId: "KCBS" } } },
		]);
		expect(screen.getByText("RADIO · KCBS")).toBeInTheDocument();
	});

	it("selects an entry for editing via its Edit button and removes via Remove", () => {
		render(<PlaylistEditorMain record={record} onBack={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(screen.getByRole("combobox", { name: /focus/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(screen.queryByText("TV · ABC")).toBeNull();
	});
});
```

`PlaylistEditorMain.tsx` (complete):

```tsx
import {
	ClassicyButton,
	ClassicyFileOpenDialog,
	type ClassicyFileOpenSelection,
	ClassicyTree,
	type ClassicyTreeNode,
	desktopVolume,
	fileSystemVolume,
	useClassicyFileSystem,
} from "classicy";
import { useMemo, useReducer, useState } from "react";
import type { PlaylistRecord } from "../../Providers/Auth/playlistApi";
import type { PlaylistEntry } from "../../Providers/Playlist/playlistTypes";
import { useMediaStream } from "../../Providers/MediaStream/useMediaStream";
import { createDirectusVolume, MEDIA_FILE_TYPES } from "./directusVolume";
import {
	editorReducer,
	type EditorEntry,
	initialEditorState,
	selectionsToEntries,
	utcIsoToDisplayWallClock,
} from "./editorState";
import { EntryForm } from "./EntryForm";

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

export function PlaylistEditorMain({
	record,
	onBack,
}: {
	record: PlaylistRecord;
	onBack: () => void;
}) {
	const [state, dispatch] = useReducer(editorReducer, record, initialEditorState);
	const [dialogMode, setDialogMode] = useState<"media" | "file" | null>(null);
	const fs = useClassicyFileSystem();
	const { sources } = useMediaStream();

	const localVolumes = useMemo(
		() => [desktopVolume(fs), fileSystemVolume(fs, "Macintosh HD")],
		[fs],
	);
	const archiveVolume = useMemo(
		() =>
			createDirectusVolume({
				tvSlugs: () => sources.video,
				radioSlugs: () => sources.audio,
			}),
		// sources object identity changes on WS updates; slugs are read lazily
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

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

	const handleDialogOpen = (selections: ClassicyFileOpenSelection[]) => {
		dispatch({ type: "addEntries", entries: selectionsToEntries(selections) });
		setDialogMode(null);
	};

	return (
		<div className="playlistEditorMain">
			<div className="playlistEditorHeader">
				<ClassicyButton onClickFunc={onBack}>‹ My Playlists</ClassicyButton>
				<label>
					Title
					<input
						aria-label="Title"
						type="text"
						value={state.title}
						onChange={(e) => dispatch({ type: "setTitle", title: e.target.value })}
					/>
				</label>
				<label>
					<input type="radio" name="mode" checked={state.mode === "restrict"}
						onChange={() => dispatch({ type: "setMode", mode: "restrict" })} />
					Restrict
				</label>
				<label>
					<input type="radio" name="mode" checked={state.mode === "annotate"}
						onChange={() => dispatch({ type: "setMode", mode: "annotate" })} />
					Annotate
				</label>
				<select aria-label="Status" value={state.status}
					onChange={(e) => dispatch({ type: "setStatus", status: e.target.value as "draft" | "published" })}>
					<option value="draft">Draft</option>
					<option value="published">Published</option>
				</select>
			</div>

			<div className="playlistEditorAddBar">
				<ClassicyButton onClickFunc={() => setDialogMode("media")}>Add Media…</ClassicyButton>
				<ClassicyButton onClickFunc={() => setDialogMode("file")}>Add File…</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "app", appId: "TimeMachine.app", disabled: true } }] })}>Add App Rule</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "settings", appId: "TV.app", values: {} } }] })}>Add Settings</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "jump", at: "", to: "" } }] })}>Add Jump</ClassicyButton>
				<ClassicyButton onClickFunc={() => dispatch({ type: "addEntries", entries: [{ entry: { kind: "browser", url: "http://", at: "" } }] })}>Add Browser</ClassicyButton>
			</div>

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

			<div data-testid="timeline-slot" />

			<ClassicyFileOpenDialog
				id="playlist_editor_open"
				appId="PlaylistEditor.app"
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
		</div>
	);
}
```

Wire into `PlaylistEditor.tsx`: replace `<div>Editor: {openRecord.title}</div>` with `<PlaylistEditorMain record={openRecord} onBack={() => setOpenRecord(null)} />`.

- [ ] **Step 6: Run all PlaylistEditor tests — PASS. Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "feat(playlist-editor): full-definition editing with File Open dialog integration"
```

### Task C4: `PlaylistTimeline`

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/timelineLayout.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/timelineLayout.test.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistTimeline.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PlaylistTimeline.test.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/resolveTimelineMeta.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/resolveTimelineMeta.test.ts`
- Modify: `PlaylistEditorMain.tsx` (replace `data-testid="timeline-slot"` with `<PlaylistTimeline …/>`)

**Interfaces:**

```ts
// timelineLayout.ts — pure math
export const TIMELINE_START_MS: number;  // Date.UTC(2001, 8, 9)
export const TIMELINE_END_MS: number;    // Date.UTC(2001, 8, 19)
export function timeToFraction(iso: string): number;  // 0..1, clamped; playlistUtcMs based
export type TimelineBar = { uid: string; label: string; group: "tv" | "radio" | "flights"; startFrac: number; endFrac: number; fadeStart: boolean; fadeEnd: boolean; focus?: "once" | "locked"; actualStartFrac?: number; actualEndFrac?: number };
export type TimelineFlag = { uid: string; label: string; kindGlyph: "news" | "jump" | "file" | "browser"; atFrac: number; extentEndFrac?: number; row: number };
export function layoutBars(entries: EditorEntry[]): TimelineBar[];
export function layoutFlags(entries: EditorEntry[], minGapFrac?: number): TimelineFlag[];  // stagger: rows 0..2 round-robin when flags are closer than minGapFrac (default 0.015)

// resolveTimelineMeta.ts
export function resolveTimelineMeta(entries: EditorEntry[], fetchFn?: typeof fetch): Promise<Map<string, EditorEntry["timelineMeta"]>>;
// sequential (directusQueue) lookups for news (publishedAt ← news_items start_date) and
// flights (departure/arrival ← flight_tracks wheels_off/on, flight_date 2001-09-11 first match)
// ONLY for entries whose timelineMeta is undefined; returns uid → meta

// PlaylistTimeline.tsx
export function PlaylistTimeline(props: {
	entries: EditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
}): JSX.Element;
```

Layout rules (implement exactly): media `tv`/`radio`/`flights` → bars (missing `start` → `startFrac=0, fadeStart=true`; missing `end` → `endFrac=1, fadeEnd=true`); flight bars with `timelineMeta.departure/arrival` also get `actualStartFrac/actualEndFrac`. Media `news` → flag at `timelineMeta.publishedAt ?? start ?? timeline origin`, plus `extentEndFrac` when an explicit `start`+`end` window exists (flag plants at `start` in that case). `jump`/`file`/`browser` entries with a non-empty `at` → flags; entries with empty `at` are omitted. `app`/`settings` never appear. Bars grouped/ordered tv → radio → flights, one lane per entry, stable by uid. Rendering: absolutely positioned divs (`left/width` percentages from fractions), click → `onSelect(uid)`, `title` attribute = exact display times via `utcIsoToDisplayWallClock`, hour ticks every 6h + day labels along the top from `TIMELINE_START_MS`.

- [ ] **Step 1: Failing layout tests** (`timelineLayout.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { layoutBars, layoutFlags, timeToFraction } from "./timelineLayout";

const media = (uid: string, entry: object, timelineMeta?: object) =>
	({ uid, entry: { kind: "media", app: "tv", itemId: uid, ...entry }, timelineMeta }) as never;

describe("timeToFraction", () => {
	it("maps the window ends to 0 and 1 and clamps outside", () => {
		expect(timeToFraction("2001-09-09T00:00:00.000Z")).toBe(0);
		expect(timeToFraction("2001-09-19T00:00:00.000Z")).toBe(1);
		expect(timeToFraction("2001-08-01T00:00:00.000Z")).toBe(0);
		expect(timeToFraction("2001-09-14T00:00:00.000Z")).toBeCloseTo(0.5);
	});
});

describe("layoutBars", () => {
	it("renders unbounded edges as full-range fades", () => {
		const [bar] = layoutBars([media("e1", {})]);
		expect(bar).toMatchObject({ startFrac: 0, endFrac: 1, fadeStart: true, fadeEnd: true });
	});
	it("windows and flight actual spans map to fractions", () => {
		const [bar] = layoutBars([
			media("e2", { app: "flights", itemId: "AA11", start: "2001-09-11T00:00:00Z", end: "2001-09-12T00:00:00Z" },
				{ departure: "2001-09-11T11:59:00Z", arrival: null }),
		]);
		expect(bar.group).toBe("flights");
		expect(bar.startFrac).toBeCloseTo(2 / 10);
		expect(bar.endFrac).toBeCloseTo(3 / 10);
		expect(bar.actualStartFrac).toBeCloseTo((2 + 11.983 / 24) / 10, 3);
		expect(bar.actualEndFrac).toBeUndefined();
	});
	it("excludes news from bars", () => {
		expect(layoutBars([media("e3", { app: "news", itemId: "9" })])).toEqual([]);
	});
});

describe("layoutFlags", () => {
	it("plants news flags at publishedAt and staggers near-coincident flags", () => {
		const flags = layoutFlags([
			media("n1", { app: "news", itemId: "1" }, { publishedAt: "2001-09-11T12:00:00Z" }),
			media("n2", { app: "news", itemId: "2" }, { publishedAt: "2001-09-11T12:05:00Z" }),
			{ uid: "j1", entry: { kind: "jump", at: "2001-09-11T13:00:00Z", to: "2001-09-11T10:00:00Z" } } as never,
		]);
		expect(flags).toHaveLength(3);
		expect(flags[0].row).toBe(0);
		expect(flags[1].row).toBe(1);         // < minGap from n1 → bumped a row
		expect(flags.find((f) => f.uid === "j1")?.kindGlyph).toBe("jump");
	});
	it("omits point entries with an empty at", () => {
		expect(layoutFlags([{ uid: "j2", entry: { kind: "jump", at: "", to: "" } } as never])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run — FAIL. Implement `timelineLayout.ts`**

```ts
import { playlistUtcMs } from "../../Providers/Playlist/playlistTypes";
import type { EditorEntry } from "./editorState";

export const TIMELINE_START_MS = Date.UTC(2001, 8, 9);
export const TIMELINE_END_MS = Date.UTC(2001, 8, 19);
const SPAN = TIMELINE_END_MS - TIMELINE_START_MS;

export function timeToFraction(iso: string): number {
	const frac = (playlistUtcMs(iso) - TIMELINE_START_MS) / SPAN;
	return Math.min(1, Math.max(0, frac));
}

export type TimelineBar = {
	uid: string; label: string; group: "tv" | "radio" | "flights";
	startFrac: number; endFrac: number; fadeStart: boolean; fadeEnd: boolean;
	focus?: "once" | "locked"; actualStartFrac?: number; actualEndFrac?: number;
};

export type TimelineFlag = {
	uid: string; label: string; kindGlyph: "news" | "jump" | "file" | "browser";
	atFrac: number; extentEndFrac?: number; row: number;
};

const BAR_GROUPS = ["tv", "radio", "flights"] as const;

export function layoutBars(entries: EditorEntry[]): TimelineBar[] {
	const bars: TimelineBar[] = [];
	for (const group of BAR_GROUPS) {
		for (const e of entries) {
			if (e.entry.kind !== "media" || e.entry.app !== group) continue;
			const bar: TimelineBar = {
				uid: e.uid,
				label: e.entry.itemId,
				group,
				startFrac: e.entry.start ? timeToFraction(e.entry.start) : 0,
				endFrac: e.entry.end ? timeToFraction(e.entry.end) : 1,
				fadeStart: !e.entry.start,
				fadeEnd: !e.entry.end,
				focus: e.entry.focus,
			};
			if (group === "flights") {
				if (e.timelineMeta?.departure) bar.actualStartFrac = timeToFraction(e.timelineMeta.departure);
				if (e.timelineMeta?.arrival) bar.actualEndFrac = timeToFraction(e.timelineMeta.arrival);
			}
			bars.push(bar);
		}
	}
	return bars;
}

export function layoutFlags(entries: EditorEntry[], minGapFrac = 0.015): TimelineFlag[] {
	const raw: Omit<TimelineFlag, "row">[] = [];
	for (const e of entries) {
		if (e.entry.kind === "media" && e.entry.app === "news") {
			const at = e.entry.start ?? e.timelineMeta?.publishedAt ?? null;
			const hasWindow = Boolean(e.entry.start && e.entry.end);
			raw.push({
				uid: e.uid,
				label: e.entry.itemId,
				kindGlyph: "news",
				atFrac: at ? timeToFraction(at) : 0,
				extentEndFrac: hasWindow && e.entry.end ? timeToFraction(e.entry.end) : undefined,
			});
		} else if (e.entry.kind === "jump" && e.entry.at) {
			raw.push({ uid: e.uid, label: "Jump", kindGlyph: "jump", atFrac: timeToFraction(e.entry.at) });
		} else if (e.entry.kind === "file" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.path.split(":").pop() ?? e.entry.path, kindGlyph: "file", atFrac: timeToFraction(e.entry.at) });
		} else if (e.entry.kind === "browser" && e.entry.at) {
			raw.push({ uid: e.uid, label: e.entry.url, kindGlyph: "browser", atFrac: timeToFraction(e.entry.at) });
		}
	}
	raw.sort((a, b) => a.atFrac - b.atFrac);
	const lastAtInRow: number[] = [];
	return raw.map((f) => {
		let row = 0;
		while (lastAtInRow[row] !== undefined && f.atFrac - lastAtInRow[row] < minGapFrac) row += 1;
		lastAtInRow[row] = f.atFrac;
		return { ...f, row };
	});
}
```

- [ ] **Step 3: Failing `resolveTimelineMeta` test, then implement**

Test: two entries, one news without meta and one flight without meta; mocked `fetchFn` returns `start_date` / `wheels_*`; assert the returned map keys and that a news entry that already has meta is not fetched.

```ts
// resolveTimelineMeta.ts
import type { EditorEntry } from "./editorState";
import { directusGet } from "./directusQueue";

export async function resolveTimelineMeta(
	entries: EditorEntry[],
	fetchFn?: typeof fetch,
): Promise<Map<string, EditorEntry["timelineMeta"]>> {
	const out = new Map<string, EditorEntry["timelineMeta"]>();
	for (const e of entries) {
		if (e.entry.kind !== "media" || e.timelineMeta !== undefined) continue;
		try {
			if (e.entry.app === "news") {
				const rows = (await directusGet(
					`/items/news_items/${encodeURIComponent(e.entry.itemId)}?fields=start_date`,
					fetchFn,
				)) as unknown as { start_date?: string };
				// single-item reads return an object, not an array
				const row = Array.isArray(rows) ? rows[0] : rows;
				if (row?.start_date) out.set(e.uid, { publishedAt: row.start_date });
			} else if (e.entry.app === "flights") {
				const rows = (await directusGet(
					`/items/flight_tracks?filter[flight][_eq]=${encodeURIComponent(e.entry.itemId)}&filter[flight_date][_eq]=2001-09-11&fields=wheels_off_utc,wheels_on_utc&limit=1`,
					fetchFn,
				)) as { wheels_off_utc: string | null; wheels_on_utc: string | null }[];
				if (rows[0]) out.set(e.uid, { departure: rows[0].wheels_off_utc, arrival: rows[0].wheels_on_utc });
			}
		} catch {
			// missing meta only degrades the timeline display; never block the editor
		}
	}
	return out;
}
```

(Note: `directusGet` unwraps `body.data`; for `/items/<collection>/<id>` Directus returns `data: {…}` — the `Array.isArray` guard above handles both shapes.)

- [ ] **Step 4: Implement `PlaylistTimeline.tsx` + a light render test**

```tsx
import { useEffect, useMemo, useState } from "react";
import type { EditorEntry } from "./editorState";
import { resolveTimelineMeta } from "./resolveTimelineMeta";
import {
	layoutBars,
	layoutFlags,
	TIMELINE_START_MS,
} from "./timelineLayout";

const DAY_MS = 24 * 3600_000;

export function PlaylistTimeline({
	entries,
	selectedUid,
	onSelect,
}: {
	entries: EditorEntry[];
	selectedUid: string | null;
	onSelect: (uid: string) => void;
}) {
	const [resolved, setResolved] = useState<Map<string, EditorEntry["timelineMeta"]>>(new Map());

	useEffect(() => {
		let cancelled = false;
		void resolveTimelineMeta(entries).then((m) => {
			if (!cancelled && m.size > 0) setResolved(m);
		});
		return () => {
			cancelled = true;
		};
	}, [entries]);

	const merged = useMemo(
		() => entries.map((e) => (resolved.has(e.uid) ? { ...e, timelineMeta: resolved.get(e.uid) } : e)),
		[entries, resolved],
	);
	const bars = useMemo(() => layoutBars(merged), [merged]);
	const flags = useMemo(() => layoutFlags(merged), [merged]);
	const flagRows = flags.reduce((m, f) => Math.max(m, f.row), 0) + 1;

	return (
		<div className="playlistTimeline" data-testid="playlist-timeline">
			<div className="playlistTimelineRuler">
				{Array.from({ length: 11 }, (_, day) => (
					<span key={day} className="playlistTimelineDayTick" style={{ left: `${day * 10}%` }}>
						{new Date(TIMELINE_START_MS + day * DAY_MS).toISOString().slice(5, 10)}
					</span>
				))}
			</div>
			<div className="playlistTimelineFlagRow" style={{ height: `${flagRows * 18}px` }}>
				{flags.map((f) => (
					<button
						key={f.uid}
						type="button"
						className={`playlistTimelineFlag playlistTimelineFlag-${f.kindGlyph}`}
						style={{ left: `${f.atFrac * 100}%`, top: `${f.row * 18}px` }}
						title={f.label}
						onClick={() => onSelect(f.uid)}
					>
						⚑
					</button>
				))}
				{flags.filter((f) => f.extentEndFrac !== undefined).map((f) => (
					<span
						key={`${f.uid}-extent`}
						className="playlistTimelineFlagExtent"
						style={{
							left: `${f.atFrac * 100}%`,
							width: `${((f.extentEndFrac ?? f.atFrac) - f.atFrac) * 100}%`,
							top: `${f.row * 18 + 14}px`,
						}}
					/>
				))}
			</div>
			<div className="playlistTimelineLanes">
				{bars.map((b) => (
					<div key={b.uid} className={`playlistTimelineLane playlistTimelineLane-${b.group}`}>
						<button
							type="button"
							className={
								b.uid === selectedUid
									? "playlistTimelineBar playlistTimelineBarSelected"
									: "playlistTimelineBar"
							}
							style={{
								left: `${b.startFrac * 100}%`,
								width: `${(b.endFrac - b.startFrac) * 100}%`,
								...(b.fadeStart ? { maskImage: "linear-gradient(to right, transparent, black 12px)" } : {}),
								...(b.fadeEnd ? { maskImage: "linear-gradient(to left, transparent, black 12px)" } : {}),
							}}
							title={b.label}
							onClick={() => onSelect(b.uid)}
						>
							{b.focus === "once" && <span aria-hidden>▸</span>}
							{b.focus === "locked" && <span aria-hidden>🔒</span>}
							{b.label}
							{b.actualStartFrac !== undefined && (
								<span
									className="playlistTimelineActualSpan"
									style={{
										left: `${((b.actualStartFrac - b.startFrac) / (b.endFrac - b.startFrac)) * 100}%`,
										width: `${(((b.actualEndFrac ?? b.endFrac) - b.actualStartFrac) / (b.endFrac - b.startFrac)) * 100}%`,
									}}
								/>
							)}
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
```

Render test (`PlaylistTimeline.test.tsx`): mock `./resolveTimelineMeta` to resolve an empty map; render with one windowed tv entry + one news entry with `publishedAt`; assert one `.playlistTimelineBar` (by title) and one flag button exist, and clicking each calls `onSelect` with the right uid. Include `afterEach(cleanup)`.

In `PlaylistEditorMain.tsx` replace the slot: `<PlaylistTimeline entries={state.entries} selectedUid={state.selectedUid} onSelect={(uid) => dispatch({ type: "select", uid })} />`. Update the C3 main test to assert `data-testid="playlist-timeline"` is present instead of `timeline-slot`.

- [ ] **Step 5: Run all — PASS. Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "feat(playlist-editor): read-only timeline with flags and duration lanes"
```

### Task C5: Save flow, validation gate, dirty-close

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/SaveBar.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/SaveBar.test.tsx`
- Modify: `PlaylistEditorMain.tsx` (mount SaveBar; expose dirty state upward), `PlaylistEditor.tsx` (dirty-close confirm on the main window)

**Interfaces:**

```tsx
export function SaveBar(props: {
	state: EditorState;
	onSaved: (record: PlaylistRecord) => void;   // dispatches markSaved upstream
}): JSX.Element;
```

Behavior (exact): Save button → `assembleDefinition(state)` → `parsePlaylist(def)`. `definition === null` → inline error `This playlist is invalid and can't be saved.`, no API call. `warnings.length > 0` → inline warning list with two buttons `Save Anyway` / `Don't Save`. Clean or Save-Anyway → `updatePlaylist(state.playlistId, { title: state.title, definition: def, status: state.status })`; on success call `onSaved`; on `AuthRequiredError` show `You've been signed out. Sign in via the Account app, then save again.` and **keep state untouched**; other errors → the error message inline. Dirty-close: `PlaylistEditor` passes `onCloseFunc` on the main window that, when the editor view is open and dirty, swaps the window content to a three-button strip `Save changes to "<title>" before closing?` — **Save** (runs the same save path then quits), **Don't Save** (quits), **Cancel** (returns to editor). Quit = the C1 `quit()`.

- [ ] **Step 1: Failing tests** — mock `updatePlaylist` + `parsePlaylist` (`vi.hoisted`); cases: clean save calls API with assembled definition and fires `onSaved`; structurally-invalid blocks with no API call; warnings require Save Anyway; `AuthRequiredError` (reject with `new AuthRequiredError("auth")`) renders the sign-out message and no `onSaved`.

- [ ] **Step 2: Implement `SaveBar.tsx`**

```tsx
import { ClassicyButton } from "classicy";
import { useState } from "react";
import { AuthRequiredError } from "../../Providers/Auth/authApi";
import { type PlaylistRecord, updatePlaylist } from "../../Providers/Auth/playlistApi";
import { parsePlaylist } from "../../Providers/Playlist/parsePlaylist";
import { assembleDefinition, type EditorState } from "./editorState";

export function SaveBar({
	state,
	onSaved,
}: {
	state: EditorState;
	onSaved: (record: PlaylistRecord) => void;
}) {
	const [message, setMessage] = useState<string | null>(null);
	const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);

	const write = async () => {
		try {
			const def = assembleDefinition(state);
			const record = await updatePlaylist(state.playlistId, {
				title: state.title,
				definition: def,
				status: state.status,
			});
			setMessage(null);
			setPendingWarnings(null);
			onSaved(record);
		} catch (err) {
			if (err instanceof AuthRequiredError) {
				setMessage("You've been signed out. Sign in via the Account app, then save again.");
			} else {
				setMessage(err instanceof Error ? err.message : "Couldn't save.");
			}
		}
	};

	const save = () => {
		setMessage(null);
		const parsed = parsePlaylist(assembleDefinition(state));
		if (parsed.definition === null) {
			setMessage("This playlist is invalid and can't be saved.");
			return;
		}
		if (parsed.warnings.length > 0) {
			setPendingWarnings(parsed.warnings);
			return;
		}
		void write();
	};

	return (
		<div className="playlistSaveBar">
			{message && <p className="playlistSaveMessage">{message}</p>}
			{pendingWarnings ? (
				<>
					<ul className="playlistSaveWarnings">
						{pendingWarnings.map((w) => <li key={w}>{w}</li>)}
					</ul>
					<ClassicyButton onClickFunc={() => void write()}>Save Anyway</ClassicyButton>
					<ClassicyButton onClickFunc={() => setPendingWarnings(null)}>Don't Save</ClassicyButton>
				</>
			) : (
				<ClassicyButton isDefault={true} disabled={!state.dirty} onClickFunc={save}>
					Save
				</ClassicyButton>
			)}
		</div>
	);
}
```

Wiring: `PlaylistEditorMain` renders `<SaveBar state={state} onSaved={() => dispatch({ type: "markSaved" })} />` and calls a new prop `onDirtyChange(state.dirty)` in a `useEffect` so `PlaylistEditor` can gate close. `PlaylistEditor` keeps `const [closing, setClosing] = useState(false)`; main window `onCloseFunc={() => { if (dirtyRef.current) { setClosing(true); } else { quit(); } }}` — when `closing`, render the three-button strip instead of the editor body (Save delegates by rendering `<SaveBar state=… onSaved={quit}/>` alongside Don't Save → `quit()` and Cancel → `setClosing(false)`).

- [ ] **Step 3: Run all PlaylistEditor tests + full suite — PASS. Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "feat(playlist-editor): save with parsePlaylist gate + dirty-close confirm"
```

### Task C6: E2E, final verification, PR

**Files:**
- Create: `packages/frontend/e2e/tests/playlist-editor.spec.ts`

- [ ] **Step 1: Write the E2E spec** (mirror `e2e/tests/feedback.spec.ts` conventions for baseURL/selectors; interact via desktop icon double-click, never menus):

```ts
import { expect, test } from "@playwright/test";

const ME = { id: "u1", email: "t@example.org", first_name: "Teach" };

test("anonymous open shows the gate; Quit closes the app", async ({ page }) => {
	await page.route("**/users/me", (route) => route.fulfill({ status: 401, json: { errors: [] } }));
	await page.goto("/");
	await page.getByText("Playlists", { exact: true }).dblclick();
	await expect(page.getByText("You must be signed in to create playlists.")).toBeVisible();
	await page.getByRole("button", { name: "Quit" }).click();
	await expect(page.getByText("You must be signed in to create playlists.")).toBeHidden();
});

test("signed-in teacher creates and saves a playlist", async ({ page }) => {
	await page.route("**/users/me*", (route) => route.fulfill({ json: { data: ME } }));
	await page.route("**/items/playlists?*", (route) => route.fulfill({ json: { data: [] } }));
	let createdBody: Record<string, unknown> | null = null;
	await page.route("**/items/playlists", (route) => {
		createdBody = route.request().postDataJSON();
		return route.fulfill({ json: { data: { id: "p9", title: "Untitled Playlist", status: "draft", definition: createdBody?.definition, date_updated: null, user_created: "u1" } } });
	});
	await page.goto("/");
	await page.getByText("Playlists", { exact: true }).dblclick();
	await page.getByRole("button", { name: "New" }).click();
	await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();
	expect(createdBody).toMatchObject({ title: "Untitled Playlist", status: "draft" });
});
```

- [ ] **Step 2: Run E2E against a fresh dev server** (kill stale 5173 servers first — known trap):

```bash
pkill -f "vite -d" || true
pnpm --filter @rt911/frontend exec playwright test e2e/tests/playlist-editor.spec.ts
```

Expected: 2 passed. Debug selector drift against the real DOM, not by loosening assertions.

- [ ] **Step 3: Full verification**

```bash
cd /home/robbiebyrd/rt911/packages/frontend && pnpm use:published && cd /home/robbiebyrd/rt911
pnpm build && pnpm lint && pnpm test
```

Expected: build green (published classicy ≥ the A4 version), lint clean, all vitest suites pass.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -m "feat(playlist-editor): e2e coverage"
git push -u origin feat/playlist-editor
gh pr create --title "Playlist editor app + Classicy File Open dialog integration" --body "Implements plans/2026-07-17-playlist-editor-design.md (phases B+C; phase A shipped in classicy).

- 911 Realtime Archive network volume (serialized Directus access)
- Sign-in-gated PlaylistEditor.app: My Playlists CRUD, full-definition editing, File Open dialog picking, read-only timeline
- E2E: gate + create/save

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GYpk4uNToTqyTp5NRa93KJ"
```

---

## Plan self-review notes (already applied)

- Spec coverage: §A1/A2/A3 → tasks A1–A3; §A4 → A4; §B (incl. B0 permission prerequisite from the plan-time amendment) → B0–B1; §C1 → C1; §C2 → C2; §C3 → C3; §C4 → C4 (flags/lanes/metadata resolution); §C5 → C5; testing section → per-task tests + C6. Out-of-scope items have no tasks (correct).
- Known judgment calls encoded above: folder tree node ids double as children cache keys (A3); native form controls in EntryForm with Classicy swap deferred to polish; `sources` groupBy fallback documented in B0.
- Type consistency: `ClassicyFileOpenSelection`, `EditorEntry`, `MEDIA_FILE_TYPES`, `directusGet` signatures are used identically across A3/B1/C3/C4.
