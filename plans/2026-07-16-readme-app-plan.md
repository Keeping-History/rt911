# README App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Classicy desktop app, README, that lists blog-style articles from Directus (headline / author / date on the left, sanitized HTML body on the right) and refreshes within one minute of a Directus edit.

**Architecture:** A new `readme_articles` Directus collection (WYSIWYG HTML body, public read filtered to `status=published`) is read directly over REST from a polling hook (`useBookmarks.ts` precedent — no streamer involvement, not time-gated). The hook does a cheap aggregate probe every 60 s and only refetches the full list when the `(count, max date_updated)` signature changes. UI is a standard `ClassicyApp` + one `ClassicyWindow` with a two-pane flex layout.

**Tech Stack:** React 19 + TypeScript (Vite), classicy, DOMPurify (already a dependency), Directus 12.1.1 REST API, vitest + @testing-library/react.

**Spec:** `plans/2026-07-16-readme-app-design.md` (approved).

## Global Constraints

- **Zero new npm dependencies.** DOMPurify is already in `packages/frontend/package.json`.
- **Not time-gated:** this app must never import `MediaStreamContext`, `useMediaStream`, `useClassicyDateTime`, or `virtualClock` helpers. Dates shown are real-world dates.
- **Sequential Directus fetches only** — api-beta returns mixed response bodies under concurrent browser requests. Never issue two requests in parallel; a new poll cycle must not start while one is in flight.
- **App identity:** app id `"Readme.app"`, display name `"README"`, window id `"readme_main"`, folder `packages/frontend/src/Applications/README/`.
- **Directus base URL:** `import.meta.env.VITE_DIRECTUS_URL` falling back to `https://api-beta.911realtime.org` (same pattern as `src/Applications/TimeMachine/useBookmarks.ts`).
- **Component tests need `afterEach(cleanup)`** — this repo's vitest has no RTL auto-cleanup.
- **Indentation: tabs** in new frontend source files (match `Feedback.tsx` / `useBookmarks.ts`).
- **Commits:** the `.husky/pre-commit` hook auto-bumps `classicy` in `pnpm-lock.yaml`; that ride-along is expected — do not hand-revert it. Run all frontend commands from the repo root with `pnpm --filter @rt911/frontend exec ...`.
- All paths below are relative to the repo root (the `flight-map-controls` worktree).

---

### Task 1: Provision the `readme_articles` Directus collection

No repo files change in this task — it provisions the live Directus instance (api-beta, Directus 12.1.1) that every later task reads from. It must be done first so the frontend has real data to verify against.

**Files:**
- None (live Directus provisioning; commands run in the shell).

**Interfaces:**
- Consumes: `DIRECTUS_API_TOKEN` static admin token from the `video-grabber-secrets` k8s secret (this dev box is the k3s node; passwordless sudo works).
- Produces: collection `readme_articles` with fields `id` (int PK), `status` (string: published/draft/archived, default draft), `sort` (int, hidden), `date_created` (timestamp, auto on create), `date_updated` (timestamp, auto on update), `headline` (string, required), `author` (string), `body` (text, WYSIWYG HTML). Public read permission filtered to `status=published`, all fields. One seeded published article. Later tasks rely on the REST shapes verified in Steps 5–6.

- [ ] **Step 1: Get the admin token and base URL into the shell**

```bash
TOKEN=$(sudo kubectl get secret video-grabber-secrets -n video-grabber \
  -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d)
BASE=https://api-beta.911realtime.org
# sanity: version should be 12.1.1
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/server/info" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['data']['version'])"
```

Expected: `12.1.1`. Never write the token into any file inside the repo.

- [ ] **Step 2: Create the collection (idempotent — skip if it already exists)**

