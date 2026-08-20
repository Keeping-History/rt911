# HyperCard Editor — Plan 2 of 3: Inspector, Script Editors, Save Seam (classicy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the classicy side of the HyperCard editor: a property inspector (schema-driven, plugin-aware), the two-tab script editor (visual builder + raw JSON), the pluggable save-provider seam, editor metadata registries for plugin parts/commands, and the Plan-1 final-review carry-forwards — leaving branch `hypercard-editor` merge-ready.

**Architecture:** Everything continues on classicy branch `hypercard-editor` (Plan 1 landed the reducer, overlay, palette, download save; HEAD at plan-writing time `f41fb9b`). New property/script edits are new `ClassicyAppHCEdit*` reducer cases going through `applyEdit`. The inspector and script editor are additional `ClassicyWindow`s inside HyperCard.app, context-sensitive to the edit session. Plugin integration happens through NEW additive registries (`registerHyperCardPartEditorMeta`, `registerHyperCardCommandEditorMeta`, `registerHyperCardSaveProvider`) so existing `registerHyperCardPart/Command` call sites are untouched.

**Tech Stack:** React 18, TypeScript, Immer 11, vitest + Testing Library, Biome.

## Spec amendments (decided at plan time — the spec is `plans/2026-07-17-hypercard-editor-design.md`)

1. **No separate localStorage autosave.** Plan 1's browser verification proved edit sessions (draft + dirty + pristine, history stripped) already persist across reloads via ClassicyStore's 500ms persistence. The spec's autosave rationale is fully satisfied; a second persistence path would be redundant state. The "restore prompt" is likewise unnecessary — reopening the desktop resumes the session automatically.
2. **Inspector is an always-open palette window during editing** (no double-click-to-open dialog). Double-click on a part focuses/reveals it in the inspector by virtue of selection; a separate Info-dialog flow would duplicate the inspector.
3. **`HCSaveResult` / `HCSavedStackRef`** (left open in the spec) are pinned in Task 8.

## Global Constraints

- **Repo:** ALL work in `/home/robbiebyrd/classicy` on branch `hypercard-editor`. NEVER push — pushing classicy main auto-publishes to npm; merge/publish is a human decision after this plan.
- **Event prefix:** editor actions use `ClassicyAppHCEdit*` ONLY (kernel router is first-`startsWith`-match; the player owns `ClassicyAppHyperCard`).
- **Reducer purity:** no `Date.now()`/`Math.random()`/`crypto`/`localStorage` in reducer code.
- **Frozen-draft discipline:** document mutations ONLY inside `applyEdit` mutators (write-path `layerParts` there); reads elsewhere via `peekLayerParts`/plain reads. `HCEditState` includes `pristine?: HCStack` (optional — legacy sessions).
- **tsconfig has strict OFF:** boolean-literal discriminated unions don't narrow — use `"errors" in result` style checks.
- **Biome:** tabs, double quotes, `@/SystemFolder/...` alias; `biome-ignore` rule names must match what the installed Biome actually reports, anchored immediately above the triggering element (attribute line for `noNoninteractiveTabindex`). Run `pnpm exec biome check --write <files>` before each commit.
- **Verification per task:** focused vitest while iterating; before each commit: the full HyperCard-scope suite `pnpm exec vitest run src/SystemFolder/HyperCard/`, `pnpm exec tsc -b --noEmit 2>&1 | head -20` (judge only your files), scoped biome check. Repo-wide `pnpm lint` has ~145 pre-existing SVG-asset errors — never use it as a gate; scope to touched files.
- **Vitest globals hygiene:** pair every `vi.stubGlobal` with `vi.unstubAllGlobals()` in `afterEach`.
- **Path-scoped commits** (`git add <files>`, conventional messages). The repo contains foreign stashes and possibly concurrent-session files — never `git stash`, never `git add -A`.
- **Barrels are barrelsby-generated** — never hand-edit `index.ts`; `pnpm build:source` regenerates.

## File Structure

```
src/SystemFolder/HyperCard/
  HyperCardPlugins.ts                     # Task 1 (editor metadata registries), Task 8 (save providers) — modify
  HyperCardCard.tsx                       # Task 9b (inert attribute) — modify
  HyperCard.tsx                           # Tasks 5, 7, 8, 9 (windows, menus, provider registration) — modify
  HyperCard.editor.test.tsx               # Task 10 (menu onClickFunc tests) — modify
  Editor/
    HyperCardEditorUtils.ts               # Task 3 (script/window state on HCEditState) — modify
    HyperCardEditorSchemas.ts             # Task 2 — create (built-in options schemas + lookup)
    HyperCardEditorContext.ts             # Tasks 3, 6 (property + script reducer cases) — modify
    HyperCardInspector.tsx                # Task 4 — create
    HyperCardInspector.test.tsx           # Task 4 — create
    HyperCardScriptModel.ts               # Task 6 — create (targets, handler access, validation)
    HyperCardScriptModel.test.ts          # Task 6 — create
    HyperCardScriptJson.tsx               # Task 6 — create (raw JSON tab)
    HyperCardScriptBuilder.tsx            # Task 7 — create (visual builder tab)
    HyperCardScriptEditor.tsx             # Task 7 — create (tab host)
    HyperCardScriptEditor.test.tsx        # Tasks 6+7 — create
    HyperCardEditorSave.ts                # Task 8 (download provider registration) — modify
    HyperCardEditorOverlay.tsx            # Task 9c (key normalization, paste gate) — modify
    HyperCardEditorCanvas.test.tsx        # Task 9c — modify
src/SystemFolder/SystemResources/Window/
  ClassicyWindow.tsx                      # Task 9a (core menuBar freshness) — modify
src/SystemFolder/SystemResources/Desktop/
  ClassicyDesktopWindowManagerContext.tsx # Task 9a (ClassicyWindowSetMenuBar case) — modify
```

Classicy form components used by the new UI (verified signatures):
`ClassicyInput { id, prefillValue?, onChangeFunc?, onEnterFunc?, labelTitle?, type?, disabled? }` ·
`ClassicyPopUpMenu { id, label?, options: {value,label}[], selected?, onChangeFunc?(e: ChangeEvent<HTMLSelectElement>) }` ·
`ClassicyCheckbox { id, label?, checked?, onClickFunc?(checked: boolean) }` ·
`ClassicyTextEditor { id?, prefillValue?, border?, labelTitle?, onChangeFunc?(e: ChangeEvent<HTMLTextAreaElement>) }` ·
`ClassicyButton { onClickFunc, isDefault? }` · `ClassicyControlLabel { label }`.

---

### Task 1: Editor metadata registries for plugin parts and commands

**Files:**
- Modify: `src/SystemFolder/HyperCard/HyperCardPlugins.ts` (append after the existing registries)
- Test: `src/SystemFolder/HyperCard/HyperCardPlugins.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2, 4, 7; rt911 consumes in Plan 3):
  - `interface HCOptionField { key: string; label: string; kind: "text" | "number" | "checkbox" | "choices" | "json"; default?: unknown }`
  - `interface HyperCardPartEditorMeta { label: string; defaultSize?: [number, number]; defaultOptions?: Record<string, unknown>; defaultContent?: string; optionsSchema?: HCOptionField[] }`
  - `registerHyperCardPartEditorMeta(type: string, meta: HyperCardPartEditorMeta): void`
  - `getHyperCardPartEditorMeta(type: string): HyperCardPartEditorMeta | undefined`
  - `getRegisteredEditorPartTypes(): { type: string; meta: HyperCardPartEditorMeta }[]`
  - `interface HyperCardCommandEditorMeta { label: string; fields: HCOptionField[] }`
  - `registerHyperCardCommandEditorMeta(name: string, meta: HyperCardCommandEditorMeta): void`
  - `getHyperCardCommandEditorMeta(name: string): HyperCardCommandEditorMeta | undefined`
  - `getRegisteredEditorCommands(): { name: string; meta: HyperCardCommandEditorMeta }[]`

- [ ] **Step 1: Write the failing test** — append to `HyperCardPlugins.test.ts`:

```ts
describe("editor metadata registries", () => {
	it("registers and lists part editor metadata", () => {
		registerHyperCardPartEditorMeta("demoVideo", {
			label: "Demo Video",
			defaultSize: [320, 140],
			optionsSchema: [
				{ key: "channelId", label: "Channel", kind: "number", default: 1 },
				{ key: "autoPlay", label: "Auto-play", kind: "checkbox", default: true },
			],
		});
		expect(getHyperCardPartEditorMeta("demoVideo")?.label).toBe("Demo Video");
		expect(
			getRegisteredEditorPartTypes().some((e) => e.type === "demoVideo"),
		).toBe(true);
		expect(getHyperCardPartEditorMeta("missing")).toBeUndefined();
	});

	it("registers and lists command editor metadata", () => {
		registerHyperCardCommandEditorMeta("setDateTime", {
			label: "Set Date/Time",
			fields: [{ key: "value", label: "Date/time", kind: "text" }],
		});
		expect(getHyperCardCommandEditorMeta("setDateTime")?.fields).toHaveLength(1);
		expect(
			getRegisteredEditorCommands().some((c) => c.name === "setDateTime"),
		).toBe(true);
	});
});
```

(Add the new names to the existing import from `HyperCardPlugins`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/SystemFolder/HyperCard/HyperCardPlugins.test.ts`
Expected: FAIL — names not exported.

- [ ] **Step 3: Implement** — append to `HyperCardPlugins.ts`:

```ts
// ---------------------------------------------------------------------------
// Editor metadata (additive; the player never reads these)
// ---------------------------------------------------------------------------

/** One typed field in an inspector/builder form. `choices` edits a string list; `json` edits raw JSON. */
export interface HCOptionField {
	key: string;
	label: string;
	kind: "text" | "number" | "checkbox" | "choices" | "json";
	default?: unknown;
}

/** How the stack EDITOR presents a registered custom part. */
export interface HyperCardPartEditorMeta {
	label: string;
	defaultSize?: [number, number];
	defaultOptions?: Record<string, unknown>;
	defaultContent?: string;
	optionsSchema?: HCOptionField[];
}

/** How the script BUILDER presents a registered custom command. */
export interface HyperCardCommandEditorMeta {
	label: string;
	fields: HCOptionField[];
}

const partEditorMetaRegistry = new Map<string, HyperCardPartEditorMeta>();
const commandEditorMetaRegistry = new Map<string, HyperCardCommandEditorMeta>();

export function registerHyperCardPartEditorMeta(
	type: string,
	meta: HyperCardPartEditorMeta,
): void {
	partEditorMetaRegistry.set(type, meta);
}

export function getHyperCardPartEditorMeta(
	type: string,
): HyperCardPartEditorMeta | undefined {
	return partEditorMetaRegistry.get(type);
}

export function getRegisteredEditorPartTypes(): {
	type: string;
	meta: HyperCardPartEditorMeta;
}[] {
	return Array.from(partEditorMetaRegistry, ([type, meta]) => ({ type, meta }));
}

export function registerHyperCardCommandEditorMeta(
	name: string,
	meta: HyperCardCommandEditorMeta,
): void {
	commandEditorMetaRegistry.set(name, meta);
}

export function getHyperCardCommandEditorMeta(
	name: string,
): HyperCardCommandEditorMeta | undefined {
	return commandEditorMetaRegistry.get(name);
}

export function getRegisteredEditorCommands(): {
	name: string;
	meta: HyperCardCommandEditorMeta;
}[] {
	return Array.from(commandEditorMetaRegistry, ([name, meta]) => ({
		name,
		meta,
	}));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run src/SystemFolder/HyperCard/HyperCardPlugins.test.ts` → PASS.

- [ ] **Step 5: Scope-verify + commit**

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/HyperCardPlugins.ts src/SystemFolder/HyperCard/HyperCardPlugins.test.ts
git add src/SystemFolder/HyperCard/HyperCardPlugins.ts src/SystemFolder/HyperCard/HyperCardPlugins.test.ts
git commit -m "feat(hypercard): editor metadata registries for plugin parts and commands"
```

---

### Task 2: Built-in options schemas + palette/AddPart plugin awareness

**Files:**
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardEditorSchemas.ts`
- Test: `src/SystemFolder/HyperCard/Editor/HyperCardEditorSchemas.test.ts`
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardToolsPalette.tsx` (merge plugin entries)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.ts` (AddPart falls back to plugin meta)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardToolsPalette.test.tsx`, `HyperCardEditorContext.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 1's `HCOptionField`, `getHyperCardPartEditorMeta`, `getRegisteredEditorPartTypes`; Plan 1's `BUILTIN_PART_DESCRIPTORS`, `getPartDescriptor`.
- Produces:
  - `BUILTIN_OPTIONS_SCHEMAS: Record<string, HCOptionField[]>` — entries for `radio`, `popup`, `slider`, `progress`, `image`, `field` (others have no options).
  - `optionsSchemaFor(type: string): HCOptionField[] | undefined` — built-in first, then plugin meta.
  - `paletteEntries(): { type: string; label: string }[]` — the 10 built-ins followed by registered plugin part types (registry order).
  - AddPart reducer behavior extended: for unknown descriptor types, `defaultSize`/`defaultOptions`/`defaultContent` come from `getHyperCardPartEditorMeta(type)` before the `[120, 60]` fallback.

- [ ] **Step 1: Failing tests**

`HyperCardEditorSchemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	BUILTIN_OPTIONS_SCHEMAS,
	optionsSchemaFor,
	paletteEntries,
} from "@/SystemFolder/HyperCard/Editor/HyperCardEditorSchemas";
import { registerHyperCardPartEditorMeta } from "@/SystemFolder/HyperCard/HyperCardPlugins";

describe("built-in options schemas", () => {
	it("covers the option-bearing built-ins with the right kinds", () => {
		expect(BUILTIN_OPTIONS_SCHEMAS.slider.map((f) => f.key)).toEqual([
			"min",
			"max",
			"step",
		]);
		expect(BUILTIN_OPTIONS_SCHEMAS.popup[0]).toMatchObject({
			key: "choices",
			kind: "choices",
		});
		expect(BUILTIN_OPTIONS_SCHEMAS.image[0]).toMatchObject({
			key: "src",
			kind: "text",
		});
		expect(BUILTIN_OPTIONS_SCHEMAS.field[0]).toMatchObject({
			key: "multiline",
			kind: "checkbox",
		});
	});

	it("optionsSchemaFor prefers built-ins, falls back to plugin meta, else undefined", () => {
		registerHyperCardPartEditorMeta("schemaTest", {
			label: "Schema Test",
			optionsSchema: [{ key: "url", label: "URL", kind: "text" }],
		});
		expect(optionsSchemaFor("slider")).toBe(BUILTIN_OPTIONS_SCHEMAS.slider);
		expect(optionsSchemaFor("schemaTest")?.[0].key).toBe("url");
		expect(optionsSchemaFor("button")).toBeUndefined();
	});

	it("paletteEntries lists 10 built-ins then registered plugin types", () => {
		const entries = paletteEntries();
		expect(entries.slice(0, 10).map((e) => e.type)).toContain("button");
		expect(entries.some((e) => e.type === "schemaTest")).toBe(true);
	});
});
```

Append to `HyperCardEditorContext.test.ts`:

```ts
	it("AddPart uses plugin editor metadata for unknown types", () => {
		registerHyperCardPartEditorMeta("metaPart", {
			label: "Meta Part",
			defaultSize: [222, 44],
			defaultOptions: { channel: 7 },
			defaultContent: "hello",
		});
		const store = makeStore();
		enter(store);
		dispatch(store, {
			type: "ClassicyAppHCEditAddPart",
			stackId: "demo",
			partType: "metaPart",
			at: [10, 20],
		});
		const parts = edit(store).draft.cards[0].parts!;
		expect(parts.at(-1)).toMatchObject({
			type: "metaPart",
			rect: [10, 20, 222, 44],
			options: { channel: 7 },
			content: "hello",
		});
	});
```

(Import `registerHyperCardPartEditorMeta` from `@/SystemFolder/HyperCard/HyperCardPlugins` in that test file.)

Append to `HyperCardToolsPalette.test.tsx`:

```ts
	it("lists registered plugin part types after the built-ins", () => {
		registerHyperCardPartEditorMeta("paletteTest", { label: "Palette Test" });
		const { container } = render(
			<HyperCardToolsPalette stackId={"demo"} edit={makeEdit()} />,
		);
		const entry = container.querySelector(
			'.classicyHyperCardPaletteEntry[data-part-type="paletteTest"]',
		);
		expect(entry?.textContent).toContain("Palette Test");
	});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run src/SystemFolder/HyperCard/Editor/` → the three new tests FAIL.

- [ ] **Step 3: Implement `HyperCardEditorSchemas.ts`**

```ts
/**
 * Inspector option schemas: which typed fields each part type's `options`
 * object exposes. Built-ins are authored here; plugin parts supply theirs via
 * registerHyperCardPartEditorMeta. Parts absent from both edit options as raw
 * JSON rows in the inspector.
 */

import {
	BUILTIN_PART_DESCRIPTORS,
} from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import {
	getHyperCardPartEditorMeta,
	getRegisteredEditorPartTypes,
	type HCOptionField,
} from "@/SystemFolder/HyperCard/HyperCardPlugins";

export const BUILTIN_OPTIONS_SCHEMAS: Record<string, HCOptionField[]> = {
	radio: [{ key: "choices", label: "Choices", kind: "choices" }],
	popup: [{ key: "choices", label: "Choices", kind: "choices" }],
	slider: [
		{ key: "min", label: "Minimum", kind: "number", default: 0 },
		{ key: "max", label: "Maximum", kind: "number", default: 100 },
		{ key: "step", label: "Step", kind: "number", default: 1 },
	],
	progress: [{ key: "max", label: "Maximum", kind: "number", default: 100 }],
	image: [{ key: "src", label: "Image URL", kind: "text" }],
	field: [{ key: "multiline", label: "Multiline", kind: "checkbox" }],
};

/** Schema for a part type: built-in first, then plugin editor meta. */
export function optionsSchemaFor(type: string): HCOptionField[] | undefined {
	return (
		BUILTIN_OPTIONS_SCHEMAS[type] ??
		getHyperCardPartEditorMeta(type)?.optionsSchema
	);
}

/** Palette listing: the built-ins followed by registered plugin part types. */
export function paletteEntries(): { type: string; label: string }[] {
	return [
		...BUILTIN_PART_DESCRIPTORS.map((d) => ({ type: d.type, label: d.label })),
		...getRegisteredEditorPartTypes().map(({ type, meta }) => ({
			type,
			label: meta.label,
		})),
	];
}
```

- [ ] **Step 4: Wire the palette** — in `HyperCardToolsPalette.tsx`, replace the `BUILTIN_PART_DESCRIPTORS.map(...)` loop's source with `paletteEntries()` (computed inside the component body — plugin registrations happen at app entry, before render). The entry JSX keeps the same classes/`data-part-type`/drag/click behavior; the label comes from `entry.label`. Remove the now-unused `BUILTIN_PART_DESCRIPTORS` import.

- [ ] **Step 5: Wire AddPart** — in `HyperCardEditorContext.ts`'s `ClassicyAppHCEditAddPart` case, replace the descriptor lookup block with:

```ts
			const desc = getPartDescriptor(partType);
			const meta = getHyperCardPartEditorMeta(partType);
			const size = desc?.defaultSize ?? meta?.defaultSize ?? FALLBACK_SIZE;
			const defaultOptions = desc?.defaultOptions ?? meta?.defaultOptions;
			const defaultContent = desc?.defaultContent ?? meta?.defaultContent;
```

and use `defaultOptions`/`defaultContent` where the case previously read `desc?.defaultOptions`/`desc?.defaultContent`. Import `getHyperCardPartEditorMeta` from `@/SystemFolder/HyperCard/HyperCardPlugins`.

- [ ] **Step 6: Run to verify pass**

Run: `pnpm exec vitest run src/SystemFolder/HyperCard/` → ALL PASS.

- [ ] **Step 7: Verify + commit**

```bash
pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/Editor/
git add src/SystemFolder/HyperCard/Editor/ 
git commit -m "feat(hypercard): built-in options schemas; palette and AddPart honor plugin editor metadata"
```

---

### Task 3: Property-edit reducer cases (+ script/window state fields)

**Files:**
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorUtils.ts` (extend `HCEditState`)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.ts` (new cases)
- Test: append to `src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.test.ts`

**Interfaces:**
- Consumes: Plan 1's `applyEdit`, `layerParts`, `peekLayerParts`, `findLayerPart`.
- Produces — `HCEditState` gains:
  - `script?: { target: HCScriptTarget }` — declared as `script?: { target: unknown }`-free: import the type from Task 6? No — Task 6 comes later; declare the shape HERE as `export type HCScriptTarget = { kind: "part"; partId: string } | { kind: "card" } | { kind: "background" } | { kind: "stack" }` in `HyperCardEditorUtils.ts` (Task 6 imports it from there).
- New reducer cases (all carry `stackId`; all mutate via `applyEdit` unless noted):
  - `ClassicyAppHCEditSetPartProps { partId, props: { id?, name?, content?, visible?, locked?, shared? } }` — id rename applies ONLY if non-empty and unique across the whole stack (cards + backgrounds); other keys applied when present; `selectedPartId` follows an id rename (session-state write, outside applyEdit).
  - `ClassicyAppHCEditSetPartStyle { partId, style: { shape?, align?, fontSize? } }` — merges into `part.style`; a value of `""` deletes the key; an emptied style object is removed.
  - `ClassicyAppHCEditSetPartOption { partId, key, value }` — `value === undefined` deletes the key (and an emptied options object); else assigns.
  - `ClassicyAppHCEditSetCardProps { props: { name?, background? } }` — applies to the current card; `background: ""` deletes; unknown background ids ignored.
  - `ClassicyAppHCEditSetStackProps { props: { name?, width?, height? } }` — non-empty `name`; width/height clamped to ≥ 64, written as `size: [w, h]` (existing size used for the missing half; default 512×342).
  - `ClassicyAppHCEditSetStackVariable { name, value }` — `value === undefined` deletes; else assigns string/number into `draft.variables` (created on demand).
  - `ClassicyAppHCEditShowScript { target: HCScriptTarget }` / `ClassicyAppHCEditHideScript {}` — session-state only (no applyEdit): sets/clears `edit.script`.

- [ ] **Step 1: Failing tests** — append to `HyperCardEditorContext.test.ts`:

```ts
	it("SetPartProps renames uniquely and follows selection; rejects duplicate ids", () => {
		const store = makeStore();
		enter(store);
		dispatch(store, { type: "ClassicyAppHCEditSelect", stackId: "demo", partId: "button1" });
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartProps",
			stackId: "demo",
			partId: "button1",
			props: { id: "banner1" }, // taken by the background part
		});
		expect(edit(store).draft.cards[0].parts![0].id).toBe("button1");
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartProps",
			stackId: "demo",
			partId: "button1",
			props: { id: "hero", name: "Hero", locked: true },
		});
		const part = edit(store).draft.cards[0].parts![0];
		expect(part).toMatchObject({ id: "hero", name: "Hero", locked: true });
		expect(edit(store).selectedPartId).toBe("hero");
	});

	it("SetPartStyle merges and empty-string deletes", () => {
		const store = makeStore();
		enter(store);
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartStyle",
			stackId: "demo",
			partId: "button1",
			style: { align: "center" },
		});
		expect(edit(store).draft.cards[0].parts![0].style).toEqual({ align: "center" });
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartStyle",
			stackId: "demo",
			partId: "button1",
			style: { align: "" },
		});
		expect(edit(store).draft.cards[0].parts![0].style).toBeUndefined();
	});

	it("SetPartOption sets and undefined-deletes", () => {
		const store = makeStore();
		enter(store);
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartOption",
			stackId: "demo",
			partId: "button1",
			key: "min",
			value: 5,
		});
		expect(edit(store).draft.cards[0].parts![0].options).toEqual({ min: 5 });
		dispatch(store, {
			type: "ClassicyAppHCEditSetPartOption",
			stackId: "demo",
			partId: "button1",
			key: "min",
			value: undefined,
		});
		expect(edit(store).draft.cards[0].parts![0].options).toBeUndefined();
	});

	it("SetCardProps / SetStackProps / SetStackVariable edit the draft", () => {
		const store = makeStore();
		enter(store);
		dispatch(store, {
			type: "ClassicyAppHCEditSetCardProps",
			stackId: "demo",
			props: { name: "First!", background: "" },
		});
		expect(edit(store).draft.cards[0]).toMatchObject({ name: "First!" });
		expect(edit(store).draft.cards[0].background).toBeUndefined();
		dispatch(store, {
			type: "ClassicyAppHCEditSetStackProps",
			stackId: "demo",
			props: { name: "Renamed", width: 640 },
		});
		expect(edit(store).draft.name).toBe("Renamed");
		expect(edit(store).draft.size).toEqual([640, 342]);
		dispatch(store, {
			type: "ClassicyAppHCEditSetStackVariable",
			stackId: "demo",
			name: "score",
			value: 10,
		});
		expect(edit(store).draft.variables).toEqual({ score: 10 });
		dispatch(store, {
			type: "ClassicyAppHCEditSetStackVariable",
			stackId: "demo",
			name: "score",
			value: undefined,
		});
		expect(edit(store).draft.variables).toEqual({});
	});

	it("ShowScript/HideScript manage session state without touching the draft", () => {
		const store = makeStore();
		enter(store);
		const before = edit(store).draft;
		dispatch(store, {
			type: "ClassicyAppHCEditShowScript",
			stackId: "demo",
			target: { kind: "part", partId: "button1" },
		});
		expect(edit(store).script).toEqual({
			target: { kind: "part", partId: "button1" },
		});
		expect(edit(store).draft).toBe(before);
		expect(edit(store).undo).toHaveLength(0);
		dispatch(store, { type: "ClassicyAppHCEditHideScript", stackId: "demo" });
		expect(edit(store).script).toBeUndefined();
	});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement.** In `HyperCardEditorUtils.ts` add (near `HCEditState`):

```ts
/** What a script-editor session is pointed at. */
export type HCScriptTarget =
	| { kind: "part"; partId: string }
	| { kind: "card" }
	| { kind: "background" }
	| { kind: "stack" };
```

and on `HCEditState`:

```ts
	/** Open script-editor session, if any. */
	script?: { target: HCScriptTarget };
