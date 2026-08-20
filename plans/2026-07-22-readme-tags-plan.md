# README Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give README articles author-assigned tags shown as pill badges (list + reading pane), with a File → Settings… window whose checkboxes filter which tags' articles appear.

**Architecture:** A new M2M `readme_tags` collection in Directus, deep-selected and flattened in the existing `useReadmeArticles` REST hook. Pure helpers (`allTags`, `visibleArticles`) drive a presentational `TagPills` component and a persisted, reducer-backed settings filter — the exact `radioScannerSettings.ts` + `RadioScannerContext.ts` pattern.

**Tech Stack:** Vite + React + TypeScript, classicy component library, Vitest + Testing Library, Directus 12 (Postgres), pnpm 10 / Node 25 (mise).

## Global Constraints

- **Indentation is tabs** — match every existing file in `src/Applications/README/`.
- **New test files MUST include `afterEach(cleanup)`** — this vitest setup has no RTL auto-cleanup (see `ReadmeContent.test.tsx`).
- **App action prefix is `ClassicyAppReadme`** (appId `Readme.app`). classicy's reducer routes any action whose `type` starts with a registered prefix to that app's handler.
- **classicy is pinned `"latest"` and auto-bumped by `.husky/pre-commit`** — never hand-edit its version; an unrelated version bump in the diff is expected. `mise trust` has already been run for this worktree.
- **Directus ordering:** the schema in Task 7 must exist on whatever Directus instance the frontend queries **before** the `fields=tags.readme_tags_id.*` request runs against it (local dev pointed at api-beta, or a production deploy) — otherwise Directus returns HTTP 400 and the whole README feed fails to load. Unit tests mock `fetch`, so Tasks 1–6 do not depend on Task 7.
- **Run one frontend test file:** `pnpm --filter @rt911/frontend exec vitest run <path>` (from repo root).
- **Directory:** all frontend paths below are under `packages/frontend/`.

---

### Task 1: Data layer — tag types, deep-select, and pure filter helpers

**Files:**
- Modify: `packages/frontend/src/Applications/README/useReadmeArticles.ts`
- Test: `packages/frontend/src/Applications/README/useReadmeArticles.test.ts`

**Interfaces:**
- Produces:
  - `interface ReadmeTag { id: number; name: string; color: string | null }`
  - `ReadmeArticle` gains `tags: ReadmeTag[]`
  - `flattenTags(raw: unknown): ReadmeTag[]`
  - `allTags(articles: ReadmeArticle[]): ReadmeTag[]`
  - `visibleArticles(articles: ReadmeArticle[], hiddenTagIds: number[]): ReadmeArticle[]`

- [ ] **Step 1: Write the failing tests**

Add these describe blocks to the end of `useReadmeArticles.test.ts`, and import the new symbols. Update the top **type** import (line 3) to add `ReadmeTag`:

```ts
import type { ReadmeArticle, ReadmeTag } from "./useReadmeArticles";
```

and update the value import to:

```ts
import {
	ARTICLES_URL,
	allTags,
	flattenTags,
	PROBE_URL,
	REFRESH_INTERVAL_MS,
	sortArticles,
	useReadmeArticles,
	visibleArticles,
} from "./useReadmeArticles";
```

Append:

```ts
describe("flattenTags", () => {
	it("maps Directus M2M junction rows to flat tags", () => {
		const raw = [
			{ readme_tags_id: { id: 1, name: "Media", color: "#cc3333" } },
			{ readme_tags_id: { id: 2, name: "Bugfix", color: null } },
		];
		expect(flattenTags(raw)).toEqual([
			{ id: 1, name: "Media", color: "#cc3333" },
			{ id: 2, name: "Bugfix", color: null },
		]);
	});

	it("drops null join rows and returns [] for non-arrays", () => {
		expect(flattenTags([{ readme_tags_id: null }, null])).toEqual([]);
		expect(flattenTags(undefined)).toEqual([]);
		expect(flattenTags("nope")).toEqual([]);
	});

	it("defaults a missing color to null", () => {
		expect(flattenTags([{ readme_tags_id: { id: 3, name: "News" } }])).toEqual([
			{ id: 3, name: "News", color: null },
		]);
	});
});

describe("allTags", () => {
	const mk = (id: number, tags: ReadmeTag[]): ReadmeArticle => ({
		id, headline: `A${id}`, author: null, date_created: "2026-01-01T00:00:00",
		date_updated: null, body: "", sort: null, featured: false, tags,
	});

	it("returns the deduped union of tags, sorted by name", () => {
		const out = allTags([
			mk(1, [{ id: 2, name: "Media", color: null }, { id: 1, name: "Announcement", color: null }]),
			mk(2, [{ id: 2, name: "Media", color: null }]),
		]);
		expect(out.map((t) => t.name)).toEqual(["Announcement", "Media"]);
	});

	it("returns [] when no article has tags", () => {
		expect(allTags([mk(1, [])])).toEqual([]);
	});
});

describe("visibleArticles", () => {
	const mk = (id: number, tags: ReadmeTag[]): ReadmeArticle => ({
		id, headline: `A${id}`, author: null, date_created: "2026-01-01T00:00:00",
		date_updated: null, body: "", sort: null, featured: false, tags,
	});
	const A = mk(1, [{ id: 10, name: "Announcement", color: null }]);
	const B = mk(2, [
		{ id: 20, name: "Media", color: null },
		{ id: 30, name: "Bugfix", color: null },
	]);
	const C = mk(3, []); // untagged

	it("returns all articles unchanged when nothing is hidden", () => {
		expect(visibleArticles([A, B, C], [])).toEqual([A, B, C]);
	});

	it("hides an article only when ALL its tags are hidden (OR semantics)", () => {
		// hide Announcement(10) + Media(20): A gone, B stays (has Bugfix 30), C stays (untagged)
		expect(visibleArticles([A, B, C], [10, 20])).toEqual([B, C]);
	});

	it("never hides untagged articles even when everything is hidden", () => {
		expect(visibleArticles([A, B, C], [10, 20, 30])).toEqual([C]);
	});
});
```