If `curl -s -H "Authorization: Bearer $TOKEN" "$BASE/collections/readme_articles" | head -c 60` shows data (not an error), skip to Step 3. Directus schema-ops gotcha: always print response bodies — errors are often opaque 400s otherwise.

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/collections" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @- <<'JSON'
{
  "collection": "readme_articles",
  "meta": {
    "icon": "article",
    "note": "README desktop app articles (site news/announcements)",
    "display_template": "{{headline}}",
    "sort_field": "sort",
    "archive_field": "status",
    "archive_value": "archived",
    "unarchive_value": "draft"
  },
  "schema": {},
  "fields": [
    { "field": "id", "type": "integer",
      "meta": { "hidden": true, "interface": "input", "readonly": true },
      "schema": { "is_primary_key": true, "has_auto_increment": true } },
    { "field": "status", "type": "string",
      "meta": { "interface": "select-dropdown", "width": "full",
        "options": { "choices": [
          { "text": "$t:published", "value": "published" },
          { "text": "$t:draft", "value": "draft" },
          { "text": "$t:archived", "value": "archived" } ] } },
      "schema": { "default_value": "draft", "is_nullable": false } },
    { "field": "sort", "type": "integer",
      "meta": { "interface": "input", "hidden": true }, "schema": {} },
    { "field": "date_created", "type": "timestamp",
      "meta": { "special": ["date-created"], "interface": "datetime",
        "readonly": true, "hidden": true, "width": "half" },
      "schema": {} },
    { "field": "date_updated", "type": "timestamp",
      "meta": { "special": ["date-updated"], "interface": "datetime",
        "readonly": true, "hidden": true, "width": "half" },
      "schema": {} },
    { "field": "headline", "type": "string",
      "meta": { "interface": "input", "required": true },
      "schema": { "is_nullable": false } },
    { "field": "author", "type": "string",
      "meta": { "interface": "input" }, "schema": {} },
    { "field": "body", "type": "text",
      "meta": { "interface": "input-rich-text-html" }, "schema": {} }
  ]
}
JSON
```

Expected: `HTTP 200` and a JSON body echoing the collection.

- [ ] **Step 3: Grant the Public policy filtered read access**

`abf8a154-5b1c-4a46-ac9c-7300570f4f17` is Directus's well-known static Public-policy UUID (confirmed present on api-beta via `GET /policies` — it's the row named `$t:public_label`). Permission *filters* are OSS; per-field limits are the license-gated feature we hit on `flight_positions` and are not used here.

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/permissions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
    "policy": "abf8a154-5b1c-4a46-ac9c-7300570f4f17",
    "collection": "readme_articles",
    "action": "read",
    "permissions": { "status": { "_eq": "published" } },
    "fields": ["*"]
  }'
```

Expected: `HTTP 200` with the created permission row.

- [ ] **Step 4: Seed one published welcome article**

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/items/readme_articles" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
    "status": "published",
    "headline": "Welcome to 911realtime.org",
    "author": "Robbie Byrd",
    "body": "<p>Welcome. This desktop replays the media of September 11, 2001 in real time — television, radio, pagers, newsgroups, and more — synchronized to a shared virtual clock.</p><p>Watch this space for site news and updates. New articles appear here within a minute of being published.</p>"
  }'