```

In `HyperCardEditorContext.ts` add the cases (before the closing of the switch; import `HCScriptTarget` from EditorUtils):

```ts
		case "ClassicyAppHCEditSetPartProps": {
			const edit = getEdit(ds, action);
			const partId = action.partId as string | undefined;
			const props = action.props as
				| {
						id?: string;
						name?: string;
						content?: string;
						visible?: boolean;
						locked?: boolean;
						shared?: boolean;
				  }
				| undefined;
			if (!edit || !partId || !props) break;
			const wantsRename =
				typeof props.id === "string" && props.id.length > 0 && props.id !== partId;
			const allIds = new Set<string>();
			for (const c of edit.draft.cards)
				for (const p of c.parts ?? []) allIds.add(p.id);
			for (const b of edit.draft.backgrounds ?? [])
				for (const p of b.parts ?? []) allIds.add(p.id);
			const renameOk = wantsRename && !allIds.has(props.id as string);
			applyEdit(edit, (draft) => {
				const part = layerParts(draft, edit.currentCardId, edit.layer)?.find(
					(p) => p.id === partId,
				);
				if (!part) return;
				if (renameOk) part.id = props.id as string;
				if (typeof props.name === "string") part.name = props.name;
				if (typeof props.content === "string") part.content = props.content;
				if (typeof props.visible === "boolean") part.visible = props.visible;
				if (typeof props.locked === "boolean") part.locked = props.locked;
				if (typeof props.shared === "boolean") part.shared = props.shared;
			});
			if (renameOk && edit.selectedPartId === partId) {
				edit.selectedPartId = props.id as string;
			}
			break;
		}

		case "ClassicyAppHCEditSetPartStyle": {
			const edit = getEdit(ds, action);
			const partId = action.partId as string | undefined;
			const style = action.style as Record<string, string> | undefined;
			if (!edit || !partId || !style) break;
			applyEdit(edit, (draft) => {
				const part = layerParts(draft, edit.currentCardId, edit.layer)?.find(
					(p) => p.id === partId,
				);
				if (!part) return;
				const next: Record<string, string> = {
					...(part.style as Record<string, string> | undefined),
				};
				for (const [k, v] of Object.entries(style)) {
					if (v === "") delete next[k];
					else next[k] = v;
				}
				if (Object.keys(next).length === 0) part.style = undefined;
				else part.style = next as HCPart["style"];
			});
			break;
		}

		case "ClassicyAppHCEditSetPartOption": {
			const edit = getEdit(ds, action);
			const partId = action.partId as string | undefined;
			const key = action.key as string | undefined;
			if (!edit || !partId || !key) break;
			applyEdit(edit, (draft) => {
				const part = layerParts(draft, edit.currentCardId, edit.layer)?.find(
					(p) => p.id === partId,
				);
				if (!part) return;
				if (action.value === undefined) {
					if (!part.options) return;
					delete part.options[key];
					if (Object.keys(part.options).length === 0) part.options = undefined;
				} else {
					part.options ??= {};
					part.options[key] = action.value;
				}
			});
			break;
		}

		case "ClassicyAppHCEditSetCardProps": {
			const edit = getEdit(ds, action);
			const props = action.props as
				| { name?: string; background?: string }
				| undefined;
			if (!edit || !props) break;
			const backgroundIds = new Set(
				(edit.draft.backgrounds ?? []).map((b) => b.id),
			);
			applyEdit(edit, (draft) => {
				const card = draft.cards.find((c) => c.id === edit.currentCardId);
				if (!card) return;
				if (typeof props.name === "string") card.name = props.name;
				if (props.background === "") card.background = undefined;
				else if (
					typeof props.background === "string" &&
					backgroundIds.has(props.background)
				) {
					card.background = props.background;
				}
			});
			break;
		}

		case "ClassicyAppHCEditSetStackProps": {
			const edit = getEdit(ds, action);
			const props = action.props as
				| { name?: string; width?: number; height?: number }
				| undefined;
			if (!edit || !props) break;
			applyEdit(edit, (draft) => {
				if (typeof props.name === "string" && props.name.length > 0) {
					draft.name = props.name;
				}
				if (props.width !== undefined || props.height !== undefined) {
					const [w, h] = draft.size ?? DEFAULT_CARD_SIZE;
					draft.size = [
						Math.max(64, Math.round(Number(props.width ?? w))),
						Math.max(64, Math.round(Number(props.height ?? h))),
					];
				}
			});
			break;
		}

		case "ClassicyAppHCEditSetStackVariable": {
			const edit = getEdit(ds, action);
			const name = action.name as string | undefined;
			if (!edit || !name) break;
			applyEdit(edit, (draft) => {
				if (action.value === undefined) {
					if (draft.variables) delete draft.variables[name];
				} else {
					draft.variables ??= {};
					draft.variables[name] = action.value as string | number;
				}
			});
			break;
		}

		case "ClassicyAppHCEditShowScript": {
			const edit = getEdit(ds, action);
			const target = action.target as HCScriptTarget | undefined;
			if (edit && target) edit.script = { target };
			break;
		}

		case "ClassicyAppHCEditHideScript": {
			const edit = getEdit(ds, action);
			if (edit) edit.script = undefined;
			break;
		}
```

Imports to add in `HyperCardEditorContext.ts`: `DEFAULT_CARD_SIZE` from the model; `HCScriptTarget` (type) from EditorUtils; `HCPart` is already imported.

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run src/SystemFolder/HyperCard/Editor/` → ALL PASS. Note the SetStackVariable delete test expects `{}` (not undefined) — deleting leaves the empty object; that's fine for the runtime.

- [ ] **Step 5: Verify + commit**

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/Editor/
git add src/SystemFolder/HyperCard/Editor/
git commit -m "feat(hypercard): property/card/stack/variable reducer cases and script session state"
```

---

### Task 4: The Inspector component

**Files:**
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardInspector.tsx`
- Test: `src/SystemFolder/HyperCard/Editor/HyperCardInspector.test.tsx`

**Interfaces:**
- Consumes: Tasks 1-3 (`optionsSchemaFor`, property actions, `HCScriptTarget`); Plan 1's `peekLayerParts`; the verified form components.
- Produces: `HyperCardInspector: FC<{ stackId: string; edit: HCEditState }>` — window CONTENT (Task 5 wraps it). With a selected part: identity (`id`, `name`), geometry (`x/y/w/h` → `ClassicyAppHCEditSetRect`), flags (visible/locked/shared), style popups, content editor, schema-driven options (plus raw-JSON rows for existing option keys not covered by the schema), and a `Script…` button (→ `ShowScript {kind:"part"}`). With no selection: card section (name, background popup, `Card Script…`), stack section (name, width, height, `Stack Script…`, `Background Script…` when the card has one), and a variables table (rows with delete, add-row inputs).
- Commit semantics: text/number inputs are uncontrolled (`prefillValue`), keyed on `${selectedPartId ?? "none"}:${fieldKey}` so selection changes remount them; commits fire on Enter and on blur via a shared `CommitField` helper defined in this file.

- [ ] **Step 1: Failing test** — `HyperCardInspector.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HyperCardInspector } from "@/SystemFolder/HyperCard/Editor/HyperCardInspector";
import type { HCEditState } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";

const dispatch = vi.fn();
vi.mock(
	"@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils",
	() => ({
		useAppManagerDispatch: () => dispatch,
		useAppManager: Object.assign((sel: (s: unknown) => unknown) => sel({}), {
			getState: () => ({}),
		}),
	}),
);

afterEach(cleanup);
beforeEach(() => dispatch.mockClear());

function makeEdit(overrides: Partial<HCEditState> = {}): HCEditState {
	return {
		draft: {
			name: "Demo",
			backgrounds: [{ id: "bg1", name: "Frame" }],
			variables: { score: 3 },
			cards: [
				{
					id: "c1",
					name: "One",
					background: "bg1",
					parts: [
						{
							id: "slider1",
							type: "slider",
							rect: [10, 10, 160, 24],
							options: { min: 0, max: 100, step: 1, custom: "x" },
						},
					],
				},
			],
		},
		currentCardId: "c1",
		layer: "card",
		tool: "pointer",
		undo: [],
		redo: [],
		dirty: false,
		...overrides,
	};
}

describe("HyperCardInspector", () => {
	it("shows part identity + geometry and commits a rename on Enter", () => {
		render(
			<HyperCardInspector
				stackId={"demo"}
				edit={makeEdit({ selectedPartId: "slider1" })}
			/>,
		);
		const idInput = screen.getByDisplayValue("slider1") as HTMLInputElement;
		fireEvent.change(idInput, { target: { value: "volume" } });
		fireEvent.keyDown(idInput, { key: "Enter" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetPartProps",
			stackId: "demo",
			partId: "slider1",
			props: { id: "volume" },
		});
	});

	it("commits geometry through SetRect", () => {
		render(
			<HyperCardInspector
				stackId={"demo"}
				edit={makeEdit({ selectedPartId: "slider1" })}
			/>,
		);
		// rect is [10, 10, 160, 24] — X and Y both display "10"; X renders first.
		const xInput = screen.getAllByDisplayValue("10")[0] as HTMLInputElement;
		fireEvent.change(xInput, { target: { value: "40" } });
		fireEvent.keyDown(xInput, { key: "Enter" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetRect",
			stackId: "demo",
			partId: "slider1",
			rect: [40, 10, 160, 24],
		});
	});

	it("renders schema fields for the part's options and commits a number edit", () => {
		render(
			<HyperCardInspector
				stackId={"demo"}
				edit={makeEdit({ selectedPartId: "slider1" })}
			/>,
		);
		const maxInput = screen.getByDisplayValue("100") as HTMLInputElement;
		fireEvent.change(maxInput, { target: { value: "10" } });
		fireEvent.keyDown(maxInput, { key: "Enter" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetPartOption",
			stackId: "demo",
			partId: "slider1",
			key: "max",
			value: 10,
		});
	});

	it("renders a raw JSON row for option keys outside the schema", () => {
		render(
			<HyperCardInspector
				stackId={"demo"}
				edit={makeEdit({ selectedPartId: "slider1" })}
			/>,
		);
		expect(screen.getByDisplayValue('"x"')).toBeTruthy();
	});

	it("opens the part script editor", () => {
		render(
			<HyperCardInspector
				stackId={"demo"}
				edit={makeEdit({ selectedPartId: "slider1" })}
			/>,
		);
		fireEvent.click(screen.getByText("Script…"));
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditShowScript",
			stackId: "demo",
			target: { kind: "part", partId: "slider1" },
		});
	});

	it("with no selection shows card/stack sections and edits a variable", () => {
		render(<HyperCardInspector stackId={"demo"} edit={makeEdit()} />);
		expect(screen.getByDisplayValue("One")).toBeTruthy();
		expect(screen.getByDisplayValue("Demo")).toBeTruthy();
		const varValue = screen.getByDisplayValue("3") as HTMLInputElement;
		fireEvent.change(varValue, { target: { value: "5" } });
		fireEvent.keyDown(varValue, { key: "Enter" });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetStackVariable",
			stackId: "demo",
			name: "score",
			value: 5,
		});
	});
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `HyperCardInspector.tsx`**

```tsx
/**
 * Context-sensitive property inspector: a selected part's identity, geometry,
 * flags, style, content, and schema-driven options; with nothing selected, the
 * current card's and the stack's properties plus the variables table. All
 * commits dispatch ClassicyAppHCEdit* actions; inputs are uncontrolled and
 * keyed on selection + field so selection changes remount them.
 */

import type { FC as FunctionalComponent } from "react";
import { useAppManagerDispatch } from "@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils";
import { optionsSchemaFor } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorSchemas";
import {
	type HCEditState,
	peekLayerParts,
} from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import type { HCPart, HCRect } from "@/SystemFolder/HyperCard/HyperCardModel";
import type { HCOptionField } from "@/SystemFolder/HyperCard/HyperCardPlugins";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyCheckbox } from "@/SystemFolder/SystemResources/Checkbox/ClassicyCheckbox";
import { ClassicyControlLabel } from "@/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel";
import { ClassicyInput } from "@/SystemFolder/SystemResources/Input/ClassicyInput";
import { ClassicyPopUpMenu } from "@/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu";
import { ClassicyTextEditor } from "@/SystemFolder/SystemResources/TextEditor/ClassicyTextEditor";

interface HyperCardInspectorProps {
	stackId: string;
	edit: HCEditState;
}

/** Uncontrolled input that commits its latest text on Enter or blur. */
const CommitField: FunctionalComponent<{
	id: string;
	label: string;
	value: string;
	onCommit: (value: string) => void;
	type?: string;
}> = ({ id, label, value, onCommit, type }) => {
	let latest = value;
	return (
		<div
			className={"classicyHyperCardInspectorField"}
			onBlur={() => {
				if (latest !== value) onCommit(latest);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter" && latest !== value) onCommit(latest);
			}}
		>
			<ClassicyInput
				id={id}
				labelTitle={label}
				prefillValue={value}
				type={type}
				onChangeFunc={(e) => {
					latest = e.target.value;
				}}
			/>
		</div>
	);
};

const STYLE_FIELDS: { key: "shape" | "align" | "fontSize"; label: string; values: string[] }[] = [
	{ key: "shape", label: "Shape", values: ["rectangle", "roundRect", "transparent", "default"] },
	{ key: "align", label: "Align", values: ["left", "center", "right"] },
	{ key: "fontSize", label: "Font size", values: ["small", "medium", "large"] },
];

