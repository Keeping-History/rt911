# HyperCard Stack Editor — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorming session)
**Repos:** `~/classicy` (bulk of the work — the editor itself) and `rt911` (extensions)

## Summary

Add a full WYSIWYG **edit mode to the existing HyperCard app** in classicy, so users can open, edit, and save HyperCard JSON stacks (`HCStack`) — dragging, dropping, resizing, and configuring every part type a stack supports, including rt911's plugin parts. Like real HyperCard, there is one app: a tools palette flips between Browse (the current player, scripts run) and editing tools. rt911's contribution is extension registration: editor metadata/option schemas for its 7 `directus*` plugin parts and `setDateTime` command, plus a Directus-backed save provider.

## Decisions made (with rationale)

1. **Edit mode inside `HyperCard.app`**, not a separate editor app — authentic to real HyperCard; one mental model; instant preview by switching to Browse. (Rejected: separate `StackEditor.app` — duplicate rendering; hybrid — weaker preview story.)
2. **Script editing is both a visual action builder and a raw JSON tab from day one** — students/teachers are first-class authors, power users get JSON. Both tabs are views over the same `HCAction[]`; no divergence possible.
3. **Save is a pluggable provider seam** in classicy with a built-in Download provider + localStorage draft autosave; rt911 registers a Directus provider. (Rejected: download-only — weak for students; ClassicyFileSystem write-back — requires building a writable-FS substrate; possible future work.)
4. **Plugin parts integrate fully**: registered parts appear in the editor palette and get schema-driven typed inspector forms. This defines the editor-extension API and is the bulk of rt911's work.
5. **Internal architecture is a sibling editor reducer** (`ClassicyAppHyperCardEdit*` event prefix), separate from the player's reducer, sharing the document type. The player's card renderer gains one `editing` prop (inert parts); an `EditorOverlay` layers selection/drag on top. (Rejected: extending the player reducer — couples editing to the interpreter state machine; component-local state — off-idiom for classicy.)

## Existing foundation (as of classicy 0.43.x)

- Player lives in `classicy:src/SystemFolder/HyperCard/` — JSON-driven, typed-action interpreter (not HyperTalk text), `validateStack()` in `HyperCardModel.ts`, plugin registries in `HyperCardPlugins.ts` (`registerHyperCardPart/Command/EffectHandler/Stack`), Finder `.stack` routing via `handlesFileTypes` + `data.openFiles`.
- Document model: `HCStack` → `backgrounds[]`/`cards[]` → `HCPart[]`; parts absolute-positioned by `rect: [x,y,w,h]` on a fixed canvas (default 512×342); event handlers are ordered `HCAction[]` (19 verbs incl. nested `if`/`repeat`).
- Built-in part types: `button, field, checkbox, radio, popup, slider, progress, label, image, group`.
- rt911 extension hub: `packages/frontend/src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts` (7 directus parts, `setDateTime` command, 4 registered stacks, `HyperCardClockBridge`).
- No editing or save code exists anywhere today.

## Architecture

### New classicy code — `src/SystemFolder/HyperCard/Editor/`

| File | Responsibility |
|---|---|
| `HyperCardEditorContext.tsx` | Sibling reducer, self-registered under `ClassicyAppHyperCardEdit`. Per-open-stack edit state: draft `HCStack`, selection (single part id), active tool, current card id, background-layer flag, undo/redo patch stacks, dirty flag. |
| `HyperCardEditorOverlay.tsx` | Selection border + 8 resize handles over the card canvas; drag-move, resize, arrow-key nudge (Shift = 8px), Delete, Cmd/Ctrl+C/V part copy/paste, Cmd/Ctrl+Z/Shift+Z undo/redo; drop target for palette drags; double-click → Inspector. |
| `HyperCardToolsPalette.tsx` | Floating always-on-top palette: Browse tool, Pointer tool, and the parts list (built-ins + plugin parts with editor metadata). Drag a part type onto the card to create it at the drop point with default `rect`/`options` (click-to-place also works). |
| `HyperCardInspector.tsx` | Context-sensitive palette window: part identity (`id` with uniqueness validation, `name`), numeric geometry synced live with drag, flags (`visible`/`locked`/`shared`), `style` dropdowns, `content`, and schema-driven `options` forms (raw-JSON fallback row when schemaless). Also card props (name, background), stack props (name, canvas size, `variables` key/value table). |
| `HyperCardScriptEditor.tsx` | Per-target (part/card/background/stack) script window with two tabs. **Builder** (default): handler list → ordered actions → typed per-verb forms; nested `if`/`repeat` as collapsible blocks; drag reorder; "+ Add action" lists all verbs + registered plugin commands. **JSON**: monospace editor over the same handlers; Apply gated on parse + action-schema validation with inline errors. |
| `HyperCardEditorSave.ts` | Save orchestration: `validateStack()` + editor lints, provider dispatch, download implementation, localStorage draft autosave (debounced, keyed per stack id) + restore prompt. |

