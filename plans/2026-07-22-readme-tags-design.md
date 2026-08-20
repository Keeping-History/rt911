# README tags — pills + tag filter

**Date:** 2026-07-22
**App:** `packages/frontend/src/Applications/README`
**Status:** Design approved; ready for implementation plan.

## Goal

Give README articles author-assigned **tags**. Show each article's tags as
visual pill badges under the headline in **both** the list view and the reading
pane. Add a **File → Settings…** window whose checkboxes let a reader choose
which tags to show, filtering the article list.

## Decisions (locked)

| Question | Decision |
|---|---|
| Directus modelling | **Many-to-many** `readme_tags` collection + junction, deep-selected in REST |
| Filter semantics | **List filter, OR** — an article shows if it's untagged **or** carries ≥1 checked tag |
| Tag universe | **Derived dynamically** from tags present in the loaded feed; default all-checked |
| Pills vs filter | List pills always render **all** of an article's tags; the checkbox is a content filter, not a pill-visibility toggle |
| Filter key | Tag **id** (rename-safe), not name |
| Persistence | Persisted via a registered app reducer (`registerAppEventHandler`) + localStorage, mirroring `RadioScannerContext.ts` + `radioScannerSettings.ts` |

## Architecture

The README app already separates concerns cleanly, so this feature slots into
the existing seams:

- `useReadmeArticles.ts` — the direct-REST data hook + pure list helpers.
- `ReadmeContent.tsx` — pure two-pane presentation (list left, body right).
- `README.tsx` — the `ClassicyApp`/`ClassicyWindow` shell, menus, settings.

New units are small and independently testable, following the RadioScanner
settings precedent (`radioScannerSettings.ts` + `RadioScannerContext.ts` + a
draft-form settings window).

### A. Directus schema (provisioned on Directus, not in this repo)

- **`readme_tags`** collection:
  - `id` — auto-increment PK.
  - `name` — string, required.
  - `color` — string, nullable. A hex string (e.g. `#cc3333`) used as the pill
    background; nullable so an author can leave it to a theme default.
  - `sort` — int, nullable (manual display order; optional).
  - **Public read** policy (Directus 12 policy-based perms), same as
    `readme_articles`.
- **`readme_articles_tags`** junction collection:
  - `id` — PK.
  - `readme_articles_id` — m2o → `readme_articles`.
  - `readme_tags_id` — m2o → `readme_tags`.
  - **Public read** policy.
- **`tags`** M2M field added to `readme_articles` (alias field over the junction).
- Seed a handful of starter tags so the feature is visible on first load.

Provisioning uses the established schema-ops path (port-forward + static admin
token; CF blocks `POST /auth/login`). An M2M is a multi-step create
(collections → fields → relations → perms) rather than a single scalar field.

### B. Data layer — `useReadmeArticles.ts`

```ts
export interface ReadmeTag {
  id:    number;
  name:  string;
  color: string | null;
}

export interface ReadmeArticle {
  // …existing fields…
  tags: ReadmeTag[];
}
```

- Extend `ARTICLES_URL` `&fields=` with the deep junction path:
  `tags.readme_tags_id.id,tags.readme_tags_id.name,tags.readme_tags_id.color`.
- In `fetchList`, **flatten** the nested junction rows
  (`{ readme_tags_id: {...} }[]`) into a clean `ReadmeTag[]`, dropping any null
  join rows, before storing in state. Everything downstream sees flat tags.
- Two new pure, exported helpers (unit-testable like `sortArticles`):
  - `allTags(articles: ReadmeArticle[]): ReadmeTag[]` — union of every
    article's tags, deduped by `id`, sorted by `name`. This is the Settings
    checkbox universe.
  - `visibleArticles(articles: ReadmeArticle[], hiddenTagIds: number[]): ReadmeArticle[]`
    — keep an article when `tags.length === 0` **or** it has ≥1 tag whose `id`
    is not in `hiddenTagIds`.