export const HyperCardInspector: FunctionalComponent<HyperCardInspectorProps> = ({
	stackId,
	edit,
}) => {
	const dispatch = useAppManagerDispatch();
	const parts = peekLayerParts(edit.draft, edit.currentCardId, edit.layer) ?? [];
	const part = edit.selectedPartId
		? parts.find((p) => p.id === edit.selectedPartId)
		: undefined;

	return (
		<div className={"classicyHyperCardInspector"}>
			{part ? renderPartSections(part) : renderCardStackSections()}
		</div>
	);

	function renderPartSections(part: HCPart) {
		const rect: HCRect = part.rect ?? [0, 0, 120, 60];
		const schema = optionsSchemaFor(part.type) ?? [];
		const schemaKeys = new Set(schema.map((f) => f.key));
		const extraKeys = Object.keys(part.options ?? {}).filter(
			(k) => !schemaKeys.has(k),
		);
		const setProps = (props: Record<string, unknown>) =>
			dispatch({
				type: "ClassicyAppHCEditSetPartProps",
				stackId,
				partId: part.id,
				props,
			});
		const keyOf = (field: string) => `${part.id}:${field}`;

		return (
			<>
				<ClassicyControlLabel label={`${part.type} “${part.id}”`} />
				<CommitField
					key={keyOf("id")}
					id={keyOf("id")}
					label={"ID"}
					value={part.id}
					onCommit={(v) => setProps({ id: v })}
				/>
				<CommitField
					key={keyOf("name")}
					id={keyOf("name")}
					label={"Name"}
					value={part.name ?? ""}
					onCommit={(v) => setProps({ name: v })}
				/>
				{(["x", "y", "w", "h"] as const).map((axis, i) => (
					<CommitField
						key={keyOf(axis)}
						id={keyOf(axis)}
						label={axis.toUpperCase()}
						value={String(rect[i])}
						type={"number"}
						onCommit={(v) => {
							const next = [...rect] as HCRect;
							next[i] = Number(v);
							dispatch({
								type: "ClassicyAppHCEditSetRect",
								stackId,
								partId: part.id,
								rect: next,
							});
						}}
					/>
				))}
				<ClassicyCheckbox
					id={keyOf("visible")}
					label={"Visible"}
					checked={part.visible ?? true}
					onClickFunc={(checked) => setProps({ visible: checked })}
				/>
				<ClassicyCheckbox
					id={keyOf("locked")}
					label={"Locked"}
					checked={part.locked ?? false}
					onClickFunc={(checked) => setProps({ locked: checked })}
				/>
				<ClassicyCheckbox
					id={keyOf("shared")}
					label={"Shared (background fields)"}
					checked={part.shared ?? false}
					onClickFunc={(checked) => setProps({ shared: checked })}
				/>
				{STYLE_FIELDS.map((sf) => (
					<ClassicyPopUpMenu
						key={keyOf(sf.key)}
						id={keyOf(sf.key)}
						label={sf.label}
						options={[
							{ value: "", label: "(default)" },
							...sf.values.map((v) => ({ value: v, label: v })),
						]}
						selected={part.style?.[sf.key] ?? ""}
						onChangeFunc={(e) =>
							dispatch({
								type: "ClassicyAppHCEditSetPartStyle",
								stackId,
								partId: part.id,
								style: { [sf.key]: e.target.value },
							})
						}
					/>
				))}
				<div
					key={keyOf("content")}
					className={"classicyHyperCardInspectorField"}
				>
					<CommitField
						id={keyOf("content")}
						label={"Content"}
						value={part.content ?? ""}
						onCommit={(v) => setProps({ content: v })}
					/>
				</div>
				{schema.map((field) => renderOptionField(part, field))}
				{extraKeys.map((k) =>
					renderOptionField(part, { key: k, label: k, kind: "json" }),
				)}
				<ClassicyButton
					onClickFunc={() =>
						dispatch({
							type: "ClassicyAppHCEditShowScript",
							stackId,
							target: { kind: "part", partId: part.id },
						})
					}
				>
					Script…
				</ClassicyButton>
			</>
		);
	}

	function renderOptionField(part: HCPart, field: HCOptionField) {
		const key = `${part.id}:opt:${field.key}`;
		const current = part.options?.[field.key] ?? field.default;
		const commit = (value: unknown) =>
			dispatch({
				type: "ClassicyAppHCEditSetPartOption",
				stackId,
				partId: part.id,
				key: field.key,
				value,
			});
		if (field.kind === "checkbox") {
			return (
				<ClassicyCheckbox
					key={key}
					id={key}
					label={field.label}
					checked={Boolean(current)}
					onClickFunc={(checked) => commit(checked)}
				/>
			);
		}
		if (field.kind === "choices") {
			const lines = Array.isArray(current)
				? (current as unknown[]).map(String).join("\n")
				: "";
			let latest = lines;
			return (
				<div
					key={key}
					className={"classicyHyperCardInspectorField"}
					onBlur={() => {
						if (latest !== lines) {
							commit(latest.split("\n").filter((l) => l.length > 0));
						}
					}}
				>
					<ClassicyTextEditor
						id={key}
						labelTitle={field.label}
						border={true}
						prefillValue={lines}
						onChangeFunc={(e) => {
							latest = e.target.value;
						}}
					/>
				</div>
			);
		}
		if (field.kind === "json") {
			return (
				<CommitField
					key={key}
					id={key}
					label={`${field.label} (JSON)`}
					value={current === undefined ? "" : JSON.stringify(current)}
					onCommit={(v) => {
						if (v === "") {
							commit(undefined);
							return;
						}
						try {
							commit(JSON.parse(v));
						} catch {
							// invalid JSON: ignore the commit, the input keeps the text
						}
					}}
				/>
			);
		}
		return (
			<CommitField
				key={key}
				id={key}
				label={field.label}
				value={current === undefined ? "" : String(current)}
				type={field.kind === "number" ? "number" : undefined}
				onCommit={(v) => {
					if (v === "") commit(undefined);
					else commit(field.kind === "number" ? Number(v) : v);
				}}
			/>
		);
	}

	function renderCardStackSections() {
		const card = edit.draft.cards.find((c) => c.id === edit.currentCardId);
		const backgrounds = edit.draft.backgrounds ?? [];
		const variables = Object.entries(edit.draft.variables ?? {});
		const [w, h] = edit.draft.size ?? [512, 342];
		let newVarName = "";
		let newVarValue = "";
		return (
			<>
				<ClassicyControlLabel label={`Card “${card?.id ?? ""}”`} />
				<CommitField
					key={`card:${edit.currentCardId}:name`}
					id={`card:${edit.currentCardId}:name`}
					label={"Card name"}
					value={card?.name ?? ""}
					onCommit={(v) =>
						dispatch({
							type: "ClassicyAppHCEditSetCardProps",
							stackId,
							props: { name: v },
						})
					}
				/>
				<ClassicyPopUpMenu
					id={`card:${edit.currentCardId}:background`}
					label={"Background"}
					options={[
						{ value: "", label: "(none)" },
						...backgrounds.map((b) => ({
							value: b.id,
							label: b.name ?? b.id,
						})),
					]}
					selected={card?.background ?? ""}
					onChangeFunc={(e) =>
						dispatch({
							type: "ClassicyAppHCEditSetCardProps",
							stackId,
							props: { background: e.target.value },
						})
					}
				/>
				<ClassicyButton
					onClickFunc={() =>
						dispatch({
							type: "ClassicyAppHCEditShowScript",
							stackId,
							target: { kind: "card" },
						})
					}
				>
					Card Script…
				</ClassicyButton>
				{card?.background ? (
					<ClassicyButton
						onClickFunc={() =>
							dispatch({
								type: "ClassicyAppHCEditShowScript",
								stackId,
								target: { kind: "background" },
							})
						}
					>
						Background Script…
					</ClassicyButton>
				) : null}
				<ClassicyControlLabel label={"Stack"} />
				<CommitField
					key={"stack:name"}
					id={"stack:name"}
					label={"Stack name"}
					value={edit.draft.name}
					onCommit={(v) =>
						dispatch({
							type: "ClassicyAppHCEditSetStackProps",
							stackId,
							props: { name: v },
						})
					}
				/>
				<CommitField
					key={"stack:w"}
					id={"stack:w"}
					label={"Card width"}
					value={String(w)}
					type={"number"}
					onCommit={(v) =>
						dispatch({
							type: "ClassicyAppHCEditSetStackProps",
							stackId,
							props: { width: Number(v) },
						})
					}
				/>
				<CommitField
					key={"stack:h"}
					id={"stack:h"}
					label={"Card height"}
					value={String(h)}
					type={"number"}
					onCommit={(v) =>
						dispatch({
							type: "ClassicyAppHCEditSetStackProps",
							stackId,
							props: { height: Number(v) },
						})
					}
				/>
				<ClassicyButton
					onClickFunc={() =>
						dispatch({
							type: "ClassicyAppHCEditShowScript",
							stackId,
							target: { kind: "stack" },
						})
					}
				>
					Stack Script…
				</ClassicyButton>
				<ClassicyControlLabel label={"Variables"} />
				{variables.map(([name, value]) => (
					<div key={`var:${name}`} className={"classicyHyperCardInspectorRow"}>
						<CommitField
							id={`var:${name}`}
							label={name}
							value={String(value)}
							onCommit={(v) =>
								dispatch({
									type: "ClassicyAppHCEditSetStackVariable",
									stackId,
									name,
									value: Number.isFinite(Number(v)) && v !== "" ? Number(v) : v,
								})
							}
						/>
						<ClassicyButton
							onClickFunc={() =>
								dispatch({
									type: "ClassicyAppHCEditSetStackVariable",
									stackId,
									name,
									value: undefined,
								})
							}
						>
							Delete
						</ClassicyButton>
					</div>
				))}
				<div className={"classicyHyperCardInspectorRow"}>
					<ClassicyInput
						id={"var:new:name"}
						labelTitle={"New variable"}
						placeholder={"name"}
						onChangeFunc={(e) => {
							newVarName = e.target.value;
						}}
					/>
					<ClassicyInput
						id={"var:new:value"}
						placeholder={"value"}
						onChangeFunc={(e) => {
							newVarValue = e.target.value;
						}}
						onEnterFunc={() => {
							if (newVarName) {
								dispatch({
									type: "ClassicyAppHCEditSetStackVariable",
									stackId,
									name: newVarName,
									value:
										Number.isFinite(Number(newVarValue)) && newVarValue !== ""
											? Number(newVarValue)
											: newVarValue,
								});
							}
						}}
					/>
				</div>
			</>
		);
	}
};
```

Append to `src/SystemFolder/HyperCard/HyperCard.scss`:

```scss
.classicyHyperCardInspector {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 6px;
	max-width: 220px;
}

.classicyHyperCardInspectorRow {
	display: flex;
	gap: 4px;
	align-items: flex-end;
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run src/SystemFolder/HyperCard/Editor/HyperCardInspector.test.tsx` → PASS. If Biome flags the plain `let latest` closures, keep them — they are the same uncontrolled-commit idiom `HyperCardField` uses; do NOT convert to state.

- [ ] **Step 5: Verify + commit**

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/Editor/ src/SystemFolder/HyperCard/HyperCard.scss
git add src/SystemFolder/HyperCard/Editor/ src/SystemFolder/HyperCard/HyperCard.scss
git commit -m "feat(hypercard): schema-driven property inspector"
```

---

### Task 5: Inspector window wiring

**Files:**
- Modify: `src/SystemFolder/HyperCard/HyperCard.tsx`
- Modify: `src/SystemFolder/HyperCard/HyperCard.editor.test.tsx`

**Interfaces:**
- Consumes: Task 4's `HyperCardInspector`.
- Produces: a third `ClassicyWindow` `id="hypercard_inspector"`, title `"Info"`, rendered whenever `edit && activeStackId` (like the Tools palette), `appMenu={appMenu}` (REQUIRED — Plan 1's menu-staleness lesson: every window of this app must carry the live menu), `initialSize={[240, 0]}`, `initialPosition={[8, 360]}`, containing `<HyperCardInspector stackId={activeStackId} edit={edit} />`.

- [ ] **Step 1: Failing test** — append to `HyperCard.editor.test.tsx`:

```tsx
	it("renders the inspector window (with appMenu) while editing", () => {
		mockState = stateWith(makeEdit());
		const { container } = render(<HyperCard />);
		const inspector = container.querySelector(
			'[data-window-id="hypercard_inspector"]',
		);
		expect(inspector).not.toBeNull();
		expect(inspector?.getAttribute("data-has-app-menu")).toBe("true");
	});
```

- [ ] **Step 2: Run to verify failure**, then implement: in `HyperCard.tsx`, next to the Tools palette window block, add:

```tsx
			{edit && activeStackId ? (
				<ClassicyWindow
					id={"hypercard_inspector"}
					title={"Info"}
					appId={appId}
					appMenu={appMenu}
					windowType={"utility"}
					initialSize={[240, 0]}
					initialPosition={[8, 360]}
				>
					<HyperCardInspector stackId={activeStackId} edit={edit} />
				</ClassicyWindow>
			) : null}
```

with `import { HyperCardInspector } from "@/SystemFolder/HyperCard/Editor/HyperCardInspector";`.

- [ ] **Step 3: Run full HyperCard suite + tsc + biome; commit**

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/HyperCard.tsx src/SystemFolder/HyperCard/HyperCard.editor.test.tsx
git add src/SystemFolder/HyperCard/HyperCard.tsx src/SystemFolder/HyperCard/HyperCard.editor.test.tsx
git commit -m "feat(hypercard): inspector window wired into edit mode"
```

---

### Task 6: Script model + validation + raw-JSON tab + SetScript reducer case

**Files:**
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardScriptModel.ts`
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardScriptJson.tsx`
- Test: `src/SystemFolder/HyperCard/Editor/HyperCardScriptModel.test.ts`
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.ts` (SetScript case)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorContext.test.ts` (SetScript test)

**Interfaces:**
- Consumes: Task 3's `HCScriptTarget`; model's `HCEventHandlers`, `HC_EVENT_NAMES`.
- Produces:
  - `getTargetHandlers(draft: HCStack, edit: Pick<HCEditState, "currentCardId" | "layer">, target: HCScriptTarget): HCEventHandlers | undefined` — part looked up on the ACTIVE layer; `card` = current card's `script`; `background` = current card's background's `script`; `stack` = `stackScript`. Missing script objects → `{}` (not undefined); undefined ONLY when the target itself is missing (unknown part id, card without background).
  - `targetLabel(target: HCScriptTarget): string` — `Part “x”` / `Card Script` / `Background Script` / `Stack Script`.
  - `validateHandlers(raw: unknown): { ok: true; handlers: HCEventHandlers } | { ok: false; errors: string[] }` — object; every key ∈ `HC_EVENT_NAMES`; every value an array of objects each with a non-empty string `do`; recurses into `then`/`else`/`body` arrays.
  - Reducer case `ClassicyAppHCEditSetScript { stackId, target: HCScriptTarget, handlers: HCEventHandlers }` — writes via `applyEdit` (creating `script`/`stackScript` on the owner; an empty handlers object DELETES the script key).
  - `HyperCardScriptJson: FC<{ stackId: string; target: HCScriptTarget; handlers: HCEventHandlers }>` — textarea seeded with `JSON.stringify(handlers, null, "\t")`, an error label, and an Apply button that parses + `validateHandlers` + dispatches SetScript (errors shown, no dispatch, on failure).

- [ ] **Step 1: Failing tests** — `HyperCardScriptModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	getTargetHandlers,
	targetLabel,
	validateHandlers,
} from "@/SystemFolder/HyperCard/Editor/HyperCardScriptModel";
import type { HCStack } from "@/SystemFolder/HyperCard/HyperCardModel";

const stack: HCStack = {
	name: "Demo",
	backgrounds: [
		{ id: "bg1", script: { onOpenBackground: [{ do: "beep" }] } },
	],
	cards: [
		{
			id: "c1",
			background: "bg1",
			parts: [
				{
					id: "b1",
					type: "button",
					script: { onMouseUp: [{ do: "go", to: "next" }] },
				},
			],
		},
		{ id: "c2" },
	],
	stackScript: { onOpenStack: [{ do: "beep" }] },
};

const at = { currentCardId: "c1", layer: "card" as const };

describe("getTargetHandlers", () => {
	it("resolves each target kind", () => {
		expect(
			getTargetHandlers(stack, at, { kind: "part", partId: "b1" }),
		).toEqual({ onMouseUp: [{ do: "go", to: "next" }] });
		expect(getTargetHandlers(stack, at, { kind: "card" })).toEqual({});
		expect(getTargetHandlers(stack, at, { kind: "background" })).toEqual({
			onOpenBackground: [{ do: "beep" }],
		});
		expect(getTargetHandlers(stack, at, { kind: "stack" })).toEqual({
			onOpenStack: [{ do: "beep" }],
		});
	});

	it("returns undefined for missing targets", () => {
		expect(
			getTargetHandlers(stack, at, { kind: "part", partId: "nope" }),
		).toBeUndefined();
		expect(
			getTargetHandlers(
				stack,
				{ currentCardId: "c2", layer: "card" },
				{ kind: "background" },
			),
		).toBeUndefined();
	});
});

describe("targetLabel", () => {
	it("labels targets", () => {
		expect(targetLabel({ kind: "part", partId: "b1" })).toBe("Part “b1”");
		expect(targetLabel({ kind: "stack" })).toBe("Stack Script");
	});
});

describe("validateHandlers", () => {
	it("accepts well-formed handlers including nested actions", () => {
		const result = validateHandlers({
			onMouseUp: [
				{ do: "if", condition: "1 > 0", then: [{ do: "beep" }], else: [] },
				{ do: "repeat", times: 2, body: [{ do: "play", sound: "boop" }] },
			],
		});
		expect(result.ok).toBe(true);
	});

	it("rejects unknown events, non-arrays, and do-less actions", () => {
		expect(validateHandlers({ onSneeze: [] }).ok).toBe(false);
		expect(validateHandlers({ onMouseUp: {} }).ok).toBe(false);
		expect(validateHandlers({ onMouseUp: [{ to: "next" }] }).ok).toBe(false);
		expect(
			validateHandlers({ onMouseUp: [{ do: "if", then: [{ nope: 1 }] }] }).ok,
		).toBe(false);
		expect(validateHandlers("nope").ok).toBe(false);
	});
});
```

Append to `HyperCardEditorContext.test.ts`:

```ts
	it("SetScript writes handlers to the target and empty handlers delete the script", () => {
		const store = makeStore();
		enter(store);
		dispatch(store, {
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "button1" },
			handlers: { onMouseUp: [{ do: "beep" }] },
		});
		expect(edit(store).draft.cards[0].parts![0].script).toEqual({
			onMouseUp: [{ do: "beep" }],
		});
		dispatch(store, {
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "button1" },
			handlers: {},
		});
		expect(edit(store).draft.cards[0].parts![0].script).toBeUndefined();
		dispatch(store, {
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "stack" },
			handlers: { onOpenStack: [{ do: "beep" }] },
		});
		expect(edit(store).draft.stackScript).toEqual({
			onOpenStack: [{ do: "beep" }],
		});
	});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `HyperCardScriptModel.ts`**