Then update the **existing** fixtures so normalization (which adds `tags: []`)
does not break `toEqual`. In `useReadmeArticles.test.ts`:
- Add `tags: [],` to every object in the top-level `ARTICLES` array (both entries).
- Add `tags: [],` to the object in the `updated` array (inside the "refetches…" test).
- In the `sortArticles` describe's `mk` helper, add `tags: []` to the defaults:
  ```ts
  const mk = (o: Partial<ReadmeArticle> & { id: number }): ReadmeArticle => ({
  	headline: `A${o.id}`, author: null, date_created: "2026-01-01T00:00:00",
  	date_updated: null, body: "", sort: null, featured: false, tags: [], ...o,
  });
  ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/useReadmeArticles.test.ts`
Expected: FAIL — `flattenTags`/`allTags`/`visibleArticles` are not exported; existing fixture tests fail on the missing `tags` key.

- [ ] **Step 3: Implement the data-layer changes**

In `useReadmeArticles.ts`:

Add the tag type above `ReadmeArticle` and the `tags` field to the interface:

```ts
export interface ReadmeTag {
	id:    number;
	name:  string;
	color: string | null;
}
```

Inside `ReadmeArticle`, add as the last field (after `featured`):

```ts
	// Author-assigned tags (M2M). Drives the pill badges and the tag filter.
	tags: ReadmeTag[];
```

Extend the `&fields=` list in `ARTICLES_URL` — change the field clause to include the deep junction path:

```ts
export const ARTICLES_URL =
	`${DIRECTUS_URL}/items/readme_articles` +
	"?filter[status][_eq]=published&sort=-date_created" +
	"&fields=id,headline,author,date_created,date_updated,body,sort,featured," +
	"tags.readme_tags_id.id,tags.readme_tags_id.name,tags.readme_tags_id.color" +
	"&limit=-1";
```

Add the flatten + normalize helpers (place `flattenTags` and the raw type near the top, after the interfaces; `normalizeArticle` can sit just above `useReadmeArticles`):

```ts
// Directus returns M2M rows nested under the junction key; flatten to ReadmeTag[].
interface RawTagJoin {
	readme_tags_id?: Partial<ReadmeTag> | null;
}

export function flattenTags(raw: unknown): ReadmeTag[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((j) => (j as RawTagJoin)?.readme_tags_id)
		.filter(
			(t): t is Partial<ReadmeTag> =>
				!!t && typeof t.id === "number" && typeof t.name === "string",
		)
		.map((t) => ({ id: t.id as number, name: t.name as string, color: t.color ?? null }));
}

// The raw wire article has `tags` in nested junction shape; normalize to flat.
type RawReadmeArticle = Omit<ReadmeArticle, "tags"> & { tags?: unknown };

function normalizeArticle(raw: RawReadmeArticle): ReadmeArticle {
	return { ...raw, tags: flattenTags(raw.tags) };
}
```

Add the two pure filter helpers next to `sortArticles`:

```ts
// The Settings checkbox universe: every distinct tag across the feed, name-sorted.
export function allTags(articles: ReadmeArticle[]): ReadmeTag[] {
	const byId = new Map<number, ReadmeTag>();
	for (const a of articles) {
		for (const t of a.tags) if (!byId.has(t.id)) byId.set(t.id, t);
	}
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// OR filter: keep an article if it is untagged, or has ≥1 non-hidden tag.
export function visibleArticles(
	articles: ReadmeArticle[],
	hiddenTagIds: number[],
): ReadmeArticle[] {
	if (hiddenTagIds.length === 0) return articles;
	const hidden = new Set(hiddenTagIds);
	return articles.filter(
		(a) => a.tags.length === 0 || a.tags.some((t) => !hidden.has(t.id)),
	);
}
```

In `fetchList`, normalize the wire data before sorting:

```ts
const fetchList = async () => {
	const res = await fetch(ARTICLES_URL, { signal: controller.signal });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = (await res.json()) as { data: RawReadmeArticle[] };
	loaded = true;
	setState({
		articles: sortArticles(json.data.map(normalizeArticle)),
		loading: false,
		error: null,
	});
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/useReadmeArticles.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/useReadmeArticles.ts packages/frontend/src/Applications/README/useReadmeArticles.test.ts
git commit -m "feat(readme): tag types, deep-select tags, allTags/visibleArticles helpers"
```

---

### Task 2: Persisted settings module

**Files:**
- Create: `packages/frontend/src/Applications/README/readmeSettings.ts`
- Test: `packages/frontend/src/Applications/README/readmeSettings.test.ts`