- **Probe query unchanged.** `count` + `max(date_updated)` still catches tag
  *membership* changes (saving an article's M2M bumps its `date_updated`). Known
  blind spot: renaming/recoloring a tag with no article edit lags until the next
  article save — the same self-healing tolerance already documented in the file.

### C. Persisted settings — `readmeSettings.ts` + `ReadmeContext.ts` (new)

`readmeSettings.ts` (mirrors `radioScannerSettings.ts`):

```ts
export interface ReadmeSettings {
  hiddenTagIds: number[];   // tag ids the reader has unchecked
}

export const DEFAULT_README_SETTINGS: ReadmeSettings = { hiddenTagIds: [] };

export const readReadmeSettings = (
  data: Record<string, unknown> | undefined,
): ReadmeSettings => { /* per-field validation: array of ints, fallback [] */ };

export const readmeSetSettings = (settings: ReadmeSettings): ActionMessage => ({
  type: "ClassicyAppReadmeSetSettings",
  settings,
});
```

Persistence requires a **registered app reducer**, not just a dispatch. A new
`ReadmeContext.ts` defines a handler that writes `action.settings` into
`apps["Readme.app"].data.settings`, and registers it with
`registerAppEventHandler("ClassicyAppReadme", handler)`. `README.tsx` imports
`"./ReadmeContext"` for its side effect (the exact pattern in
`RadioScannerContext.ts`). Classicy's top-level reducer routes any action whose
type starts with `ClassicyAppReadme` to this handler; the resulting store is
localStorage-backed, so settings survive reloads.

### D. Pills — `TagPills.tsx` (new) + SCSS

- Props: `{ tags: ReadmeTag[] }`. Renders a row of rounded pill `<span>`s;
  renders nothing when `tags` is empty.
- Each pill's background is the tag's `color` (fallback to a theme var when
  null/invalid). Text color is chosen by a small **luminance-contrast** helper
  (black on light backgrounds, white on dark) so any author-chosen color stays
  readable in both light and dark themes.
- Pill styles added to `README.module.scss` (small, rounded, theme fonts).

### E. Presentation — `ReadmeContent.tsx`

- New prop `hiddenTagIds: number[]` (default `[]`, so existing tests and any
  caller without settings keep working).
- Filter the rendered list through `visibleArticles(articles, hiddenTagIds)`.
- Render `<TagPills tags={a.tags} />` in **two** places: under each list row's
  byline, and under the headline in the reading pane. Pills always show *all* of
  an article's tags.
- The selected-article fallback recomputes against the *visible* list, so
  filtering out the currently-selected article falls back to the newest visible
  one instead of a blank pane.

### F. App wiring — `README.tsx`

- `import "./ReadmeContext";` for the reducer registration side effect.
- Read persisted settings: `useAppManager(s => s...apps["Readme.app"]?.data)` →
  `readReadmeSettings(...)`, memoized.
- Add **`Settings…`** to the File menu (before Quit), `onClickFunc: openSettings`.
- Draft-form settings state (RadioScanner pattern): `showSettings` boolean +
  `settingsForm` seeded from persisted settings on open, dispatched via
  `readmeSetSettings` only on Save.
- A settings `ClassicyWindow` (`id="Readme.app_settings"`) renders one
  `ClassicyCheckbox` per `allTags(articles)`; **checked = id not in
  `hiddenTagIds`**. Toggling adds/removes the id from the draft. Save/Cancel
  buttons. On save, prune `hiddenTagIds` to the current tag universe so ids for
  deleted tags don't accumulate.
- Pass `hiddenTagIds` from persisted settings into `<ReadmeContent>`.

### G. Tests

- Unit: `allTags` (dedup/sort), `visibleArticles` (OR filter, untagged always
  kept, all-hidden edge), `readReadmeSettings` (default/partial/invalid),
  `ReadmeContext` reducer (writes settings, ignores foreign actions).
- Component: `TagPills` (colors, contrast, empty), `ReadmeContent` (filtering +
  pills in both panes, selection fallback), README settings window (open →
  toggle → save dispatch).
- Update existing README fixtures with `tags: []`.
- Per the frontend testing note, new test files need explicit
  `afterEach(cleanup)` (no RTL auto-cleanup in this vitest setup).

## Edge cases & behavior

- **Untagged articles are never filtered out** — a feed of untagged posts can't
  be emptied by the filter.
- **All tags unchecked** → only untagged articles show. Deliberate; allowed.
- **Null/invalid tag color** → theme-default pill background.
- **Stale hidden ids** (tag removed from feed) sit harmlessly in storage and are
  pruned on the next Save.

## Out of scope

- Editing tags from the frontend (tags are authored in Directus).
- Per-tag colors beyond a single background hex.
- Server-side filtering (the feed is small; filtering is client-side).
- Extending the probe to catch standalone tag renames (documented blind spot).