```ts
/**
 * Script-editor model: resolve a script target to its event-handler object,
 * and validate raw JSON as HCEventHandlers. Validation is structural only —
 * `do` names are NOT checked against the verb list, because plugin commands
 * are legal `do` values (the engine resolves them at run time).
 */

import type { HCEditState, HCScriptTarget } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import {
	HC_EVENT_NAMES,
	type HCEventHandlers,
	type HCStack,
} from "@/SystemFolder/HyperCard/HyperCardModel";

export function getTargetHandlers(
	draft: HCStack,
	edit: Pick<HCEditState, "currentCardId" | "layer">,
	target: HCScriptTarget,
): HCEventHandlers | undefined {
	const card = draft.cards.find((c) => c.id === edit.currentCardId);
	if (!card) return undefined;
	switch (target.kind) {
		case "part": {
			const parts =
				edit.layer === "background"
					? draft.backgrounds?.find((b) => b.id === card.background)?.parts
					: card.parts;
			const part = parts?.find((p) => p.id === target.partId);
			return part ? (part.script ?? {}) : undefined;
		}
		case "card":
			return card.script ?? {};
		case "background": {
			const bg = draft.backgrounds?.find((b) => b.id === card.background);
			return bg ? (bg.script ?? {}) : undefined;
		}
		case "stack":
			return draft.stackScript ?? {};
	}
}

export function targetLabel(target: HCScriptTarget): string {
	switch (target.kind) {
		case "part":
			return `Part “${target.partId}”`;
		case "card":
			return "Card Script";
		case "background":
			return "Background Script";
		case "stack":
			return "Stack Script";
	}
}

export function validateHandlers(
	raw: unknown,
): { ok: true; handlers: HCEventHandlers } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, errors: ["Script must be a JSON object of event handlers."] };
	}
	const eventNames = new Set<string>(HC_EVENT_NAMES);
	for (const [event, actions] of Object.entries(raw)) {
		if (!eventNames.has(event)) {
			errors.push(`Unknown event "${event}".`);
			continue;
		}
		validateActionList(actions, event, errors);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, handlers: raw as HCEventHandlers };
}

function validateActionList(
	actions: unknown,
	where: string,
	errors: string[],
): void {
	if (!Array.isArray(actions)) {
		errors.push(`${where} must be an array of actions.`);
		return;
	}
	actions.forEach((action, i) => {
		if (typeof action !== "object" || action === null || Array.isArray(action)) {
			errors.push(`${where}[${i}] must be an object.`);
			return;
		}
		const a = action as Record<string, unknown>;
		if (typeof a.do !== "string" || a.do.length === 0) {
			errors.push(`${where}[${i}] is missing a string "do".`);
		}
		for (const nested of ["then", "else", "body"] as const) {
			if (a[nested] !== undefined) {
				validateActionList(a[nested], `${where}[${i}].${nested}`, errors);
			}
		}
	});
}
```

- [ ] **Step 4: SetScript reducer case** — add to `HyperCardEditorContext.ts` (imports: `HCEventHandlers` type from the model):

```ts
		case "ClassicyAppHCEditSetScript": {
			const edit = getEdit(ds, action);
			const target = action.target as HCScriptTarget | undefined;
			const handlers = action.handlers as HCEventHandlers | undefined;
			if (!edit || !target || typeof handlers !== "object" || handlers === null)
				break;
			const empty = Object.keys(handlers).length === 0;
			applyEdit(edit, (draft) => {
				const card = draft.cards.find((c) => c.id === edit.currentCardId);
				if (!card) return;
				switch (target.kind) {
					case "part": {
						const parts =
							edit.layer === "background"
								? draft.backgrounds?.find((b) => b.id === card.background)?.parts
								: card.parts;
						const part = parts?.find((p) => p.id === target.partId);
						if (part) part.script = empty ? undefined : handlers;
						break;
					}
					case "card":
						card.script = empty ? undefined : handlers;
						break;
					case "background": {
						const bg = draft.backgrounds?.find((b) => b.id === card.background);
						if (bg) bg.script = empty ? undefined : handlers;
						break;
					}
					case "stack":
						draft.stackScript = empty ? undefined : handlers;
						break;
				}
			});
			break;
		}
```

- [ ] **Step 5: Implement `HyperCardScriptJson.tsx`**

```tsx
/**
 * Raw-JSON script tab: the target's handlers as pretty JSON; Apply validates
 * (parse + validateHandlers) and dispatches SetScript, or shows the first
 * error without dispatching.
 */

import { type FC as FunctionalComponent, useState } from "react";
import { useAppManagerDispatch } from "@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils";
import type { HCScriptTarget } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import { validateHandlers } from "@/SystemFolder/HyperCard/Editor/HyperCardScriptModel";
import type { HCEventHandlers } from "@/SystemFolder/HyperCard/HyperCardModel";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyControlLabel } from "@/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel";
import { ClassicyTextEditor } from "@/SystemFolder/SystemResources/TextEditor/ClassicyTextEditor";

interface HyperCardScriptJsonProps {
	stackId: string;
	target: HCScriptTarget;
	handlers: HCEventHandlers;
}

export const HyperCardScriptJson: FunctionalComponent<
	HyperCardScriptJsonProps
> = ({ stackId, target, handlers }) => {
	const dispatch = useAppManagerDispatch();
	const seeded = JSON.stringify(handlers, null, "\t");
	const [text, setText] = useState(seeded);
	const [error, setError] = useState<string | undefined>();

	const apply = () => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		const result = validateHandlers(parsed);
		if ("errors" in result) {
			setError(result.errors[0]);
			return;
		}
		setError(undefined);
		dispatch({
			type: "ClassicyAppHCEditSetScript",
			stackId,
			target,
			handlers: result.handlers,
		});
	};

	return (
		<div className={"classicyHyperCardScriptJson"}>
			<ClassicyTextEditor
				key={`${stackId}:${JSON.stringify(target)}`}
				id={"hypercard_script_json"}
				border={true}
				prefillValue={seeded}
				onChangeFunc={(e) => setText(e.target.value)}
			/>
			{error ? <ClassicyControlLabel label={`✗ ${error}`} /> : null}
			<ClassicyButton onClickFunc={apply} isDefault={true}>
				Apply
			</ClassicyButton>
		</div>
	);
};
```

- [ ] **Step 6: Run to verify pass**, then verify + commit:

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/Editor/
git add src/SystemFolder/HyperCard/Editor/
git commit -m "feat(hypercard): script model, structural validation, SetScript, raw-JSON tab"
```

---

### Task 7: Script builder tab + script editor window

**Files:**
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardScriptBuilder.tsx`
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardScriptEditor.tsx`
- Test: `src/SystemFolder/HyperCard/Editor/HyperCardScriptEditor.test.tsx`
- Modify: `src/SystemFolder/HyperCard/HyperCard.tsx` (script window + Edit-menu entry)
- Modify: `src/SystemFolder/HyperCard/HyperCard.scss` (builder styles)

**Interfaces:**
- Consumes: Task 6's model/tab; Task 1's `getRegisteredEditorCommands`, `getHyperCardCommandEditorMeta`, `HCOptionField`; model's `HC_EVENT_NAMES`.
- Produces:
  - `BUILTIN_ACTION_SPECS: Record<string, HCOptionField[]>` (exported from `HyperCardScriptBuilder.tsx`) — flat params per verb: `go:[to]`, `put/add/subtract/multiply/divide:[value, var, field]`, `set:[part, property, value]`, `show/hide:[part]`, `beep:[]`, `play:[sound]`, `answer:[message, buttons(choices), var, field]`, `ask:[prompt, default, var, field]`, `visual:[effect]`, `wait:[ms(number)]`, `openApp:[app, event]`, `if:[condition]`, `repeat:[times(number), while]`. Nested `then`/`else`/`body` are rendered as nested action lists, not fields.
  - `HyperCardScriptBuilder: FC<{ stackId: string; target: HCScriptTarget; handlers: HCEventHandlers }>` — one section per `HC_EVENT_NAMES` entry that has actions plus an "Add handler" popup for absent events; each action row: verb label, its fields (CommitField-style, committing a full-handlers SetScript), ↑/↓/Delete buttons; `if`/`repeat` rows render nested lists recursively with their own add-action popups. The add-action popup lists all builtin verbs plus `getRegisteredEditorCommands()` labels.
  - `HyperCardScriptEditor: FC<{ stackId: string; edit: HCEditState }>` — resolves `edit.script.target` via `getTargetHandlers` (target vanished → dispatches `HideScript`); header label via `targetLabel`; two `ClassicyButton` tabs (Builder default, JSON) with local `useState`; Close button → `HideScript`.
  - `HyperCard.tsx`: window `id="hypercard_script"` rendered when `edit?.script && activeStackId` (with `appMenu={appMenu}`, `initialSize={[420, 0]}`, `initialPosition={["center", 120]}`); Edit menu gains `{ id: "edit_script", title: "Edit Script…" }` dispatching `ShowScript` with the selected part (or `{kind:"card"}` when nothing is selected).

**Builder editing model (important):** the builder never keeps its own draft of the handlers — every mutation (add/remove/reorder/field-commit) computes the next FULL handlers object from the props value using the pure helpers below (defined at the top of `HyperCardScriptBuilder.tsx`) and dispatches one `SetScript`. Undo granularity = one builder mutation, matching the inspector.

```ts
/** Address of an action list inside handlers: the event, then a path of (index, branch) hops. */
export type HCActionPath = {
	event: HCEventName;
	hops: { index: number; branch: "then" | "else" | "body" }[];
};