**Interfaces:**
- Produces:
  - `interface ReadmeSettings { hiddenTagIds: number[] }`
  - `DEFAULT_README_SETTINGS: ReadmeSettings`
  - `readReadmeSettings(data: Record<string, unknown> | undefined): ReadmeSettings`
  - `readmeSetSettings(settings: ReadmeSettings): ActionMessage` — `{ type: "ClassicyAppReadmeSetSettings", settings }`

- [ ] **Step 1: Write the failing test**

Create `readmeSettings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	DEFAULT_README_SETTINGS,
	readmeSetSettings,
	readReadmeSettings,
} from "./readmeSettings";

describe("readReadmeSettings", () => {
	it("falls back to defaults for absent data", () => {
		expect(readReadmeSettings(undefined)).toEqual(DEFAULT_README_SETTINGS);
		expect(readReadmeSettings({})).toEqual({ hiddenTagIds: [] });
	});

	it("reads a valid hiddenTagIds array", () => {
		expect(readReadmeSettings({ settings: { hiddenTagIds: [1, 2] } })).toEqual({
			hiddenTagIds: [1, 2],
		});
	});

	it("rejects a non-array or non-integer hiddenTagIds", () => {
		expect(readReadmeSettings({ settings: { hiddenTagIds: "x" } })).toEqual({ hiddenTagIds: [] });
		expect(readReadmeSettings({ settings: { hiddenTagIds: [1, "2", 3.5] } })).toEqual({ hiddenTagIds: [] });
	});
});

describe("readmeSetSettings", () => {
	it("builds the persist action", () => {
		expect(readmeSetSettings({ hiddenTagIds: [7] })).toEqual({
			type: "ClassicyAppReadmeSetSettings",
			settings: { hiddenTagIds: [7] },
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/readmeSettings.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `readmeSettings.ts`:

```ts
import type { ActionMessage } from "classicy";

// Reader preferences for the README app. Ephemeral UI (the open settings window,
// the draft form) is NOT persisted; only the tag filter is — same split as
// radioScannerSettings.ts.
export interface ReadmeSettings {
	/** Tag ids the reader has unchecked (hidden). Empty = show everything. */
	hiddenTagIds: number[];
}

export const DEFAULT_README_SETTINGS: ReadmeSettings = { hiddenTagIds: [] };

/** Persist the whole settings object in one dispatch. */
export const readmeSetSettings = (settings: ReadmeSettings): ActionMessage => ({
	type: "ClassicyAppReadmeSetSettings",
	settings,
});

const isTagIdArray = (v: unknown): v is number[] =>
	Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isInteger(n));