### Changes to existing classicy files

- `HyperCardCard.tsx`: accept `editing?: boolean` — render parts inert (no interpreter dispatch, no field commits). Only player change of substance.
- `HyperCard.tsx`: mount editor windows/palettes; edit-mode menus (File: New Stack / Save / Save To ▸ / Export `.stack.json…` / Open Saved Stack…; Objects/Card menus: New Card, Delete Card, reorder, assign background, New Background, Stack Info; background-layer toggle).
- `HyperCardPlugins.ts`: extend part registration with editor metadata `{ label, paletteIcon?, optionsSchema? }`; add command editor metadata (builder form fields); add the **save-provider registry**:

```ts
interface HyperCardSaveProvider {
  id: string
  label: string
  canSave(): boolean
  save(stack: HCStack, meta: { stackId: string; fileName?: string }): Promise<HCSaveResult>
  list?(): Promise<HCSavedStackRef[]>   // optional: enables File → Open Saved Stack…
  load?(ref: HCSavedStackRef): Promise<HCStack>
}
```

- `src/index.ts` barrels re-export the new types/registries (barrelsby-generated — do not hand-edit).

### Data flow

1. Entering edit mode (choosing any non-Browse tool) deep-copies the open `HCStack` into the editor reducer's draft.
2. Every edit is an Immer `produceWithPatches` mutation; inverse patches feed the undo stack (no full-document snapshots — matters for 130KB stacks like Oregon Trail).
3. Switching to Browse dispatches the draft to the player (`ClassicyAppHyperCardOpenStack`) for instant live preview; switching back resumes the draft.
4. Save = `validateStack()` + lints → active provider (`save`) → clear dirty. Export always available via the Download provider.
5. Edits mutate the parsed JSON object in place, so fields the editor doesn't model **survive round-trip untouched**; unknown part types render as the player's "missing part" placeholder but remain selectable/movable — never destroyed.

### rt911 extensions (`packages/frontend/src/Applications/HyperCard/`)

- Editor metadata + `optionsSchema` for the 7 `directus*` parts (e.g. `channelId`: number, `start`: datetime, `autoPlay`: checkbox) and for the `setDateTime` command (datetime field in the builder).
- **Directus save provider**: new `stacks` collection (`name`, `definition` json field — **must** have the `cast-json` special, per the known Directus gotcha — `user_created`, timestamps), permissions: authenticated users CRUD their own rows. `stackApi.ts` mirrors `playlistApi.ts` (typed `AuthRequiredError`/`ForbiddenError`); `DirectusStackSaveProvider` implements `save`/`list`/`load` with `canSave()` from the auth session.
- All registered in `registerHyperCardExtensions.ts` (existing StrictMode/HMR double-invoke guard applies).

## Error handling

- **Save validation:** `validateStack()` errors block; editor lints (duplicate part ids, dangling `background` refs, `go` targets matching no card) are **warnings**, not blockers — name-based `go` targets are legal.
- **JSON tab:** parse/schema errors inline; Apply and tab-switch disabled until valid.
- **Save failure** (network/401): error dialog with retry; localStorage draft autosave guarantees no lost work; restore prompt on reopen.
- **Schemaless plugin parts:** options edited as raw JSON; still placeable/movable.

## Scope

**In v1:** all of the above.
**Deliberately out (follow-ups):** multi-select/marquee (v1 is single-selection), ClassicyFileSystem write-back ("files appear in Finder"), image-asset upload (image parts reference URLs only), stack-level HyperTalk text scripting (the model is typed actions by design).

## Testing

- **classicy (vitest, co-located):** editor reducer units (create/move/resize/delete/copy-paste, undo/redo patch symmetry); round-trip (`features.stack.json` → edits → serialize → `validateStack` ok, unknown fields preserved); builder ⇄ JSON sync; overlay interactions via RTL pointer events.
- **rt911 (vitest):** schema-registration tests; `stackApi` with mocked fetch; new test files need `afterEach(cleanup)` (no RTL auto-cleanup in this repo).
- **Manual:** classicy `pnpm preview` example app for the editor; rt911 `pnpm use:local` to verify plugin-part inspectors and the Directus provider end-to-end.

## Shipping order

1. Classicy: editor reducer + canvas overlay + palette (parts placeable/movable, undo/redo, download save).
2. Classicy: inspector + script editor (builder + JSON) + save-provider registry + autosave. Publish (push to classicy main → CI auto-publishes; rt911 pins `latest`).
3. rt911: part/command schemas + Directus `stacks` collection + `stackApi.ts` + save provider.