export function listAt(handlers: HCEventHandlers, path: HCActionPath): HCAction[];
export function withListAt(handlers: HCEventHandlers, path: HCActionPath, next: HCAction[]): HCEventHandlers;
```

(`withListAt` deep-clones via `JSON.parse(JSON.stringify(handlers))`, walks `hops`, replaces the addressed array, and drops the event key when its top-level array becomes empty.)

- [ ] **Step 1: Failing tests** — `HyperCardScriptEditor.test.tsx` (mocks as in `HyperCardInspector.test.tsx`; `makeEdit` includes a part `b1` with `script: { onMouseUp: [{ do: "beep" }, { do: "go", to: "next" }] }` and `edit.script = { target: { kind: "part", partId: "b1" } }`):

```tsx
	it("builder lists existing actions per event", () => {
		render(<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />);
		expect(screen.getByText("onMouseUp")).toBeTruthy();
		expect(screen.getByText("beep")).toBeTruthy();
		expect(screen.getByText("go")).toBeTruthy();
	});

	it("deleting an action dispatches the full remaining handlers", () => {
		const { container } = render(
			<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />,
		);
		const deleteButtons = screen.getAllByText("Delete");
		fireEvent.click(deleteButtons[0]);
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "b1" },
			handlers: { onMouseUp: [{ do: "go", to: "next" }] },
		});
	});

	it("reordering swaps neighbors", () => {
		render(<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />);
		fireEvent.click(screen.getAllByText("↓")[0]);
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "b1" },
			handlers: { onMouseUp: [{ do: "go", to: "next" }, { do: "beep" }] },
		});
	});

	it("adding an action via the popup appends it with defaults", () => {
		const { container } = render(
			<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />,
		);
		const addPopup = container.querySelector(
			'select[id^="add:onMouseUp"]',
		) as HTMLSelectElement;
		fireEvent.change(addPopup, { target: { value: "wait" } });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "b1" },
			handlers: {
				onMouseUp: [{ do: "beep" }, { do: "go", to: "next" }, { do: "wait", ms: 0 }],
			},
		});
	});

	it("JSON tab applies a valid script and surfaces validation errors", () => {
		const { container } = render(
			<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />,
		);
		fireEvent.click(screen.getByText("JSON"));
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: '{"onMouseUp": [{"to": "x"}]}' } });
		fireEvent.click(screen.getByText("Apply"));
		expect(screen.getByText(/missing a string "do"/)).toBeTruthy();
		fireEvent.change(textarea, { target: { value: '{"onMouseUp": [{"do": "beep"}]}' } });
		fireEvent.click(screen.getByText("Apply"));
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetScript",
			stackId: "demo",
			target: { kind: "part", partId: "b1" },
			handlers: { onMouseUp: [{ do: "beep" }] },
		});
	});

	it("Close dispatches HideScript", () => {
		render(<HyperCardScriptEditor stackId={"demo"} edit={makeEdit()} />);
		fireEvent.click(screen.getByText("Close"));
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditHideScript",
			stackId: "demo",
		});
	});
```

(Full test file: assemble with the standard mock preamble, `makeEdit` as described, `beforeEach(() => dispatch.mockClear())`.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `HyperCardScriptBuilder.tsx`**

```tsx
/**
 * Visual script builder: per-event ordered action lists with typed per-verb
 * fields, nested if/repeat blocks, add/remove/reorder. Stateless over the
 * handlers prop — every mutation computes the next full handlers object and
 * dispatches one SetScript (undo granularity = one mutation).
 */

import type { ChangeEvent, FC as FunctionalComponent } from "react";
import { useAppManagerDispatch } from "@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils";
import type { HCScriptTarget } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import {
	HC_EVENT_NAMES,
	type HCAction,
	type HCEventHandlers,
	type HCEventName,
} from "@/SystemFolder/HyperCard/HyperCardModel";
import {
	getHyperCardCommandEditorMeta,
	getRegisteredEditorCommands,
	type HCOptionField,
} from "@/SystemFolder/HyperCard/HyperCardPlugins";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyControlLabel } from "@/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel";
import { ClassicyInput } from "@/SystemFolder/SystemResources/Input/ClassicyInput";
import { ClassicyPopUpMenu } from "@/SystemFolder/SystemResources/PopUpMenu/ClassicyPopUpMenu";

const text = (key: string, label?: string): HCOptionField => ({
	key,
	label: label ?? key,
	kind: "text",
});
const num = (key: string, label?: string): HCOptionField => ({
	key,
	label: label ?? key,
	kind: "number",
});

/** Flat editable params per built-in verb (nested lists handled structurally). */
export const BUILTIN_ACTION_SPECS: Record<string, HCOptionField[]> = {
	go: [text("to")],
	put: [text("value"), text("var"), text("field")],
	add: [text("value"), text("var"), text("field")],
	subtract: [text("value"), text("var"), text("field")],
	multiply: [text("value"), text("var"), text("field")],
	divide: [text("value"), text("var"), text("field")],
	set: [text("part"), text("property"), text("value")],
	show: [text("part")],
	hide: [text("part")],
	beep: [],
	play: [text("sound")],
	answer: [text("message"), { key: "buttons", label: "buttons", kind: "choices" }, text("var"), text("field")],
	ask: [text("prompt"), text("default"), text("var"), text("field")],
	visual: [text("effect")],
	wait: [num("ms")],
	openApp: [text("app"), text("event")],
	if: [text("condition")],
	repeat: [num("times"), text("while")],
};

/** Default new action per verb (nested verbs seed their branch arrays). */
function newAction(verb: string): HCAction {
	if (verb === "wait") return { do: "wait", ms: 0 };
	if (verb === "if") return { do: "if", condition: "", then: [] };
	if (verb === "repeat") return { do: "repeat", times: 1, body: [] };
	return { do: verb } as HCAction;
}

/** Address of an action list inside handlers. */
export interface HCActionPath {
	event: HCEventName;
	hops: { index: number; branch: "then" | "else" | "body" }[];
}

export function listAt(
	handlers: HCEventHandlers,
	path: HCActionPath,
): HCAction[] {
	let list: HCAction[] = handlers[path.event] ?? [];
	for (const hop of path.hops) {
		const parent = list[hop.index] as unknown as Record<string, HCAction[]>;
		list = parent?.[hop.branch] ?? [];
	}
	return list;
}

export function withListAt(
	handlers: HCEventHandlers,
	path: HCActionPath,
	next: HCAction[],
): HCEventHandlers {
	const clone = JSON.parse(JSON.stringify(handlers)) as HCEventHandlers;
	if (path.hops.length === 0) {
		if (next.length === 0) delete clone[path.event];
		else clone[path.event] = next;
		return clone;
	}
	let list = clone[path.event] ?? [];
	for (const hop of path.hops.slice(0, -1)) {
		list = (list[hop.index] as unknown as Record<string, HCAction[]>)[
			hop.branch
		];
	}
	const last = path.hops[path.hops.length - 1];
	(list[last.index] as unknown as Record<string, HCAction[]>)[last.branch] =
		next;
	return clone;
}

interface HyperCardScriptBuilderProps {
	stackId: string;
	target: HCScriptTarget;
	handlers: HCEventHandlers;
}

export const HyperCardScriptBuilder: FunctionalComponent<
	HyperCardScriptBuilderProps
> = ({ stackId, target, handlers }) => {
	const dispatch = useAppManagerDispatch();
	const commands = getRegisteredEditorCommands();
	const verbOptions = [
		...Object.keys(BUILTIN_ACTION_SPECS).map((v) => ({ value: v, label: v })),
		...commands.map((c) => ({ value: c.name, label: c.meta.label })),
	];

	const commit = (next: HCEventHandlers) =>
		dispatch({ type: "ClassicyAppHCEditSetScript", stackId, target, handlers: next });

	const events = HC_EVENT_NAMES.filter(
		(e) => (handlers[e] ?? []).length > 0,
	);
	const absent = HC_EVENT_NAMES.filter((e) => !(handlers[e] ?? []).length);

	return (
		<div className={"classicyHyperCardScriptBuilder"}>
			{events.map((event) => (
				<div key={event} className={"classicyHyperCardScriptEvent"}>
					<ClassicyControlLabel label={event} />
					<ActionList
						path={{ event, hops: [] }}
						handlers={handlers}
						commit={commit}
						verbOptions={verbOptions}
					/>
				</div>
			))}
			{absent.length > 0 ? (
				<ClassicyPopUpMenu
					id={"add:handler"}
					label={"Add handler"}
					placeholder={"event…"}
					options={absent.map((e) => ({ value: e, label: e }))}
					selected={""}
					onChangeFunc={(e: ChangeEvent<HTMLSelectElement>) => {
						const event = e.target.value as HCEventName;
						if (event) commit({ ...handlers, [event]: [] });
					}}
				/>
			) : null}
		</div>
	);
};

const ActionList: FunctionalComponent<{
	path: HCActionPath;
	handlers: HCEventHandlers;
	commit: (next: HCEventHandlers) => void;
	verbOptions: { value: string; label: string }[];
}> = ({ path, handlers, commit, verbOptions }) => {
	const actions = listAt(handlers, path);
	const pathKey =
		path.event + path.hops.map((h) => `.${h.index}.${h.branch}`).join("");

	const replace = (next: HCAction[]) => commit(withListAt(handlers, path, next));

	return (
		<div className={"classicyHyperCardActionList"}>
			{actions.map((action, i) => {
				const a = action as unknown as Record<string, unknown>;
				const verb = String(a.do);
				// Built-in verbs use their spec; plugin commands use their registered
				// editor-meta fields; unknown verbs get no fields (row still shows
				// verb + reorder/delete, and the JSON tab can edit its params).
				const fields =
					BUILTIN_ACTION_SPECS[verb] ??
					getHyperCardCommandEditorMeta(verb)?.fields ??
					[];
				return (
					<div key={`${pathKey}:${i}`} className={"classicyHyperCardActionRow"}>
						<ClassicyControlLabel label={verb} />
						{fields.map((field) => (
							<ActionField
								key={`${pathKey}:${i}:${field.key}`}
								id={`${pathKey}:${i}:${field.key}`}
								field={field}
								value={a[field.key]}
								onCommit={(value) => {
									const next = [...actions];
									const updated = { ...a };
									if (value === undefined) delete updated[field.key];
									else updated[field.key] = value;
									next[i] = updated as unknown as HCAction;
									replace(next);
								}}
							/>
						))}
						<ClassicyButton
							onClickFunc={() => {
								if (i === 0) return;
								const next = [...actions];
								[next[i - 1], next[i]] = [next[i], next[i - 1]];
								replace(next);
							}}
						>
							↑
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => {
								if (i === actions.length - 1) return;
								const next = [...actions];
								[next[i], next[i + 1]] = [next[i + 1], next[i]];
								replace(next);
							}}
						>
							↓
						</ClassicyButton>
						<ClassicyButton
							onClickFunc={() => replace(actions.filter((_, j) => j !== i))}
						>
							Delete
						</ClassicyButton>
						{(["then", "else", "body"] as const)
							.filter((branch) => verb === "if" ? branch !== "body" : verb === "repeat" && branch === "body")
							.map((branch) => (
								<div
									key={`${pathKey}:${i}:${branch}`}
									className={"classicyHyperCardActionNested"}
								>
									<ClassicyControlLabel label={branch} />
									<ActionList
										path={{ event: path.event, hops: [...path.hops, { index: i, branch }] }}
										handlers={handlers}
										commit={commit}
										verbOptions={verbOptions}
									/>
								</div>
							))}
					</div>
				);
			})}
			<ClassicyPopUpMenu
				id={`add:${pathKey}`}
				placeholder={"+ add action…"}
				options={verbOptions}
				selected={""}
				onChangeFunc={(e: ChangeEvent<HTMLSelectElement>) => {
					const verb = e.target.value;
					if (verb) replace([...actions, newAction(verb)]);
				}}
			/>
		</div>
	);
};

const ActionField: FunctionalComponent<{
	id: string;
	field: HCOptionField;
	value: unknown;
	onCommit: (value: unknown) => void;
}> = ({ id, field, value, onCommit }) => {
	if (field.kind === "choices") {
		const seeded = Array.isArray(value) ? (value as string[]).join(", ") : "";
		let latest = seeded;
		return (
			<div
				onBlur={() => {
					if (latest === seeded) return;
					const parts = latest
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
					onCommit(parts.length > 0 ? parts : undefined);
				}}
			>
				<ClassicyInput
					id={id}
					labelTitle={field.label}
					prefillValue={seeded}
					onChangeFunc={(e) => {
						latest = e.target.value;
					}}
				/>
			</div>
		);
	}
	const seeded = value === undefined ? "" : String(value);
	let latest = seeded;
	const commitLatest = () => {
		if (latest === seeded) return;
		if (latest === "") onCommit(undefined);
		else onCommit(field.kind === "number" ? Number(latest) : latest);
	};
	return (
		<div
			onBlur={commitLatest}
			onKeyDown={(e) => {
				if (e.key === "Enter") commitLatest();
			}}
		>
			<ClassicyInput
				id={id}
				labelTitle={field.label}
				prefillValue={seeded}
				type={field.kind === "number" ? "number" : undefined}
				onChangeFunc={(e) => {
					latest = e.target.value;
				}}
			/>
		</div>
	);
};
```

**Nested-branch filter note (subtle):** the filter expression above must render `then` + `else` for `if` rows (`else` even when absent? No — only when present OR offer an "add else"? Keep v1 simple: render `then` always for `if`; render `else` only when the action already has an `else` array; render `body` always for `repeat`). Implement it as:

```tsx
						{(verb === "if"
							? a.else !== undefined
								? (["then", "else"] as const)
								: (["then"] as const)
							: verb === "repeat"
								? (["body"] as const)
								: ([] as const)
						).map((branch) => ( /* nested block as above */ ))}
```

Use this exact conditional in place of the `.filter(...)` sketch — the sketch double-serves as documentation but the conditional is the implementation.

- [ ] **Step 4: Implement `HyperCardScriptEditor.tsx`**

```tsx
/**
 * The script-editor window content: target header, Builder/JSON tab switch,
 * and Close. The Builder is the default tab; both tabs are views over the
 * same handlers in the draft (each Apply/mutation dispatches SetScript).
 */

import { type FC as FunctionalComponent, useState } from "react";
import { useAppManagerDispatch } from "@/SystemFolder/ControlPanels/AppManager/ClassicyAppManagerUtils";
import type { HCEditState } from "@/SystemFolder/HyperCard/Editor/HyperCardEditorUtils";
import { HyperCardScriptBuilder } from "@/SystemFolder/HyperCard/Editor/HyperCardScriptBuilder";
import { HyperCardScriptJson } from "@/SystemFolder/HyperCard/Editor/HyperCardScriptJson";
import {
	getTargetHandlers,
	targetLabel,
} from "@/SystemFolder/HyperCard/Editor/HyperCardScriptModel";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyControlLabel } from "@/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel";

interface HyperCardScriptEditorProps {
	stackId: string;
	edit: HCEditState;
}

export const HyperCardScriptEditor: FunctionalComponent<
	HyperCardScriptEditorProps