// Stored state comes from localStorage, so a hand-edited or stale value could be
// anything; fall back to defaults on any invalid field.
export const readReadmeSettings = (
	data: Record<string, unknown> | undefined,
): ReadmeSettings => {
	const stored = (data?.settings as Partial<ReadmeSettings> | undefined) ?? {};
	return {
		hiddenTagIds: isTagIdArray(stored.hiddenTagIds)
			? stored.hiddenTagIds
			: DEFAULT_README_SETTINGS.hiddenTagIds,
	};
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/readmeSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/readmeSettings.ts packages/frontend/src/Applications/README/readmeSettings.test.ts
git commit -m "feat(readme): persisted tag-filter settings module"
```

---

### Task 3: Settings reducer + registration (ReadmeContext)

**Files:**
- Create: `packages/frontend/src/Applications/README/ReadmeContext.ts`
- Test: `packages/frontend/src/Applications/README/ReadmeContext.test.ts`

**Interfaces:**
- Consumes: `ReadmeSettings` (Task 2).
- Produces: `classicyReadmeEventHandler(ds: ClassicyStore, action: ActionMessage): ClassicyStore`, registered under prefix `"ClassicyAppReadme"` on import.

- [ ] **Step 1: Write the failing test**

Create `ReadmeContext.test.ts`:

```ts
import type { ActionMessage, ClassicyStore } from "classicy";
import { describe, expect, it } from "vitest";
import { classicyReadmeEventHandler } from "./ReadmeContext";

// A minimal store shaped like the slice the handler touches.
function storeWith(data: Record<string, unknown> | undefined): ClassicyStore {
	return {
		System: {
			Manager: { Applications: { apps: { "Readme.app": { data } } } },
		},
	} as unknown as ClassicyStore;
}

describe("classicyReadmeEventHandler", () => {
	it("writes settings into the Readme.app data slice", () => {
		const ds = storeWith({ existing: true });
		const action = {
			type: "ClassicyAppReadmeSetSettings",
			settings: { hiddenTagIds: [5] },
		} as unknown as ActionMessage;
		const out = classicyReadmeEventHandler(ds, action);
		const data = out.System.Manager.Applications.apps["Readme.app"].data;
		expect(data).toEqual({ existing: true, settings: { hiddenTagIds: [5] } });
	});

	it("ignores actions it does not own", () => {
		const ds = storeWith({ settings: { hiddenTagIds: [] } });
		const out = classicyReadmeEventHandler(ds, { type: "SomethingElse" } as ActionMessage);
		expect(out.System.Manager.Applications.apps["Readme.app"].data).toEqual({
			settings: { hiddenTagIds: [] },
		});
	});

	it("no-ops when the app is not mounted", () => {
		const ds = { System: { Manager: { Applications: { apps: {} } } } } as unknown as ClassicyStore;
		expect(() =>
			classicyReadmeEventHandler(ds, {
				type: "ClassicyAppReadmeSetSettings",
				settings: { hiddenTagIds: [1] },
			} as unknown as ActionMessage),
		).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContext.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `ReadmeContext.ts` (mirrors `RadioScannerContext.ts`):

```ts
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";
import type { ReadmeSettings } from "./readmeSettings";

const appId = "Readme.app";

// Persists the reader's tag-filter settings into the app's data slice. classicy
// routes any action whose type starts with "ClassicyAppReadme" here (registered
// below), and the resulting store is localStorage-backed.
export const classicyReadmeEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	const app = ds.System.Manager.Applications.apps[appId];
	if (!app) return ds;
	const appData = app.data ?? {};

	switch (action.type) {
		case "ClassicyAppReadmeSetSettings":
			app.data = {
				...appData,
				settings: action.settings as ReadmeSettings,
			};
			return ds;
		default:
			return ds;
	}
};

registerAppEventHandler("ClassicyAppReadme", classicyReadmeEventHandler);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/ReadmeContext.ts packages/frontend/src/Applications/README/ReadmeContext.test.ts
git commit -m "feat(readme): register settings reducer for tag-filter persistence"
```

---

### Task 4: TagPills component + color helpers + styles

**Files:**
- Create: `packages/frontend/src/Applications/README/TagPills.tsx`
- Test: `packages/frontend/src/Applications/README/TagPills.test.tsx`
- Modify: `packages/frontend/src/Applications/README/README.module.scss`

**Interfaces:**
- Consumes: `ReadmeTag` (Task 1).
- Produces:
  - `parseHex(hex: string | null): [number, number, number] | null`
  - `pillColors(hex: string | null): { background: string; text: string }`
  - `TagPills: React.FC<{ tags: ReadmeTag[] }>`

- [ ] **Step 1: Write the failing test**

Create `TagPills.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseHex, pillColors, TagPills } from "./TagPills";
import type { ReadmeTag } from "./useReadmeArticles";

afterEach(cleanup);

describe("parseHex", () => {
	it("parses #rrggbb and #rgb", () => {
		expect(parseHex("#ff0000")).toEqual([255, 0, 0]);
		expect(parseHex("#0f0")).toEqual([0, 255, 0]);
		expect(parseHex("  #00FF00 ")).toEqual([0, 255, 0]);
	});
	it("returns null for invalid input", () => {
		expect(parseHex(null)).toBeNull();
		expect(parseHex("red")).toBeNull();
		expect(parseHex("#12")).toBeNull();
	});
});

describe("pillColors", () => {
	it("uses black text on a light background", () => {
		expect(pillColors("#ffff00").text).toBe("#000000");
	});
	it("uses white text on a dark background", () => {
		expect(pillColors("#000080").text).toBe("#ffffff");
	});
	it("falls back to theme vars when there is no valid color", () => {
		expect(pillColors(null)).toEqual({
			background: "var(--color-theme-05)",
			text: "var(--color-theme-06)",
		});
	});
});

describe("TagPills", () => {
	const tags: ReadmeTag[] = [
		{ id: 1, name: "Announcement", color: "#cc3333" },
		{ id: 2, name: "Bugfix", color: null },
	];

	it("renders a pill per tag", () => {
		render(<TagPills tags={tags} />);
		expect(screen.getByText("Announcement")).toBeDefined();
		expect(screen.getByText("Bugfix")).toBeDefined();
	});

	it("renders nothing for an empty tag list", () => {
		const { container } = render(<TagPills tags={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/TagPills.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `TagPills.tsx`:

```tsx
import type React from "react";
import readmeStyles from "./README.module.scss";
import type { ReadmeTag } from "./useReadmeArticles";

// Parse "#rgb" or "#rrggbb" into [r,g,b] (0..255), or null if not a valid hex.
export function parseHex(hex: string | null): [number, number, number] | null {
	if (typeof hex !== "string") return null;
	const h = hex.trim().replace(/^#/, "");
	const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16),
	];
}

// Pill background + a black/white text color chosen for contrast against it.
// Falls back to theme vars (already a readable pairing) when the tag has no
// valid color, so author colors stay legible in both light and dark themes.
export function pillColors(hex: string | null): { background: string; text: string } {
	const rgb = parseHex(hex);
	if (!rgb) return { background: "var(--color-theme-05)", text: "var(--color-theme-06)" };
	const [r, g, b] = rgb;
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return {
		background: `rgb(${r}, ${g}, ${b})`,
		text: luminance > 0.6 ? "#000000" : "#ffffff",
	};
}

// A row of tag pills. Renders nothing when there are no tags.
export const TagPills: React.FC<{ tags: ReadmeTag[] }> = ({ tags }) => {
	if (tags.length === 0) return null;
	return (
		<span className={readmeStyles.pills}>
			{tags.map((t) => {
				const { background, text } = pillColors(t.color);
				return (
					<span
						key={t.id}
						className={readmeStyles.pill}
						style={{ backgroundColor: background, color: text }}
					>
						{t.name}
					</span>
				);
			})}
		</span>
	);
};
```

Append pill styles to `README.module.scss`:

```scss
.pills {
	display: flex;
	flex-wrap: wrap;
	gap: calc(var(--windows-border-size) * 2);
	margin-top: calc(var(--windows-border-size) * 2);
}

.pill {
	display: inline-block;
	padding: 1px 6px;
	border-radius: 8px;
	font-family: var(--ui-font);
	font-size: calc(var(--ui-font-size) * 0.85);
	line-height: 1.4;
	white-space: nowrap;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/TagPills.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/TagPills.tsx packages/frontend/src/Applications/README/TagPills.test.tsx packages/frontend/src/Applications/README/README.module.scss
git commit -m "feat(readme): TagPills component with contrast-aware colors"
```

---

### Task 5: Render pills + filter in ReadmeContent

**Files:**
- Modify: `packages/frontend/src/Applications/README/ReadmeContent.tsx`
- Test: `packages/frontend/src/Applications/README/ReadmeContent.test.tsx`

**Interfaces:**
- Consumes: `visibleArticles` (Task 1), `TagPills` (Task 4).
- Produces: `ReadmeContent` gains an optional `hiddenTagIds?: number[]` prop (default `[]`).

- [ ] **Step 1: Write the failing tests**

First, update **existing** `ReadmeContent.test.tsx` fixtures so they compile with
the new required `tags` field: add `tags: [],` to every object in the top-level
`ARTICLES` array, the `mixed` array, and the `evil` object.

Then append a new describe block, and update the imports at the top to include the tag type:

```tsx
import type { ReadmeArticle, ReadmeArticlesState, ReadmeTag } from "./useReadmeArticles";
```

Append:

```tsx
describe("ReadmeContent tags", () => {
	const TAG_MEDIA: ReadmeTag = { id: 20, name: "Media", color: "#3366cc" };
	const TAG_BUG: ReadmeTag = { id: 30, name: "Bugfix", color: null };

	const TAGGED: ReadmeArticle[] = [
		{
			id: 1, headline: "Tagged post", author: null,
			date_created: "2026-07-16T12:00:00", date_updated: null, body: "<p>t</p>",
			sort: null, featured: false, tags: [TAG_MEDIA, TAG_BUG],
		},
		{
			id: 2, headline: "Only bugfix", author: null,
			date_created: "2026-07-15T12:00:00", date_updated: null, body: "<p>b</p>",
			sort: null, featured: false, tags: [TAG_BUG],
		},
	];

	it("renders each article's tag pills in the list and reading pane", () => {
		render(<ReadmeContent state={stateWith({ articles: TAGGED })} />);
		// Media appears once (list row of the selected article) plus once in the
		// body pane → at least 2 occurrences.
		expect(screen.getAllByText("Media").length).toBeGreaterThanOrEqual(2);
	});

	it("hides articles whose every tag is hidden, keeping OR matches", () => {
		render(
			<ReadmeContent state={stateWith({ articles: TAGGED })} hiddenTagIds={[30]} />,
		);
		// Bugfix(30) hidden: "Only bugfix" (id 2, tags [30]) disappears entirely.
		expect(screen.queryByText("Only bugfix")).toBeNull();
		// "Tagged post" survives (still has Media 20).
		expect(screen.getAllByText("Tagged post").length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContent.test.tsx`
Expected: FAIL — `hiddenTagIds` prop unsupported; pills not rendered.

- [ ] **Step 3: Write the implementation**

In `ReadmeContent.tsx`:

Update imports:

```tsx
import { TagPills } from "./TagPills";
import type { ReadmeArticle, ReadmeArticlesState } from "./useReadmeArticles";
import { visibleArticles } from "./useReadmeArticles";
```

Change the component signature and compute the visible list:

```tsx
export const ReadmeContent: React.FC<{
	state: ReadmeArticlesState;
	hiddenTagIds?: number[];
}> = ({ state, hiddenTagIds = [] }) => {
	const { loading, error } = state;
	const [selectedId, setSelectedId] = useState<number | null>(null);

	// Filter the feed by the reader's tag preferences before rendering/selecting.
	const articles = visibleArticles(state.articles, hiddenTagIds);

	// Newest (first) visible article by default; if a refresh or filter removed
	// the selected article, fall back to the newest visible one rather than a
	// blank pane.
	const selected: ReadmeArticle | null =
		articles.find((a) => a.id === selectedId) ?? articles[0] ?? null;
```

(The rest of the guards and JSX keep referencing `articles`, which is now the
filtered list.)

Add `<TagPills>` in the list row — inside the `<button>`, immediately after the
`byline` span:

```tsx
							<span className={readmeStyles.byline}>
								{a.author ? `${a.author} — ` : ""}
								{formatArticleDate(a.date_created)}
							</span>
							<TagPills tags={a.tags} />
```

Add `<TagPills>` in the reading pane — immediately after the `bodyHeadline` h1:

```tsx
					<h1 className={readmeStyles.bodyHeadline}>{selected.headline}</h1>
					<TagPills tags={selected.tags} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContent.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/ReadmeContent.tsx packages/frontend/src/Applications/README/ReadmeContent.test.tsx
git commit -m "feat(readme): render tag pills and apply the tag filter in ReadmeContent"
```

---

### Task 6: File → Settings… window in README.tsx

**Files:**
- Modify: `packages/frontend/src/Applications/README/README.tsx`
- Modify: `packages/frontend/src/Applications/README/README.module.scss`
- Test: `packages/frontend/src/Applications/README/README.test.tsx`

**Interfaces:**
- Consumes: `readReadmeSettings`, `readmeSetSettings` (Task 2), `allTags` (Task 1), `ReadmeContext` registration (Task 3).

- [ ] **Step 1: Write the failing test**

Rewrite `README.test.tsx`'s `classicy` mock to add the exports the settings
window and context registration need, give the mock article a tag, and add a
menu + settings-open test. Replace the whole file with:

```tsx
import { act, cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const dispatched = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appOpen = vi.hoisted(() => ({ current: true }));

vi.mock("classicy", () => ({
	ClassicyApp: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
		appProps.push(props);
		return <div>{props.children}</div>;
	},
	ClassicyWindow: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
		windowProps.push(props);
		return <div>{props.children}</div>;
	},
	ClassicyButton: (props: { children?: React.ReactNode; onClickFunc?: () => void }) => (
		<button type="button" onClick={props.onClickFunc}>{props.children}</button>
	),
	ClassicyCheckbox: (props: { id: string; label: string; checked: boolean; onClickFunc: (c: boolean) => void }) => (
		<label>
			<input
				type="checkbox"
				checked={props.checked}
				onChange={(e) => props.onClickFunc(e.target.checked)}
			/>
			{props.label}
		</label>
	),
	ClassicyControlGroup: (props: { children?: React.ReactNode }) => <div>{props.children}</div>,
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: (icons: Record<string, unknown>) => icons,
	registerAppEventHandler: () => {},
	quitMenuItemHelper: () => ({ id: "quit" }),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					Applications: { apps: { "Readme.app": { open: appOpen.current, data: undefined } } },
				},
			},
		}),
	useAppManagerDispatch: () => (action: Record<string, unknown>) => {
		dispatched.push(action);
	},
}));

vi.mock("./useReadmeArticles", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./useReadmeArticles")>();
	return {
		...mod,
		useReadmeArticles: () => ({
			articles: [
				{
					id: 1, headline: "Welcome", author: "Robbie Byrd",
					date_created: "2026-07-16T12:00:00", date_updated: null,
					body: "<p>Hello desktop</p>", sort: null, featured: false,
					tags: [{ id: 5, name: "Announcement", color: "#cc3333" }],
				},
			],
			loading: false,
			error: null,
		}),
	};
});

import { Readme } from "./README";

afterEach(() => {
	cleanup();
	windowProps.length = 0;
	appProps.length = 0;
	dispatched.length = 0;
	appOpen.current = true;
});

function fileSettingsItem() {
	const menu = windowProps[0].appMenu as Array<{ id: string; menuChildren: Array<{ id: string; title: string; onClickFunc?: () => void }> }>;
	const file = menu.find((m) => m.id === "file");
	return file?.menuChildren.find((c) => c.id === "settings");
}

describe("Readme", () => {
	it("mounts a Readme.app window with the article content", () => {
		render(<Readme />);
		expect(appProps[0]).toMatchObject({ id: "Readme.app", name: "README", defaultWindow: "readme_main" });
		expect(windowProps[0]).toMatchObject({ id: "readme_main", appId: "Readme.app" });
		expect(screen.getAllByText("Welcome").length).toBeGreaterThan(0);
		expect(screen.getByText("Hello desktop")).toBeDefined();
	});

	it("offers a File → Settings… menu item", () => {
		render(<Readme />);
		expect(fileSettingsItem()?.title).toBe("Settings…");
	});

	it("opens a settings window listing a checkbox per tag", () => {
		render(<Readme />);
		// No settings window yet → no checkboxes (the pills are plain spans).
		expect(screen.queryAllByRole("checkbox").length).toBe(0);
		act(() => fileSettingsItem()?.onClickFunc?.());
		// One checkbox per tag from the mocked feed (just "Announcement").
		expect(screen.getAllByRole("checkbox").length).toBe(1);
		// And its label is the tag name (appears here plus in the pills → ≥1).
		expect(screen.getAllByText("Announcement").length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/README.test.tsx`
Expected: FAIL — no Settings… menu item / no settings window.

- [ ] **Step 3: Write the implementation**

Rewrite `README.tsx`:

```tsx
import {
	ClassicyApp,
	ClassicyButton,
	ClassicyCheckbox,
	ClassicyControlGroup,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
	useAppManagerDispatch,
} from "classicy";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import appIconPng from "./app.png";
import { ReadmeContent } from "./ReadmeContent";
import "./ReadmeContext";
import readmeStyles from "./README.module.scss";
import { readmeSetSettings, readReadmeSettings, type ReadmeSettings } from "./readmeSettings";
import { allTags, useReadmeArticles } from "./useReadmeArticles";

const appId   = "Readme.app";
const appName = "README";

const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		readme: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.readme.app;

export const Readme: React.FC = () => {
	const isOpen = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId]?.open ?? false,
	);
	const appData = useAppManager(
		(state) =>
			state.System.Manager.Applications.apps[appId]?.data as
				| Record<string, unknown>
				| undefined,
	);
	const desktopEventDispatch = useAppManagerDispatch();
	const state = useReadmeArticles(isOpen);

	const settings = useMemo(() => readReadmeSettings(appData), [appData]);
	const tags = useMemo(() => allTags(state.articles), [state.articles]);

	// Settings draft (RadioScanner pattern): seeded on open, dispatched on Save.
	const [showSettings, setShowSettings] = useState(false);
	const [settingsForm, setSettingsForm] = useState<ReadmeSettings>(settings);

	const openSettings = useCallback(() => {
		setSettingsForm(settings);
		setShowSettings(true);
	}, [settings]);

	const saveSettingsForm = useCallback(() => {
		// Prune ids for tags no longer in the feed so they don't accumulate.
		const universe = new Set(tags.map((t) => t.id));
		desktopEventDispatch(
			readmeSetSettings({
				hiddenTagIds: settingsForm.hiddenTagIds.filter((id) => universe.has(id)),
			}),
		);
		setShowSettings(false);
	}, [desktopEventDispatch, settingsForm, tags]);

	const toggleTag = useCallback((id: number, checked: boolean) => {
		setSettingsForm((f) => ({
			hiddenTagIds: checked
				? f.hiddenTagIds.filter((x) => x !== id)      // checked = visible
				: [...new Set([...f.hiddenTagIds, id])],       // unchecked = hidden
		}));
	}, []);

	const appMenu = useMemo(
		() => [
			{
				id:           "file",
				title:        "File",
				menuChildren: [
					{ id: "settings", title: "Settings…", onClickFunc: openSettings },
					quitMenuItemHelper(appId, appName, appIcon),
				],
			},
		],
		[openSettings],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="readme_main"
			addSystemMenu={false}
		>
			{showSettings && (
				<ClassicyWindow
					id={`${appId}_settings`}
					title="Settings"
					appId={appId}
					icon={appIcon}
					closable={true}
					resizable={false}
					zoomable={false}
					scrollable={false}
					collapsable={false}
					initialSize={[300, 0]}
					initialPosition={[250, 150]}
					modal={true}
					appMenu={appMenu}
					onCloseFunc={() => setShowSettings(false)}
				>
					<div className={readmeStyles.settings}>
						<ClassicyControlGroup label="Show tags">
							{tags.length === 0 && (
								<div className={readmeStyles.status}>No tags yet.</div>
							)}
							{tags.map((t) => (
								<ClassicyCheckbox
									key={t.id}
									id={`readme_settings_tag_${t.id}`}
									label={t.name}
									checked={!settingsForm.hiddenTagIds.includes(t.id)}
									onClickFunc={(checked: boolean) => toggleTag(t.id, checked)}
								/>
							))}
						</ClassicyControlGroup>
						<div className={readmeStyles.settingsButtons}>
							<ClassicyButton onClickFunc={() => setShowSettings(false)}>
								Cancel
							</ClassicyButton>
							<ClassicyButton isDefault={true} onClickFunc={saveSettingsForm}>
								Save
							</ClassicyButton>
						</div>
					</div>
				</ClassicyWindow>
			)}
			<ClassicyWindow
				id="readme_main"
				title="README"
				appId={appId}
				icon={appIcon}
				closable={true}
				resizable={true}
				zoomable={true}
				scrollable={false}
				collapsable={false}
				initialSize={[560, 380]}
				initialPosition={[220, 120]}
				modal={false}
				appMenu={appMenu}
			>
				<ReadmeContent state={state} hiddenTagIds={settings.hiddenTagIds} />
			</ClassicyWindow>
		</ClassicyApp>
	);
};
```

Append settings styles to `README.module.scss`:

```scss
.settings {
	display: flex;
	flex-direction: column;
	padding: var(--window-padding-size);
	gap: var(--window-padding-size);
	font-family: var(--ui-font);
	font-size: var(--ui-font-size);
	background-color: var(--color-system-02);
}

.settingsButtons {
	display: flex;
	flex-direction: row;
	justify-content: flex-end;
	gap: calc(var(--window-padding-size) * 0.5);
	padding-top: calc(var(--window-padding-size) * 0.5);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/README.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the whole README suite + typecheck + lint**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/README/
pnpm --filter @rt911/frontend exec tsc -b
pnpm --filter @rt911/frontend exec eslint src/Applications/README/
```
Expected: all pass. (If `ClassicyButton`'s `isDefault` prop trips types, confirm the prop name against `RadioScanner.tsx:681` — it uses `isDefault={true}`.)

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/README/README.tsx packages/frontend/src/Applications/README/README.module.scss packages/frontend/src/Applications/README/README.test.tsx
git commit -m "feat(readme): File -> Settings window with per-tag show/hide filter"
```

---

### Task 7: Directus M2M provisioning (schema + seed + public read)

**Files:** none in-repo — this provisions the Directus instance the frontend reads.

**Prerequisites:** a Directus **static admin token** (Cloudflare blocks `POST /auth/login`, so port-forward and use a token). This dev box is the k3s node; `kubectl` works directly.

- [ ] **Step 1: Port-forward Directus (bypasses Cloudflare)**

```bash
kubectl port-forward svc/rt911-api 8055:8055 -n <directus-namespace> &
export DHOST=http://localhost:8055
export DTOKEN=<static-admin-token>
```

- [ ] **Step 2: Create the `readme_tags` collection with its fields**

```bash
curl -sS -X POST "$DHOST/collections" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{
    "collection": "readme_tags",
    "meta": { "icon": "sell", "note": "README article tags" },
    "schema": {},
    "fields": [
      { "field": "id", "type": "integer", "schema": { "is_primary_key": true, "has_auto_increment": true }, "meta": { "hidden": true } },
      { "field": "name", "type": "string", "schema": { "is_nullable": false }, "meta": { "interface": "input", "required": true } },
      { "field": "color", "type": "string", "schema": { "is_nullable": true }, "meta": { "interface": "select-color", "note": "Pill background hex, e.g. #cc3333" } },
      { "field": "sort", "type": "integer", "schema": { "is_nullable": true }, "meta": { "interface": "input", "hidden": true } }
    ]
  }' | head -c 400; echo
```

- [ ] **Step 3: Create the junction collection**

```bash
curl -sS -X POST "$DHOST/collections" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{
    "collection": "readme_articles_tags",
    "meta": { "hidden": true, "icon": "import_export" },
    "schema": {},
    "fields": [
      { "field": "id", "type": "integer", "schema": { "is_primary_key": true, "has_auto_increment": true }, "meta": { "hidden": true } }
    ]
  }' | head -c 400; echo
```

- [ ] **Step 4: Add the two junction FK fields**

```bash
curl -sS -X POST "$DHOST/fields/readme_articles_tags" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "field": "readme_articles_id", "type": "integer", "schema": {}, "meta": { "hidden": true } }' | head -c 200; echo

curl -sS -X POST "$DHOST/fields/readme_articles_tags" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "field": "readme_tags_id", "type": "integer", "schema": {}, "meta": { "hidden": true } }' | head -c 200; echo
```

- [ ] **Step 5: Create the alias M2M field on `readme_articles`**

```bash
curl -sS -X POST "$DHOST/fields/readme_articles" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "field": "tags", "type": "alias", "meta": { "interface": "list-m2m", "special": ["m2m"], "options": {} } }' | head -c 200; echo
```

- [ ] **Step 6: Wire the two relations (this is what makes it a real M2M)**

```bash
# junction.readme_articles_id  ->  readme_articles  (one_field "tags" is the alias)
curl -sS -X POST "$DHOST/relations" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{
    "collection": "readme_articles_tags",
    "field": "readme_articles_id",
    "related_collection": "readme_articles",
    "meta": { "one_field": "tags", "junction_field": "readme_tags_id", "sort_field": null },
    "schema": { "on_delete": "SET NULL" }
  }' | head -c 300; echo

# junction.readme_tags_id  ->  readme_tags
curl -sS -X POST "$DHOST/relations" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{
    "collection": "readme_articles_tags",
    "field": "readme_tags_id",
    "related_collection": "readme_tags",
    "meta": { "one_field": null, "junction_field": "readme_articles_id" },
    "schema": { "on_delete": "SET NULL" }
  }' | head -c 300; echo
```

- [ ] **Step 7: Grant public read on the two new collections**

Find the public policy id, then add read permissions (readme_articles already has public read):

```bash
# The public policy is the one attached to the null (public) role.
curl -sS "$DHOST/policies?fields=id,name,roles&limit=-1" \
  -H "Authorization: Bearer $DTOKEN" | head -c 800; echo
# Set PUBLIC_POLICY to the public policy id from the output above:
export PUBLIC_POLICY=<public-policy-id>

for COL in readme_tags readme_articles_tags; do
  curl -sS -X POST "$DHOST/permissions" \
    -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
    -d "{ \"policy\": \"$PUBLIC_POLICY\", \"collection\": \"$COL\", \"action\": \"read\", \"fields\": [\"*\"] }" | head -c 200; echo
done
```

- [ ] **Step 8: Seed starter tags and assign a couple to an article**

```bash
curl -sS -X POST "$DHOST/items/readme_tags" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '[
    { "name": "Announcement", "color": "#cc3333", "sort": 1 },
    { "name": "Bugfix",       "color": "#3366cc", "sort": 2 },
    { "name": "Media",        "color": "#33aa55", "sort": 3 }
  ]' | head -c 400; echo

# Assign tag ids 1 and 3 to article id 1 (adjust ids to your data):
curl -sS -X PATCH "$DHOST/items/readme_articles/1" \
  -H "Authorization: Bearer $DTOKEN" -H "Content-Type: application/json" \
  -d '{ "tags": [ { "readme_tags_id": 1 }, { "readme_tags_id": 3 } ] }' | head -c 300; echo
```

- [ ] **Step 9: Verify the public deep-fields query returns tags**

This is exactly the shape the frontend requests (unauthenticated):

```bash
curl -sS -g "$DHOST/items/readme_articles?filter[status][_eq]=published&fields=id,headline,tags.readme_tags_id.id,tags.readme_tags_id.name,tags.readme_tags_id.color&limit=2" | head -c 800; echo
```
Expected: JSON where at least one article has `tags: [{ readme_tags_id: { id, name, color } }, …]`. If it 403s, the public read permission (Step 7) didn't take; if it 400s on `tags.*`, the alias field or relations (Steps 5–6) are wrong.

- [ ] **Step 10: Note completion**

No git commit (environment change). Record in the PR description that the schema was applied to the target Directus instance, so reviewers know the deploy is safe (per the Directus-ordering global constraint).

---

## Final Verification

- [ ] Full README suite green: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/`
- [ ] Repo typecheck: `pnpm --filter @rt911/frontend exec tsc -b`
- [ ] Lint clean: `pnpm --filter @rt911/frontend exec eslint src/Applications/README/`
- [ ] Manual browser check (packages/frontend:verify skill): open the README app, confirm pills render under headlines in both panes, open File → Settings…, uncheck a tag, Save, confirm the matching articles disappear and the choice survives a reload.