```

Expected: `HTTP 200`, item echoed with `id: 1` and a `date_created`.

- [ ] **Step 5: Verify anonymous access sees exactly the published list**

```bash
# NO auth header — this is what the browser will do
curl -s "$BASE/items/readme_articles?filter[status][_eq]=published&sort=-date_created&fields=id,headline,author,date_created,date_updated,body&limit=-1" | python3 -m json.tool
```

Expected: `data` array with the one seeded article; `date_updated` is `null` (never edited).

- [ ] **Step 6: Verify the aggregate probe shape and that drafts are invisible**

```bash
curl -s "$BASE/items/readme_articles?filter[status][_eq]=published&aggregate[count]=*&aggregate[max]=date_updated" | python3 -m json.tool
# create a draft with the admin token, confirm anonymous still sees count 1, then delete it
DRAFT_ID=$(curl -s -X POST "$BASE/items/readme_articles" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"draft","headline":"draft visibility test","body":"<p>x</p>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
curl -s "$BASE/items/readme_articles?filter[status][_eq]=published&aggregate[count]=*" 
curl -s -X DELETE "$BASE/items/readme_articles/$DRAFT_ID" -H "Authorization: Bearer $TOKEN" -w 'HTTP %{http_code}\n'
```

Expected: probe returns `{"data": [{"count": 1, "max": {"date_updated": null}}]}` (note: `count` may arrive as a number or string depending on driver — the hook treats it opaquely); the draft never appears anonymously; delete returns `HTTP 204`. **Record the exact probe JSON shape** — Task 2's `ProbeRow` type must match it.

No commit — nothing in the repo changed.

---

### Task 2: `useReadmeArticles` polling hook

**Files:**
- Create: `packages/frontend/src/Applications/README/useReadmeArticles.ts`
- Test: `packages/frontend/src/Applications/README/useReadmeArticles.test.ts`

**Interfaces:**
- Consumes: the live REST shapes verified in Task 1 Steps 5–6.
- Produces (used by Tasks 3–4):
  - `interface ReadmeArticle { id: number; headline: string; author: string | null; date_created: string; date_updated: string | null; body: string }`
  - `interface ReadmeArticlesState { articles: ReadmeArticle[]; loading: boolean; error: string | null }`
  - `function useReadmeArticles(enabled: boolean): ReadmeArticlesState`
  - Constants `ARTICLES_URL`, `PROBE_URL`, `REFRESH_INTERVAL_MS` (exported for tests).

- [ ] **Step 1: Write the failing tests**

Create `packages/frontend/src/Applications/README/useReadmeArticles.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadmeArticle } from "./useReadmeArticles";
import {
	ARTICLES_URL,
	PROBE_URL,
	REFRESH_INTERVAL_MS,
	useReadmeArticles,
} from "./useReadmeArticles";

const ARTICLES: ReadmeArticle[] = [
	{
		id: 2, headline: "Newer post", author: "Robbie Byrd",
		date_created: "2026-07-16T12:00:00", date_updated: null, body: "<p>Two</p>",
	},
	{
		id: 1, headline: "Welcome", author: "Robbie Byrd",
		date_created: "2026-07-01T12:00:00", date_updated: "2026-07-02T09:00:00", body: "<p>One</p>",
	},
];

function probeResponse(count: number, maxUpdated: string | null): Response {
	return {
		ok: true,
		json: async () => ({ data: [{ count, max: { date_updated: maxUpdated } }] }),
	} as unknown as Response;
}

function listResponse(articles: ReadmeArticle[]): Response {
	return { ok: true, json: async () => ({ data: articles }) } as unknown as Response;
}