> = ({ stackId, edit }) => {
	const dispatch = useAppManagerDispatch();
	const [tab, setTab] = useState<"builder" | "json">("builder");
	const target = edit.script?.target;
	const handlers = target
		? getTargetHandlers(edit.draft, edit, target)
		: undefined;

	if (!target || handlers === undefined) {
		// Target vanished (part deleted, background detached): close the editor.
		if (target) {
			dispatch({ type: "ClassicyAppHCEditHideScript", stackId });
		}
		return null;
	}

	return (
		<div className={"classicyHyperCardScriptEditor"}>
			<ClassicyControlLabel label={targetLabel(target)} />
			<div className={"classicyHyperCardScriptTabs"}>
				<ClassicyButton
					isDefault={tab === "builder"}
					onClickFunc={() => setTab("builder")}
				>
					Builder
				</ClassicyButton>
				<ClassicyButton
					isDefault={tab === "json"}
					onClickFunc={() => setTab("json")}
				>
					JSON
				</ClassicyButton>
				<ClassicyButton
					onClickFunc={() =>
						dispatch({ type: "ClassicyAppHCEditHideScript", stackId })
					}
				>
					Close
				</ClassicyButton>
			</div>
			{tab === "builder" ? (
				<HyperCardScriptBuilder
					stackId={stackId}
					target={target}
					handlers={handlers}
				/>
			) : (
				<HyperCardScriptJson
					stackId={stackId}
					target={target}
					handlers={handlers}
				/>
			)}
		</div>
	);
};
```

**Dispatch-in-render caveat:** the vanished-target `dispatch` during render is a React anti-pattern — implement it as a `useEffect` instead:

```tsx
	useEffect(() => {
		if (target && handlers === undefined) {
			dispatch({ type: "ClassicyAppHCEditHideScript", stackId });
		}
	}, [target, handlers, stackId, dispatch]);
	if (!target || handlers === undefined) return null;
```

Use the effect version; the inline sketch above shows intent only.

- [ ] **Step 5: Window + menu in `HyperCard.tsx`** — beside the inspector window:

```tsx
			{edit?.script && activeStackId ? (
				<ClassicyWindow
					id={"hypercard_script"}
					title={"Script"}
					appId={appId}
					appMenu={appMenu}
					initialSize={[440, 0]}
					initialPosition={["center", 120]}
					scrollable={true}
				>
					<HyperCardScriptEditor stackId={activeStackId} edit={edit} />
				</ClassicyWindow>
			) : null}
```

Edit menu (inside the existing `edit` menuChildren, after `delete_part`):

```tsx
						{ id: "edit_sep_2", title: "-" },
						{
							id: "edit_script",
							title: "Edit Script…",
							onClickFunc: () =>
								dispatch({
									type: "ClassicyAppHCEditShowScript",
									stackId: activeStackId,
									target: edit.selectedPartId
										? { kind: "part", partId: edit.selectedPartId }
										: { kind: "card" },
								}),
						},
```

SCSS append:

```scss
.classicyHyperCardScriptEditor,
.classicyHyperCardScriptBuilder,
.classicyHyperCardScriptJson {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 6px;
}

.classicyHyperCardScriptTabs {
	display: flex;
	gap: 4px;
}

.classicyHyperCardActionRow {
	border: 1px solid var(--color-system-03, #ccc);
	padding: 4px;
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	align-items: flex-end;
}

.classicyHyperCardActionNested {
	margin-left: 12px;
	width: 100%;
}
```

- [ ] **Step 6: Run to verify pass**, then full suite + tsc + biome; commit:

```bash
pnpm exec vitest run src/SystemFolder/HyperCard/ && pnpm exec tsc -b --noEmit 2>&1 | head -20
pnpm exec biome check --write src/SystemFolder/HyperCard/ 
git add src/SystemFolder/HyperCard/
git commit -m "feat(hypercard): visual script builder, script editor window, Edit menu entry"
```

---

### Task 8: Save-provider registry + Download provider + Saved Stacks browser

**Files:**
- Modify: `src/SystemFolder/HyperCard/HyperCardPlugins.ts` (registry)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorSave.ts` (Download provider + registration helper)
- Create: `src/SystemFolder/HyperCard/Editor/HyperCardSavedStacks.tsx` (+ test `HyperCardSavedStacks.test.tsx`)
- Modify: `src/SystemFolder/HyperCard/HyperCard.tsx` (menu items + window)
- Test: append to `src/SystemFolder/HyperCard/HyperCardPlugins.test.ts` and `Editor/HyperCardEditorSave.test.ts`

**Interfaces:**
- Produces (rt911 consumes in Plan 3):

```ts
export type HCSaveResult = { ok: true } | { ok: false; error: string };
export interface HCSavedStackRef { id: string; name: string; updatedAt?: string }
export interface HyperCardSaveProvider {
	id: string;
	label: string;
	canSave: () => boolean;
	save: (stack: HCStack, meta: { stackId: string; fileName?: string }) => Promise<HCSaveResult>;
	list?: () => Promise<HCSavedStackRef[]>;
	load?: (ref: HCSavedStackRef) => Promise<HCStack>;
}
registerHyperCardSaveProvider(provider: HyperCardSaveProvider): void   // last-write-wins by id
getHyperCardSaveProviders(): HyperCardSaveProvider[]
```

- `HyperCardEditorSave.ts` gains `downloadSaveProvider: HyperCardSaveProvider` (`id: "download"`, `label: "Download"`, `canSave: () => true`, `save` wrapping the existing `downloadStack` and mapping `{ok:false,errors}` → `{ok:false,error:errors[0]}`; no `list`/`load`) and `registerDownloadSaveProvider(): void` which registers it (idempotent by registry semantics). `HyperCard.tsx` calls `registerDownloadSaveProvider()` at module scope next to the side-effect imports.
- File menu while editing: the single "Save a Copy…" item is replaced by one `Save to <label>` item per provider with `canSave() === true` (`id: save_<providerId>`; the Download provider's title stays exactly `"Save a Copy…"` for continuity). Each calls `provider.save(edit.draft, { stackId: activeStackId })` and on the promise: `ok` → `MarkSaved` dispatch; failure → the desktop error-dialog seam (`ClassicyAppHyperCardOpenFileFailed` with `path: ""` and the error message).
- "Open Saved Stack…" File item appears when ANY provider has `list`; it toggles local `useState` `savedStacksOpen`; the window `id="hypercard_saved"` (with `appMenu`) renders `<HyperCardSavedStacks onOpen={(stack, ref, providerId) => { dispatch OpenStack with stackId "saved:<providerId>:<ref.id>"; setSavedStacksOpen(false); }} />`.
- `HyperCardSavedStacks: FC<{ onOpen: (stack: HCStack, ref: HCSavedStackRef, providerId: string) => void }>` — on mount, for each provider with `list`, awaits `list()` and renders `name` rows with an Open button that awaits `load(ref)` then calls `onOpen`; list/load rejections render an inline error label; loading state label `"Loading…"`.

- [ ] **Step 1: Failing tests.** Registry (append to `HyperCardPlugins.test.ts`):

```ts
	it("registers save providers last-write-wins by id", () => {
		const a: HyperCardSaveProvider = {
			id: "p1",
			label: "One",
			canSave: () => true,
			save: async () => ({ ok: true }),
		};
		registerHyperCardSaveProvider(a);
		registerHyperCardSaveProvider({ ...a, label: "One v2" });
		const providers = getHyperCardSaveProviders();
		expect(providers.filter((p) => p.id === "p1")).toHaveLength(1);
		expect(providers.find((p) => p.id === "p1")?.label).toBe("One v2");
	});
```

Download provider (append to `HyperCardEditorSave.test.ts`):

```ts
describe("downloadSaveProvider", () => {
	it("maps validation failure to a single error string without downloading", async () => {
		const click = vi.fn();
		vi.spyOn(document, "createElement").mockReturnValue({
			click,
			href: "",
			download: "",
		} as unknown as HTMLAnchorElement);
		const result = await downloadSaveProvider.save(
			{ name: "", cards: [] } as unknown as HCStack,
			{ stackId: "x" },
		);
		expect(result).toMatchObject({ ok: false });
		if ("error" in result) expect(result.error.length).toBeGreaterThan(0);
		expect(click).not.toHaveBeenCalled();
	});

	it("registers itself under id download", () => {
		registerDownloadSaveProvider();
		expect(
			getHyperCardSaveProviders().some((p) => p.id === "download"),
		).toBe(true);
	});
});
```

`HyperCardSavedStacks.test.tsx` (standard mock preamble; no app-manager needed beyond dispatch mock):

```tsx
	it("lists provider entries and opens a loaded stack", async () => {
		const stack = { name: "Server Stack", cards: [{ id: "c1" }] };
		registerHyperCardSaveProvider({
			id: "test-remote",
			label: "Test Remote",
			canSave: () => true,
			save: async () => ({ ok: true }),
			list: async () => [{ id: "42", name: "Server Stack" }],
			load: async () => stack,
		});
		const onOpen = vi.fn();
		render(<HyperCardSavedStacks onOpen={onOpen} />);
		expect(await screen.findByText("Server Stack")).toBeTruthy();
		fireEvent.click(screen.getByText("Open"));
		await waitFor(() =>
			expect(onOpen).toHaveBeenCalledWith(
				stack,
				{ id: "42", name: "Server Stack" },
				"test-remote",
			),
		);
	});

	it("renders a list error inline", async () => {
		registerHyperCardSaveProvider({
			id: "test-broken",
			label: "Broken",
			canSave: () => true,
			save: async () => ({ ok: true }),
			list: async () => {
				throw new Error("nope");
			},
		});
		render(<HyperCardSavedStacks onOpen={vi.fn()} />);
		expect(await screen.findByText(/nope/)).toBeTruthy();
	});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Registry (append to `HyperCardPlugins.ts`; import `HCStack` type already present):

```ts
// ---------------------------------------------------------------------------
// Save providers (editor)
// ---------------------------------------------------------------------------

export type HCSaveResult = { ok: true } | { ok: false; error: string };

export interface HCSavedStackRef {
	id: string;
	name: string;
	updatedAt?: string;
}

/** A destination the editor can save stacks to (and optionally reopen from). */
export interface HyperCardSaveProvider {
	id: string;
	label: string;
	canSave: () => boolean;
	save: (
		stack: HCStack,
		meta: { stackId: string; fileName?: string },
	) => Promise<HCSaveResult>;
	list?: () => Promise<HCSavedStackRef[]>;
	load?: (ref: HCSavedStackRef) => Promise<HCStack>;
}

const saveProviderRegistry = new Map<string, HyperCardSaveProvider>();

export function registerHyperCardSaveProvider(
	provider: HyperCardSaveProvider,
): void {
	saveProviderRegistry.set(provider.id, provider);
}

export function getHyperCardSaveProviders(): HyperCardSaveProvider[] {
	return Array.from(saveProviderRegistry.values());
}
```

`HyperCardEditorSave.ts` additions:

```ts
import {
	type HyperCardSaveProvider,
	registerHyperCardSaveProvider,
} from "@/SystemFolder/HyperCard/HyperCardPlugins";

/** The built-in save destination: download the .stack.json to the user's computer. */
export const downloadSaveProvider: HyperCardSaveProvider = {
	id: "download",
	label: "Download",
	canSave: () => true,
	save: async (stack, meta) => {
		const result = downloadStack(stack);
		if ("errors" in result) return { ok: false, error: result.errors[0] };
		return { ok: true };
	},
};

export function registerDownloadSaveProvider(): void {
	registerHyperCardSaveProvider(downloadSaveProvider);
}
```

(`meta` is accepted-but-unused by the download provider — prefix the param `_meta` if Biome flags it.)

`HyperCardSavedStacks.tsx`:

```tsx
/**
 * "Open Saved Stack…" browser: lists every save provider that implements
 * list(), with an Open button per entry that load()s the stack and hands it
 * to the host (which dispatches OpenStack and closes this window).
 */

import { type FC as FunctionalComponent, useEffect, useState } from "react";
import {
	getHyperCardSaveProviders,
	type HCSavedStackRef,
} from "@/SystemFolder/HyperCard/HyperCardPlugins";
import type { HCStack } from "@/SystemFolder/HyperCard/HyperCardModel";
import { ClassicyButton } from "@/SystemFolder/SystemResources/Button/ClassicyButton";
import { ClassicyControlLabel } from "@/SystemFolder/SystemResources/ControlLabel/ClassicyControlLabel";

interface ProviderListing {
	providerId: string;
	label: string;
	refs?: HCSavedStackRef[];
	error?: string;
}

interface HyperCardSavedStacksProps {
	onOpen: (stack: HCStack, ref: HCSavedStackRef, providerId: string) => void;
}

export const HyperCardSavedStacks: FunctionalComponent<
	HyperCardSavedStacksProps
> = ({ onOpen }) => {
	const [listings, setListings] = useState<ProviderListing[] | undefined>();
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		const providers = getHyperCardSaveProviders().filter((p) => p.list);
		Promise.all(
			providers.map(async (p) => {
				try {
					// biome-ignore lint/style/noNonNullAssertion: filtered on list above
					const refs = await p.list!();
					return { providerId: p.id, label: p.label, refs };
				} catch (err) {
					return {
						providerId: p.id,
						label: p.label,
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}),
		).then((results) => {
			if (!cancelled) setListings(results);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const open = async (providerId: string, ref: HCSavedStackRef) => {
		const provider = getHyperCardSaveProviders().find(
			(p) => p.id === providerId,
		);
		if (!provider?.load) return;
		try {
			const stack = await provider.load(ref);
			onOpen(stack, ref, providerId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	if (!listings) return <ClassicyControlLabel label={"Loading…"} />;

	return (
		<div className={"classicyHyperCardSavedStacks"}>
			{listings.map((listing) => (
				<div key={listing.providerId}>
					<ClassicyControlLabel label={listing.label} />
					{listing.error ? (
						<ClassicyControlLabel label={`✗ ${listing.error}`} />
					) : null}
					{(listing.refs ?? []).map((ref) => (
						<div
							key={`${listing.providerId}:${ref.id}`}
							className={"classicyHyperCardInspectorRow"}
						>
							<ClassicyControlLabel label={ref.name} />
							<ClassicyButton
								onClickFunc={() => void open(listing.providerId, ref)}
							>
								Open
							</ClassicyButton>
						</div>
					))}
				</div>
			))}
			{error ? <ClassicyControlLabel label={`✗ ${error}`} /> : null}
		</div>
	);
};
```

`HyperCard.tsx` changes: at module scope (after the side-effect imports) `registerDownloadSaveProvider();`. Add `const [savedStacksOpen, setSavedStacksOpen] = useState(false);`. Replace the `save_copy` File item block with a map over `getHyperCardSaveProviders().filter((p) => p.canSave())`:

```tsx
					...(activeStackId && edit
						? getHyperCardSaveProviders()
								.filter((p) => p.canSave())
								.map((provider) => ({
									id: `save_${provider.id}`,
									title:
										provider.id === "download"
											? "Save a Copy…"
											: `Save to ${provider.label}`,
									onClickFunc: () => {
										void provider
											.save(edit.draft, { stackId: activeStackId })
											.then((result) => {
												if ("error" in result) {
													dispatch({
														type: "ClassicyAppHyperCardOpenFileFailed",
														path: "",
														message: `The stack can’t be saved: ${result.error}`,
													});
												} else {
													dispatch({
														type: "ClassicyAppHCEditMarkSaved",
														stackId: activeStackId,
													});
												}
											});
									},
								}))
						: []),
					...(getHyperCardSaveProviders().some((p) => p.list)
						? [
								{
									id: "open_saved",
									title: "Open Saved Stack…",
									onClickFunc: () => setSavedStacksOpen(true),
								},
							]
						: []),
```

(Keep `stop_editing` where it is. Add `setSavedStacksOpen` to the appMenu useMemo deps — it is stable from useState but Biome/React lint expects it listed.) Window, next to the others:

```tsx
			{savedStacksOpen ? (
				<ClassicyWindow
					id={"hypercard_saved"}
					title={"Saved Stacks"}
					appId={appId}
					appMenu={appMenu}
					initialSize={[300, 0]}
					initialPosition={["center", 160]}
				>
					<HyperCardSavedStacks
						onOpen={(stack, ref, providerId) => {
							dispatch({
								type: "ClassicyAppHyperCardOpenStack",
								stackId: `saved:${providerId}:${ref.id}`,
								stack,
							});
							setSavedStacksOpen(false);
						}}
					/>
				</ClassicyWindow>
			) : null}
```

- [ ] **Step 4: Run to verify pass** (`pnpm exec vitest run src/SystemFolder/HyperCard/`), then tsc + biome; commit:

```bash
git add src/SystemFolder/HyperCard/
git commit -m "feat(hypercard): save-provider registry, download provider, saved-stacks browser, provider-aware File menu"
```

---

### Task 9: Plan-1 review carry-forwards (a: core menuBar freshness; b: inert canvas; c: overlay key handling)

**Files:**
- Modify: `src/SystemFolder/SystemResources/Desktop/ClassicyDesktopWindowManagerContext.tsx` (new case)
- Modify: `src/SystemFolder/SystemResources/Window/ClassicyWindow.tsx` (record-refresh effect)
- Test: append to `src/SystemFolder/SystemResources/Desktop/` window-manager test file (locate the existing describe for window reducer cases with `grep -rl "ClassicyWindowMenu" src/SystemFolder/SystemResources/Desktop/*.test.*` — if none exists, create `ClassicyDesktopWindowManagerContext.menuBar.test.ts` with a minimal store harness modeled on `HyperCardEditorContext.test.ts`'s `makeStore`)
- Modify: `src/SystemFolder/HyperCard/HyperCardCard.tsx` + `HyperCardCard.editing.test.tsx` (inert)
- Modify: `src/SystemFolder/HyperCard/Editor/HyperCardEditorOverlay.tsx` + `HyperCardEditorCanvas.test.tsx` (keys)

**9a — core fix: stored window records never refresh their menuBar.** Root cause from Plan 1: `focusApp` copies the focused window's stored record `menuBar` (frozen at registration) into `Desktop.appMenu`. Fix at the source so every app benefits:

1. New window-manager case in `ClassicyDesktopWindowManagerContext.tsx` (beside `ClassicyWindowMenu`):

```ts
			case "ClassicyWindowSetMenuBar": {
				if (
					hasMenuBar(action) &&
					hasApp(action) &&
					typeof (action as { windowId?: unknown }).windowId === "string"
				) {
					const app =
						ds.System.Manager.Applications.apps[
							(action as { app: { id: string } }).app.id
						];
					const win = app?.windows?.find(
						(w) => w.id === (action as { windowId: string }).windowId,
					);
					if (win) win.menuBar = action.menuBar;
				}
				break;
			}
```

(Match the file's existing predicate style — reuse `hasMenuBar`/`hasApp` helpers; if `hasApp` asserts a different shape, follow what `ClassicyWindowClose` uses at `:210-215`.)

2. In `ClassicyWindow.tsx`, extend the existing focused-menu effect (`:355-362`) with a record refresh that runs on every `appMenu` identity change regardless of focus:

```ts
	useEffect(() => {
		if (!appMenu) return;
		desktopEventDispatch({
			type: "ClassicyWindowSetMenuBar",
			app: { id: appId },
			windowId: id,
			menuBar: appMenu,
		});
		if (ws.focused) {
			desktopEventDispatch({ type: "ClassicyWindowMenu", menuBar: appMenu });
		}
	}, [ws.focused, appMenu, appId, id, desktopEventDispatch]);
```

(This REPLACES the old effect body — same dependency array plus `appId`/`id`.)

3. Locking test (reducer-level): dispatch `ClassicyWindowSetMenuBar` at a store with one app/one window whose `menuBar` is `[]`; assert the record now holds the new menu; assert an unknown windowId is a no-op. Plus one regression run of the whole `SystemResources` suite.

4. Do NOT remove HyperCard's live-push effect (belt-and-suspenders, already tested).

**9b — inert editing canvas.** In `HyperCardCard.tsx`, add `{...(editing ? { inert: true } : {})}` alongside the existing `data-part-id` spread on the part wrapper div (the HTML `inert` attribute removes the subtree from tab order and input events — closes the Tab-into-a-field-dispatches-against-the-player hole). Test (append to `HyperCardCard.editing.test.tsx`):

```tsx
	it("marks editing part wrappers inert so they cannot take focus", () => {
		const { container } = render(
			<HyperCardCard open={makeOpen()} stackId={"demo"} editing />,
		);
		const wrapper = container.querySelector('[data-part-id="b1"]');
		expect(wrapper?.hasAttribute("inert")).toBe(true);
	});
```

(React 19 types accept `inert` as a boolean; if this repo's React 18 typings reject it, spread `{ inert: "" } as Record<string, unknown>` — disclose whichever form compiles.)

**9c — overlay key handling.** In `HyperCardEditorOverlay.tsx`'s `onKeyDown`: normalize once (`const key = e.key.toLowerCase();`) and use `key === "z"`, `key === "c"`, `key === "v"`; move the `meta && key === "v"` paste branch ABOVE the `if (!selected) return;` guard so keyboard paste works without a selection (matching the menu item). Tests (append to `HyperCardEditorCanvas.test.tsx`):

```tsx
	it("pastes with Cmd+V (uppercase key, no selection required)", () => {
		const { container } = render(
			<HyperCardEditorCanvas stackId={"demo"} edit={makeEdit()} />,
		);
		const surface = container.querySelector(
			".classicyHyperCardEditorOverlay",
		) as HTMLElement;
		fireEvent.keyDown(surface, { key: "V", metaKey: true });
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditPastePart",
			stackId: "demo",
		});
	});
```

- [ ] **Step 1:** write all three failing tests → run → FAIL.
- [ ] **Step 2:** implement 9a, 9b, 9c as above.
- [ ] **Step 3:** `pnpm exec vitest run src/SystemFolder/` (both HyperCard and SystemResources scopes) → ALL PASS; `pnpm exec tsc -b --noEmit`; biome on touched files.
- [ ] **Step 4:** commit:

```bash
git add src/SystemFolder/SystemResources/Desktop/ src/SystemFolder/SystemResources/Window/ src/SystemFolder/HyperCard/
git commit -m "fix(hypercard+core): window records refresh menuBar; inert editing canvas; overlay key normalization and paste gate"
```

---

### Task 10: Edit-mode window title + menu onClickFunc unit tests

**Files:**
- Modify: `src/SystemFolder/HyperCard/HyperCard.tsx` (title)
- Modify: `src/SystemFolder/HyperCard/HyperCard.editor.test.tsx` (title + menu tests)

**10a — title.** While `editingActive`, the main window title reflects the EDIT session's card (`edit.currentCardId` against `edit.draft`), not the player's:

```tsx
	const editCard = edit
		? edit.draft.cards.find((c) => c.id === edit.currentCardId)
		: undefined;
	const windowTitle = open
		? editingActive && edit
			? `${edit.draft.name}${editCard?.name ? ` — ${editCard.name}` : ""}${edit.dirty ? " •" : ""}`
			: `${open.stack.name}${currentCard?.name ? ` — ${currentCard.name}` : ""}${edit?.dirty ? " •" : ""}`
		: appName;
```

Test:

```tsx
	it("shows the edit session's card in the title while editing", () => {
		const e = makeEdit({ currentCardId: "c2", dirty: true });
		e.draft.cards.push({ id: "c2", name: "Second" });
		mockState = stateWith(e);
		const { container } = render(<HyperCard />);
		const win = container.querySelector('[data-window-id="hypercard_main"]');
		expect(win?.getAttribute("data-title")).toBe("Demo — Second •");
	});
```

**10b — menu dispatch tests.** The mocked `ClassicyWindow` already receives `appMenu`; capture it in a module-level record in the test file — declare `const capturedMenus: Record<string, unknown[]> = {};` above the `vi.mock` calls, and inside the mock component body add `capturedMenus[id] = (appMenu as unknown[]) ?? [];` before the return. Clear it in `beforeEach` (`for (const k of Object.keys(capturedMenus)) delete capturedMenus[k];`). Add a helper:

```tsx
function menuItem(menus: unknown[], topId: string, childId: string) {
	const top = (menus as { id: string; menuChildren?: { id: string; onClickFunc?: () => void }[] }[]).find(
		(m) => m.id === topId,
	);
	return top?.menuChildren?.find((c) => c.id === childId);
}
```

Tests — invoke each captured `onClickFunc` and assert its dispatch:

```tsx
	it("menu items dispatch the editor actions", () => {
		mockState = stateWith(makeEdit({ selectedPartId: "b1" }));
		render(<HyperCard />);
		const menus = capturedMenus.hypercard_main;
		menuItem(menus, "edit", "undo")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditUndo",
			stackId: "demo",
		});
		menuItem(menus, "edit", "copy_part")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditCopyPart",
			stackId: "demo",
			partId: "b1",
		});
		menuItem(menus, "objects", "new_card")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditAddCard",
			stackId: "demo",
		});
		menuItem(menus, "objects", "toggle_layer")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetLayer",
			stackId: "demo",
			layer: "background",
		});
		menuItem(menus, "file", "stop_editing")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditExit",
			stackId: "demo",
		});
		menuItem(menus, "edit", "edit_script")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditShowScript",
			stackId: "demo",
			target: { kind: "part", partId: "b1" },
		});
	});

	it("Go menu navigates the edit session while editing", () => {
		mockState = stateWith(makeEdit());
		render(<HyperCard />);
		menuItem(capturedMenus.hypercard_main, "go", "go_next")?.onClickFunc?.();
		expect(dispatch).toHaveBeenCalledWith({
			type: "ClassicyAppHCEditSetCard",
			stackId: "demo",
			to: "next",
		});
	});
```

- [ ] **Steps:** failing tests → implement title → all pass → full HyperCard suite + tsc + biome → commit `feat(hypercard): edit-mode window title; menu dispatch coverage`.

---

### Task 11: Full verification, browser pass, wrap-up

**Files:** none new.

- [ ] **Step 1: Full verification**

```bash
cd /home/robbiebyrd/classicy && pnpm test 2>&1 | tail -4 && pnpm build:source 2>&1 | tail -2
pnpm exec biome check src/SystemFolder/HyperCard/   # 0 errors expected (warnings ok)
git add src/index.ts && git commit -m "chore: regenerate barrel with editor stage-2 exports"   # if barrelsby changed it
```

- [ ] **Step 2: Browser pass** (controller-driven, `pnpm --filter classicy-example exec vite -d --force`, note the port — 5173-5175 are usually taken):

1. Open Feature Tour → Edit Stack → Inspector window shows card/stack sections; select the slider → schema fields (min/max/step) appear; change max to 10 → Browse → slider clamps to 10.
2. Rename a part id in the inspector; verify selection follows and duplicate ids are rejected.
3. Script…: builder lists onMouseUp actions of "Next: Logic" button; add a `beep` action; Browse → click button → beep + navigation. Reorder and delete actions; nested `if` renders its `then` list.
4. JSON tab: malformed JSON shows the error and does not apply; valid JSON applies.
5. File menu: "Save a Copy…" downloads with all edits; register nothing else — "Open Saved Stack…" absent (download has no `list`).
6. Variables table: add `lives=3`, Browse, confirm a `put`-reading script can read it (Feature Tour logic card).
7. Menus survive focus swaps between all four windows (main/tools/inspector/script) — the 9a core fix should make this true even without HyperCard's own push effect.
8. Reload mid-edit: session (draft/dirty/pristine + open script window target) restores.

- [ ] **Step 3: Fix anything surfaced** (failing test first where feasible), commit each fix.

- [ ] **Step 4: Hand off.** Branch `hypercard-editor` now contains the complete classicy side. Merging to `main` (and pushing = npm publish) is a HUMAN decision — present it at the end; Plan 3 (rt911: directus part schemas, setDateTime command meta, Directus save provider + `stacks` collection) needs the published package, or `pnpm use:local` for development.