// Let the mocked-fetch promise chains inside the hook settle under fake timers.
async function flush(ms = 0): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("useReadmeArticles", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("probes then fetches the published list on mount, sequentially", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		expect(result.current.loading).toBe(true);

		await flush();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(result.current.articles).toEqual(ARTICLES);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(1, PROBE_URL, expect.objectContaining({ signal: expect.anything() }));
		expect(fetchMock).toHaveBeenNthCalledWith(2, ARTICLES_URL, expect.objectContaining({ signal: expect.anything() }));
	});

	it("does not refetch the list when the probe signature is unchanged", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValue(probeResponse(2, "2026-07-02T09:00:00"));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		// 2 initial + 1 probe — no third list fetch
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenLastCalledWith(PROBE_URL, expect.objectContaining({ signal: expect.anything() }));
	});

	it("refetches the list when the probe signature changes", async () => {
		const updated: ReadmeArticle[] = [
			{
				id: 3, headline: "Breaking", author: null,
				date_created: "2026-07-17T08:00:00", date_updated: null, body: "<p>Three</p>",
			},
			...ARTICLES,
		];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValueOnce(probeResponse(3, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(updated));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(result.current.articles).toEqual(updated);
	});

	it("keeps the last-good list when a later probe fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockRejectedValue(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		await flush(REFRESH_INTERVAL_MS);

		expect(result.current.articles).toEqual(ARTICLES);
		expect(result.current.error).toBeNull();
	});

	it("reports an error only when nothing has ever loaded, then recovers on the next tick", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(probeResponse(2, "2026-07-02T09:00:00"))
			.mockResolvedValueOnce(listResponse(ARTICLES));
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useReadmeArticles(true));
		await flush();
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBe("boom");

		await flush(REFRESH_INTERVAL_MS);
		expect(result.current.error).toBeNull();
		expect(result.current.articles).toEqual(ARTICLES);
	});

	it("never starts a new cycle while one is still in flight", async () => {
		// First probe hangs forever — later ticks must not stack requests.
		const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(true));
		await flush(REFRESH_INTERVAL_MS * 3);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does nothing when disabled", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useReadmeArticles(false));
		await flush(REFRESH_INTERVAL_MS);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops polling on unmount", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(probeResponse(1, null))
			.mockResolvedValueOnce(listResponse(ARTICLES))
			.mockResolvedValue(probeResponse(1, null));
		vi.stubGlobal("fetch", fetchMock);

		const { unmount } = renderHook(() => useReadmeArticles(true));
		await flush();
		unmount();
		await flush(REFRESH_INTERVAL_MS * 2);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/useReadmeArticles.test.ts`
Expected: FAIL — cannot resolve `./useReadmeArticles`.

- [ ] **Step 3: Write the hook**

Create `packages/frontend/src/Applications/README/useReadmeArticles.ts`:

```ts
import { useEffect, useState } from "react";

// A README article: present-day site news authored in Directus. Unlike every
// other app's data this is NOT time-gated — dates are real-world dates and the
// list refreshes from Directus about once a minute while the app is open.
export interface ReadmeArticle {
	id:           number;
	headline:     string;
	author:       string | null;
	date_created: string;
	date_updated: string | null;
	body:         string;
}

export interface ReadmeArticlesState {
	articles: ReadmeArticle[];
	loading:  boolean;
	error:    string | null;
}

// Same direct-REST pattern as TimeMachine/useBookmarks.ts: reference data that
// bypasses the streamer entirely.
const DIRECTUS_URL =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api-beta.911realtime.org";

export const ARTICLES_URL =
	`${DIRECTUS_URL}/items/readme_articles` +
	"?filter[status][_eq]=published&sort=-date_created" +
	"&fields=id,headline,author,date_created,date_updated,body&limit=-1";

// One cheap aggregate row: (count, max date_updated) is a change signature —
// count catches creates/deletes, max(date_updated) catches edits. Blind spot
// (delete + create in the same minute that cancel out) self-heals on the next
// real edit; see plans/2026-07-16-readme-app-design.md.
export const PROBE_URL =
	`${DIRECTUS_URL}/items/readme_articles` +
	"?filter[status][_eq]=published&aggregate[count]=*&aggregate[max]=date_updated";

export const REFRESH_INTERVAL_MS = 60_000;

interface ProbeRow {
	count: number | string;
	max:   { date_updated: string | null } | null;
}

export function useReadmeArticles(enabled: boolean): ReadmeArticlesState {
	const [state, setState] = useState<ReadmeArticlesState>({
		articles: [],
		loading:  true,
		error:    null,
	});

	useEffect(() => {
		if (!enabled) return;

		const controller = new AbortController();
		let signature: string | null = null;
		let busy   = false;
		let loaded = false;

		const probe = async (): Promise<string> => {
			const res = await fetch(PROBE_URL, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: ProbeRow[] };
			const row = json.data[0];
			return `${row?.count ?? 0}|${row?.max?.date_updated ?? ""}`;
		};

		const fetchList = async () => {
			const res = await fetch(ARTICLES_URL, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = (await res.json()) as { data: ReadmeArticle[] };
			loaded = true;
			setState({ articles: json.data, loading: false, error: null });
		};

		// Probe → (maybe) fetch, strictly sequential: api-beta mixes response
		// bodies under concurrent requests, and a slow cycle must finish before
		// the next tick starts. The signature is committed only after a
		// successful list fetch so a failed fetch retries on the next tick.
		const tick = async () => {
			if (busy) return;
			busy = true;
			try {
				const sig = await probe();
				if (sig !== signature) {
					await fetchList();
					signature = sig;
				}
			} catch (err) {
				// After a successful load, errors are silent: keep the
				// last-good list and let the next tick retry.
				if (!controller.signal.aborted && !loaded) {
					setState({
						articles: [],
						loading:  false,
						error:    err instanceof Error ? err.message : String(err),
					});
				}
			} finally {
				busy = false;
			}
		};

		void tick();
		const interval = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
		return () => {
			clearInterval(interval);
			controller.abort();
		};
	}, [enabled]);

	return state;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/useReadmeArticles.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/README/useReadmeArticles.ts \
        packages/frontend/src/Applications/README/useReadmeArticles.test.ts
git commit -m "feat(readme): probe-then-fetch Directus polling hook"
```

---

### Task 3: `ReadmeContent` two-pane component

**Files:**
- Create: `packages/frontend/src/Applications/README/ReadmeContent.tsx`
- Create: `packages/frontend/src/Applications/README/README.module.scss`
- Test: `packages/frontend/src/Applications/README/ReadmeContent.test.tsx`

**Interfaces:**
- Consumes: `ReadmeArticlesState` / `ReadmeArticle` from `./useReadmeArticles` (Task 2).
- Produces (used by Task 4):
  - `const ReadmeContent: React.FC<{ state: ReadmeArticlesState }>`
  - `function formatArticleDate(iso: string): string` — e.g. `"Jul 16, 2026"`.

- [ ] **Step 1: Write the failing tests**

Create `packages/frontend/src/Applications/README/ReadmeContent.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatArticleDate, ReadmeContent } from "./ReadmeContent";
import type { ReadmeArticle, ReadmeArticlesState } from "./useReadmeArticles";

afterEach(cleanup);

const ARTICLES: ReadmeArticle[] = [
	{
		id: 2, headline: "Newer post", author: "Robbie Byrd",
		date_created: "2026-07-16T12:00:00", date_updated: null, body: "<p>Two</p>",
	},
	{
		id: 1, headline: "Welcome", author: null,
		date_created: "2026-07-01T12:00:00", date_updated: null, body: "<p>One</p>",
	},
];

function stateWith(overrides: Partial<ReadmeArticlesState>): ReadmeArticlesState {
	return { articles: [], loading: false, error: null, ...overrides };
}

describe("formatArticleDate", () => {
	it("formats an ISO date as a short US date", () => {
		expect(formatArticleDate("2026-07-16T12:00:00")).toBe("Jul 16, 2026");
	});
});

describe("ReadmeContent", () => {
	it("shows a loading state", () => {
		render(<ReadmeContent state={stateWith({ loading: true })} />);
		expect(screen.getByText("Loading…")).toBeDefined();
	});

	it("shows the error state when nothing loaded", () => {
		render(<ReadmeContent state={stateWith({ error: "HTTP 500" })} />);
		expect(screen.getByText(/Couldn’t load articles/)).toBeDefined();
	});

	it("shows an empty state when there are no articles", () => {
		render(<ReadmeContent state={stateWith({})} />);
		expect(screen.getByText("No articles yet.")).toBeDefined();
	});

	it("lists headline, author and date for every article", () => {
		render(<ReadmeContent state={stateWith({ articles: ARTICLES })} />);
		expect(screen.getByText("Newer post")).toBeDefined();
		expect(screen.getByText("Robbie Byrd — Jul 16, 2026")).toBeDefined();
		expect(screen.getByText("Welcome")).toBeDefined();
		expect(screen.getByText("Jul 1, 2026")).toBeDefined(); // authorless byline
	});

	it("selects the newest article by default and swaps the body on click", () => {
		const { container } = render(<ReadmeContent state={stateWith({ articles: ARTICLES })} />);
		const body = () => container.querySelector("article");
		expect(body()?.innerHTML).toContain("Two");

		fireEvent.click(screen.getByText("Welcome"));
		expect(body()?.innerHTML).toContain("One");
	});

	it("sanitizes the article body", () => {
		const evil: ReadmeArticle = {
			id: 9, headline: "XSS", author: null,
			date_created: "2026-07-16T12:00:00", date_updated: null,
			body: '<p>safe</p><script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">',
		};
		const { container } = render(<ReadmeContent state={stateWith({ articles: [evil] })} />);
		const article = container.querySelector("article");
		expect(article?.textContent).toContain("safe");
		expect(article?.querySelector("script")).toBeNull();
		expect(article?.querySelector("img")?.getAttribute("onerror")).toBeNull();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContent.test.tsx`
Expected: FAIL — cannot resolve `./ReadmeContent`.

- [ ] **Step 3: Write the stylesheet**

Create `packages/frontend/src/Applications/README/README.module.scss`:

```scss
@use 'classicy/scss/appearance';

.split {
	display: flex;
	height: 100%;
	min-height: 0;
}

.list {
	width: 190px;
	flex-shrink: 0;
	margin: 0;
	padding: 0;
	list-style: none;
	overflow-y: auto;
	border-right: 1px solid var(--color-theme-05);
	background: var(--color-theme-01);
}

.row,
.rowSelected {
	display: block;
	width: 100%;
	padding: 6px 8px;
	border: none;
	border-bottom: 1px solid var(--color-theme-05);
	background: none;
	text-align: left;
	cursor: pointer;
	font-family: inherit;
}

.rowSelected {
	background: var(--color-theme-06);
	color: var(--color-theme-01);
}

.headline {
	display: block;
	font-weight: bold;
	font-size: 12px;
}

.byline {
	display: block;
	font-size: 10px;
	opacity: 0.75;
	margin-top: 2px;
}

.body {
	flex: 1;
	min-width: 0;
	overflow-y: auto;
	padding: 10px 14px;
	font-size: 12px;

	img {
		max-width: 100%;
	}
}

.status {
	padding: 12px;
	font-size: 12px;
}
```

- [ ] **Step 4: Write the component**

Create `packages/frontend/src/Applications/README/ReadmeContent.tsx`:

```tsx
import DOMPurify from "dompurify";
import type React from "react";
import { useState } from "react";
import readmeStyles from "./README.module.scss";
import type { ReadmeArticle, ReadmeArticlesState } from "./useReadmeArticles";

export function formatArticleDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day:   "numeric",
		year:  "numeric",
	});
}

// The two-pane README window body: article list on the left, the selected
// article's sanitized HTML on the right. Pure presentation — data arrives via
// props so this renders (and tests) without classicy or the network.
export const ReadmeContent: React.FC<{ state: ReadmeArticlesState }> = ({ state }) => {
	const { articles, loading, error } = state;
	const [selectedId, setSelectedId] = useState<number | null>(null);

	// Newest (first) article by default; if a refresh removed the selected
	// article, fall back to newest rather than a blank pane.
	const selected: ReadmeArticle | null =
		articles.find((a) => a.id === selectedId) ?? articles[0] ?? null;

	if (loading) return <div className={readmeStyles.status}>Loading…</div>;
	if (error) return <div className={readmeStyles.status}>Couldn’t load articles: {error}</div>;
	if (!selected) return <div className={readmeStyles.status}>No articles yet.</div>;

	return (
		<div className={readmeStyles.split}>
			<ul className={readmeStyles.list}>
				{articles.map((a) => (
					<li key={a.id}>
						<button
							type="button"
							className={a.id === selected.id ? readmeStyles.rowSelected : readmeStyles.row}
							onClick={() => setSelectedId(a.id)}
						>
							<span className={readmeStyles.headline}>{a.headline}</span>
							<span className={readmeStyles.byline}>
								{a.author ? `${a.author} — ` : ""}
								{formatArticleDate(a.date_created)}
							</span>
						</button>
					</li>
				))}
			</ul>
			<article
				className={readmeStyles.body}
				// Sanitized via DOMPurify before injection — Browser.tsx precedent.
				dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(selected.body) }}
			/>
		</div>
	);
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/ReadmeContent.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/README/ReadmeContent.tsx \
        packages/frontend/src/Applications/README/README.module.scss \
        packages/frontend/src/Applications/README/ReadmeContent.test.tsx
git commit -m "feat(readme): two-pane article list + sanitized HTML body"
```

---

### Task 4: `Readme` app shell, icon, and desktop registration

**Files:**
- Create: `packages/frontend/src/Applications/README/app.png` (generated, 32×32 RGBA)
- Create: `packages/frontend/src/Applications/README/README.tsx`
- Modify: `packages/frontend/src/Desktop.tsx` (add import + `<Readme />`)
- Test: `packages/frontend/src/Applications/README/README.test.tsx`

**Interfaces:**
- Consumes: `ReadmeContent` (Task 3), `useReadmeArticles` (Task 2), classicy `ClassicyApp`/`ClassicyWindow`/`quitMenuItemHelper`/`registerClassicyIcons`/`ClassicyIcons`/`useAppManager`.
- Produces: `export const Readme: React.FC` — the app registered on the desktop.

- [ ] **Step 1: Generate the 32×32 app icon**

A classic Mac "ReadMe" document icon (white page, folded corner, text lines). Placeholder aesthetics — easy to replace later, the code only cares that `app.png` exists:

```bash
python3 - <<'PY'
from PIL import Image, ImageDraw
im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.polygon([(6, 2), (20, 2), (26, 8), (26, 29), (6, 29)], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255))
d.polygon([(20, 2), (20, 8), (26, 8)], fill=(170, 170, 170, 255), outline=(0, 0, 0, 255))
d.line([(9, 12), (17, 12)], fill=(0, 0, 0, 255))
for y in (15, 18, 21, 24):
    d.line([(9, y), (23, y)], fill=(120, 120, 120, 255))
im.save("packages/frontend/src/Applications/README/app.png")
PY
python3 -c "from PIL import Image; im = Image.open('packages/frontend/src/Applications/README/app.png'); print(im.size, im.mode)"
```

Expected: `(32, 32) RGBA`.

- [ ] **Step 2: Write the failing app-shell test**

Create `packages/frontend/src/Applications/README/README.test.tsx`. Classicy is mocked per-export (repo gotcha: the mock must cover **every** classicy import `README.tsx` uses, or the test crashes on an undefined component):

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
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
	ClassicyIcons: { applications: {} },
	registerClassicyIcons: (icons: Record<string, unknown>) => icons,
	quitMenuItemHelper: () => ({ id: "quit" }),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					Applications: { apps: { "Readme.app": { open: appOpen.current } } },
				},
			},
		}),
}));

const hookCalls = vi.hoisted(() => [] as boolean[]);
vi.mock("./useReadmeArticles", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./useReadmeArticles")>();
	return {
		...mod,
		useReadmeArticles: (enabled: boolean) => {
			hookCalls.push(enabled);
			return {
				articles: [
					{
						id: 1, headline: "Welcome", author: "Robbie Byrd",
						date_created: "2026-07-16T12:00:00", date_updated: null,
						body: "<p>Hello desktop</p>",
					},
				],
				loading: false,
				error: null,
			};
		},
	};
});

import { Readme } from "./README";

afterEach(() => {
	cleanup();
	windowProps.length = 0;
	appProps.length = 0;
	hookCalls.length = 0;
});

describe("Readme", () => {
	it("mounts a Readme.app window with the article content", () => {
		render(<Readme />);
		expect(appProps[0]).toMatchObject({ id: "Readme.app", name: "README", defaultWindow: "readme_main" });
		expect(windowProps[0]).toMatchObject({ id: "readme_main", appId: "Readme.app" });
		expect(screen.getByText("Welcome")).toBeDefined();
		expect(screen.getByText("Hello desktop")).toBeDefined();
	});

	it("passes the app-open state through to the polling hook", () => {
		appOpen.current = false;
		render(<Readme />);
		expect(hookCalls).toEqual([false]);
		appOpen.current = true;
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/README.test.tsx`
Expected: FAIL — cannot resolve `./README` (the .tsx doesn't exist yet).

- [ ] **Step 4: Write the app shell**

Create `packages/frontend/src/Applications/README/README.tsx`:

```tsx
import {
	ClassicyApp,
	ClassicyIcons,
	ClassicyWindow,
	quitMenuItemHelper,
	registerClassicyIcons,
	useAppManager,
} from "classicy";
import type React from "react";
import { useMemo } from "react";
import appIconPng from "./app.png";
import { ReadmeContent } from "./ReadmeContent";
import { useReadmeArticles } from "./useReadmeArticles";

const appId   = "Readme.app";
const appName = "README";

// This app's own icon, registered into the shared registry — same shallow
// spread as Feedback.tsx so classicy's bundled icons stay intact.
const ICONS = registerClassicyIcons({
	applications: {
		...ClassicyIcons.applications,
		readme: { app: appIconPng },
	},
});
const appIcon = ICONS.applications.readme.app;

export const Readme: React.FC = () => {
	// Poll Directus only while the app is open (MarketWatch precedent).
	const isOpen = useAppManager(
		(state) => state.System.Manager.Applications.apps[appId]?.open ?? false,
	);
	const state = useReadmeArticles(isOpen);

	const appMenu = useMemo(
		() => [
			{
				id:           "file",
				title:        "File",
				menuChildren: [quitMenuItemHelper(appId, appName, appIcon)],
			},
		],
		[],
	);

	return (
		<ClassicyApp
			id={appId}
			name={appName}
			icon={appIcon}
			defaultWindow="readme_main"
			addSystemMenu={false}
		>
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
				<ReadmeContent state={state} />
			</ClassicyWindow>
		</ClassicyApp>
	);
};
```

Note: if `useAppManager`'s selector parameter is typed more loosely in the installed classicy build, mirror how `MarketWatch.tsx:65` types the same call — copy its exact selector shape rather than inventing a new one.

- [ ] **Step 5: Register the app on the desktop**

Modify `packages/frontend/src/Desktop.tsx` — add the import (alphabetical, after `PagerDecoder`) and the element (after `<PagerDecoder />`):

```tsx
import { Readme } from "./Applications/README/README";
```

```tsx
			<PagerDecoder />
			<Readme />
			<RadioScanner />
```

- [ ] **Step 6: Run the app tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/README/`
Expected: PASS — all three README test files.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/README/ packages/frontend/src/Desktop.tsx
git commit -m "feat(readme): README desktop app — Directus-backed site news reader"
```

---

### Task 5: Full-suite verification and browser check

**Files:**
- None created; fixes only if verification surfaces problems.

**Interfaces:**
- Consumes: everything above, plus the live seeded collection from Task 1.

- [ ] **Step 1: Full frontend gate (same checks as CI)**

```bash
pnpm --filter @rt911/frontend exec tsc -b
pnpm lint
pnpm test
```

Expected: tsc clean, eslint clean, all vitest suites green (~1000+ tests).

- [ ] **Step 2: Browser-verify against the live collection**

Invoke the `packages/frontend:verify` skill (drives localhost:5173 via Playwright MCP — beware a stale dev server on 5173 from another worktree; restart `pnpm dev` from THIS worktree first). Verify:

1. The README app icon/menu entry appears on the desktop; opening it shows the window.
2. The left pane lists the seeded "Welcome to 911realtime.org" article with author and date; the right pane renders its HTML body.
3. Edit the article in Directus (or via an authenticated `PATCH /items/readme_articles/1` changing the headline), wait ≤ 2 minutes with the app open, and confirm the change appears without a reload.
4. Revert the test edit afterwards (`PATCH` the headline back).

- [ ] **Step 3: Commit any verification fixes**

Only if Step 1–2 forced changes; use a `fix(readme): …` message describing what actually broke.

---

## Execution notes

- Task 1 must run before Task 5 (live data), but Tasks 2–4 only depend on the *recorded shapes* from Task 1 — if api-beta is unreachable, proceed with the shapes documented above and re-verify later.
- The virtual desktop boots at 8:40 AM ET Sept 11, 2001 — README intentionally ignores that clock everywhere. If a reviewer sees 2026 dates in this app, that is correct behavior, not a bug.
