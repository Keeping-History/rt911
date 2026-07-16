# Teacher Playlists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `plans/2026-07-16-teacher-playlists-design.md` — read it first; it is the authority on semantics.

**Goal:** A teacher-authored playlist (loaded from Directus via `?playlist=<id>`) that time-windows media availability, disables apps, focuses/locks items, opens files, schedules the Browser, and jumps the virtual clock — with zero persistence on the client.

**Architecture:** A non-persisted `PlaylistProvider` (React context + pure engine module) mounted in `app.tsx` above `MediaStreamProvider`. Pure functions `evaluate()` (state as a function of clock position) and `collectCrossings()` (edge-triggered events) drive enforcement through existing seams: the media reveal tick, the classicy action registry, TV-style `seq`-commands, and the TimeMachine clock helper.

**Tech Stack:** Vite + React + TS, vitest, classicy (external, pinned `"latest"`), Directus REST (anonymous read), Playwright e2e.

## Global Constraints

- Run one test file: `pnpm --filter @rt911/frontend exec vitest run <path>` (from repo root). Full gate before any PR: `pnpm build && pnpm lint && pnpm test`.
- Playlist runtime state must NEVER touch ClassicyStore persistence, `localStorage`, or the ClassicyFileSystem. React state / refs / module singletons only.
- All playlist times are UTC ISO strings on the virtual timeline; a bare string (no zone) is UTC — append `Z` before parsing (same rule as `TimeMachine/setVirtualClock.ts`).
- Clock comparisons use `virtualUtcMs(localDate, tzOffset)` from `src/Providers/MediaStream/virtualClock.ts` — never raw `localDate`.
- Clock writes go ONLY through `setDateTimeFromUtc(setDateTime, utc)` from `src/Applications/TimeMachine/setVirtualClock.ts`.
- Directus fetches must be sequential (api-beta mixes concurrent same-path response bodies). The loader makes exactly one request; never add `Promise.all` fetches to it.
- New component test files need `afterEach(cleanup)` from `@testing-library/react` — this repo has no RTL auto-cleanup.
- Never hand-edit the `classicy` version; the pre-commit hook bumps it and stages `pnpm-lock.yaml` (an unrelated classicy bump riding along in a commit is normal).
- When mocking classicy in tests, use a PARTIAL mock (`vi.mock("classicy", async (importOriginal) => ({ ...(await importOriginal()), ...overrides }))`) — full replacement breaks whenever a transitive import pulls a symbol you didn't stub.
- Error dialog copy, exactly: `You don't have permission to open this app.`
- Directory for all new playlist files: `packages/frontend/src/Providers/Playlist/`. All paths below are relative to `packages/frontend/` unless they start with `plans/` or `.`.

---

### Task 1: Playlist types + parser/validator

**Files:**
- Create: `src/Providers/Playlist/playlistTypes.ts`
- Create: `src/Providers/Playlist/parsePlaylist.ts`
- Test: `src/Providers/Playlist/parsePlaylist.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module — no classicy, no React).
- Produces (used by Tasks 2–5):
  - `type PlaylistApp = 'tv' | 'radio' | 'news' | 'flights'`
  - `interface PlaylistDefinition { version: 1; mode: 'restrict' | 'annotate'; entries: PlaylistEntry[] }`
  - `type PlaylistEntry = MediaEntry | AppEntry | SettingsEntry | FileEntry | JumpEntry | BrowserEntry` (shapes below)
  - `function playlistUtcMs(s: string): number` — parses bare-UTC or zoned ISO to epoch ms; throws on unparseable.
  - `function parsePlaylist(raw: unknown): { definition: PlaylistDefinition | null; warnings: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// src/Providers/Playlist/parsePlaylist.test.ts
import { describe, expect, it } from "vitest";
import { parsePlaylist } from "./parsePlaylist";
import { playlistUtcMs } from "./playlistTypes";

const valid = {
	version: 1,
	mode: "restrict",
	entries: [
		{ kind: "media", app: "tv", itemId: "CNN", start: "2001-09-11T12:46:00", end: "2001-09-11T13:30:00", focus: "once" },
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true }, locked: true },
		{ kind: "file", path: "Documents:Newspapers:nytimes-2001-09-12.pdf", at: "2001-09-11T13:00:00" },
		{ kind: "jump", at: "2001-09-11T13:03:00", to: "2001-09-11T13:59:00" },
		{ kind: "browser", url: "https://www.cnn.com/", at: "2001-09-11T12:50:00", closeAt: "2001-09-11T12:55:00" },
	],
};

describe("playlistUtcMs", () => {
	it("treats a bare string as UTC (appends Z)", () => {
		expect(playlistUtcMs("2001-09-11T12:46:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("respects an explicit zone", () => {
		expect(playlistUtcMs("2001-09-11T08:46:00-04:00")).toBe(Date.UTC(2001, 8, 11, 12, 46, 0));
	});
	it("throws on garbage", () => {
		expect(() => playlistUtcMs("not a date")).toThrow();
	});
});

describe("parsePlaylist", () => {
	it("accepts a fully valid document with no warnings", () => {
		const { definition, warnings } = parsePlaylist(valid);
		expect(definition?.entries).toHaveLength(6);
		expect(definition?.mode).toBe("restrict");
		expect(warnings).toEqual([]);
	});
	it("rejects a structurally invalid document", () => {
		expect(parsePlaylist(null).definition).toBeNull();
		expect(parsePlaylist({ version: 2, mode: "restrict", entries: [] }).definition).toBeNull();
		expect(parsePlaylist({ version: 1, mode: "nope", entries: [] }).definition).toBeNull();
		expect(parsePlaylist({ version: 1, mode: "restrict", entries: "x" }).definition).toBeNull();
	});
	it("drops malformed entries with a warning and keeps the rest", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [
				{ kind: "media", app: "tv", itemId: "CNN", start: "garbage" }, // bad time
				{ kind: "media", app: "fax", itemId: "X" }, // unknown app
				{ kind: "jump", at: "2001-09-11T13:00:00" }, // missing `to`
				valid.entries[1], // fine
			],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toHaveLength(3);
	});
	it("ignores unknown kinds silently (forward compatibility)", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [{ kind: "hologram", zap: true }, valid.entries[1]],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toEqual([]);
	});
	it("skips focus/settings entries targeting a disabled app, with a warning", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [
				{ kind: "app", appId: "TV.app", disabled: true },
				{ kind: "media", app: "tv", itemId: "CNN", focus: "once" },
				{ kind: "settings", appId: "TV.app", values: { captionsOn: true } },
			],
		});
		// media entry survives as a WINDOW (availability) but its focus is stripped;
		// the settings entry is dropped entirely. Disable wins.
		const media = definition?.entries.find((e) => e.kind === "media");
		expect(media && "focus" in media ? media.focus : undefined).toBeUndefined();
		expect(definition?.entries.some((e) => e.kind === "settings")).toBe(false);
		expect(warnings).toHaveLength(2);
	});
	it("warns on a backward jump but keeps it (documented loop mechanism)", () => {
		const { definition, warnings } = parsePlaylist({
			version: 1,
			mode: "annotate",
			entries: [{ kind: "jump", at: "2001-09-11T13:00:00", to: "2001-09-11T12:00:00" }],
		});
		expect(definition?.entries).toHaveLength(1);
		expect(warnings).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/parsePlaylist.test.ts`
Expected: FAIL — cannot resolve `./parsePlaylist` / `./playlistTypes`.

- [ ] **Step 3: Write the implementation**

```ts
// src/Providers/Playlist/playlistTypes.ts
// Playlist definition schema — see plans/2026-07-16-teacher-playlists-design.md.
// Pure data module: no React, no classicy.

export type PlaylistApp = "tv" | "radio" | "news" | "flights";

export const PLAYLIST_APPS: readonly PlaylistApp[] = ["tv", "radio", "news", "flights"];

export interface MediaEntry {
	kind: "media";
	app: PlaylistApp;
	itemId: string; // channel source slug / station slug / news doc id / flight callsign
	start?: string; // virtual-clock UTC ISO; omitted = from the beginning
	end?: string; //                          omitted = until the end
	focus?: "once" | "locked";
}

export interface AppEntry {
	kind: "app";
	appId: string; // e.g. "TimeMachine.app"
	disabled: true;
}

export interface SettingsEntry {
	kind: "settings";
	appId: string;
	values: Record<string, unknown>; // merged into apps[appId].data
	locked?: boolean; // default false = boot seed only
}

export interface FileEntry {
	kind: "file";
	path: string; // ClassicyFileSystem path, e.g. "Documents:Newspapers:x.pdf"
	at: string;
}

export interface JumpEntry {
	kind: "jump";
	at: string; // when the clock crosses this…
	to: string; // …set it to this
}

export interface BrowserEntry {
	kind: "browser";
	url: string;
	at: string;
	closeAt?: string;
}

export type PlaylistEntry =
	| MediaEntry
	| AppEntry
	| SettingsEntry
	| FileEntry
	| JumpEntry
	| BrowserEntry;

export interface PlaylistDefinition {
	version: 1;
	mode: "restrict" | "annotate";
	entries: PlaylistEntry[];
}

// Directus stores datetimes without a timezone suffix; a bare value is a UTC
// wall-clock time, so append "Z" — same rule as TimeMachine/setVirtualClock.ts.
const HAS_ZONE = /[zZ]$|[+-]\d\d:?\d\d$/;

export function playlistUtcMs(s: string): number {
	const trimmed = s.trim();
	const ms = new Date(HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`).getTime();
	if (Number.isNaN(ms)) throw new Error(`Unparseable playlist UTC date: "${s}"`);
	return ms;
}
```

```ts
// src/Providers/Playlist/parsePlaylist.ts
// Validate an untrusted playlist document. Structurally invalid documents fail
// wholesale (definition: null); malformed entries are dropped individually with
// a warning; unknown kinds are ignored silently (forward compatibility).
import {
	PLAYLIST_APPS,
	playlistUtcMs,
	type PlaylistApp,
	type PlaylistDefinition,
	type PlaylistEntry,
} from "./playlistTypes";

export interface ParsedPlaylist {
	definition: PlaylistDefinition | null;
	warnings: string[];
}

const KNOWN_KINDS = new Set(["media", "app", "settings", "file", "jump", "browser"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const validTime = (v: unknown): v is string => {
	if (typeof v !== "string") return false;
	try {
		playlistUtcMs(v);
		return true;
	} catch {
		return false;
	}
};

function parseEntry(raw: unknown, warn: (msg: string) => void): PlaylistEntry | null {
	if (!isRecord(raw) || typeof raw.kind !== "string") {
		warn(`entry is not an object with a kind: ${JSON.stringify(raw)}`);
		return null;
	}
	if (!KNOWN_KINDS.has(raw.kind)) return null; // unknown kind: silent skip
	switch (raw.kind) {
		case "media": {
			if (!PLAYLIST_APPS.includes(raw.app as PlaylistApp)) {
				warn(`media entry has unknown app "${String(raw.app)}"`);
				return null;
			}
			if (typeof raw.itemId !== "string" || raw.itemId === "") {
				warn("media entry missing itemId");
				return null;
			}
			if (raw.start !== undefined && !validTime(raw.start)) {
				warn(`media entry "${raw.itemId}" has bad start`);
				return null;
			}
			if (raw.end !== undefined && !validTime(raw.end)) {
				warn(`media entry "${raw.itemId}" has bad end`);
				return null;
			}
			if (raw.focus !== undefined && raw.focus !== "once" && raw.focus !== "locked") {
				warn(`media entry "${raw.itemId}" has bad focus`);
				return null;
			}
			return {
				kind: "media",
				app: raw.app as PlaylistApp,
				itemId: raw.itemId,
				...(raw.start !== undefined ? { start: raw.start as string } : {}),
				...(raw.end !== undefined ? { end: raw.end as string } : {}),
				...(raw.focus !== undefined ? { focus: raw.focus as "once" | "locked" } : {}),
			};
		}
		case "app":
			if (typeof raw.appId !== "string" || raw.disabled !== true) {
				warn("app entry needs appId and disabled: true");
				return null;
			}
			return { kind: "app", appId: raw.appId, disabled: true };
		case "settings":
			if (typeof raw.appId !== "string" || !isRecord(raw.values)) {
				warn("settings entry needs appId and values object");
				return null;
			}
			return {
				kind: "settings",
				appId: raw.appId,
				values: raw.values,
				...(raw.locked === true ? { locked: true } : {}),
			};
		case "file":
			if (typeof raw.path !== "string" || !validTime(raw.at)) {
				warn("file entry needs path and a valid at");
				return null;
			}
			return { kind: "file", path: raw.path, at: raw.at as string };
		case "jump":
			if (!validTime(raw.at) || !validTime(raw.to)) {
				warn("jump entry needs valid at and to");
				return null;
			}
			return { kind: "jump", at: raw.at as string, to: raw.to as string };
		case "browser":
			if (typeof raw.url !== "string" || !validTime(raw.at)) {
				warn("browser entry needs url and a valid at");
				return null;
			}
			if (raw.closeAt !== undefined && !validTime(raw.closeAt)) {
				warn(`browser entry "${raw.url}" has bad closeAt`);
				return null;
			}
			return {
				kind: "browser",
				url: raw.url,
				at: raw.at as string,
				...(raw.closeAt !== undefined ? { closeAt: raw.closeAt as string } : {}),
			};
		default:
			return null;
	}
}

export function parsePlaylist(raw: unknown): ParsedPlaylist {
	const warnings: string[] = [];
	const warn = (msg: string) => warnings.push(msg);

	if (
		!isRecord(raw) ||
		raw.version !== 1 ||
		(raw.mode !== "restrict" && raw.mode !== "annotate") ||
		!Array.isArray(raw.entries)
	) {
		return { definition: null, warnings: ["structurally invalid playlist document"] };
	}

	const entries = raw.entries
		.map((e) => parseEntry(e, warn))
		.filter((e): e is PlaylistEntry => e !== null);

	// Cross-checks. Disable wins: strip focus from media entries whose owning app
	// is disabled (the availability window itself still applies) and drop settings
	// entries for disabled apps entirely.
	const disabled = new Set(
		entries.filter((e) => e.kind === "app").map((e) => e.appId),
	);
	const APP_IDS: Record<PlaylistApp, string> = {
		tv: "TV.app",
		radio: "RadioScanner.app",
		news: "News.app",
		flights: "FlightTracker.app",
	};
	const checked = entries
		.map((e): PlaylistEntry | null => {
			if (e.kind === "media" && e.focus && disabled.has(APP_IDS[e.app])) {
				warn(`focus on "${e.itemId}" ignored: ${APP_IDS[e.app]} is disabled`);
				const { focus: _focus, ...rest } = e;
				return rest;
			}
			if (e.kind === "settings" && disabled.has(e.appId)) {
				warn(`settings for disabled app ${e.appId} skipped`);
				return null;
			}
			if (e.kind === "jump" && playlistUtcMs(e.to) < playlistUtcMs(e.at)) {
				warn(`backward jump at ${e.at} → ${e.to} loops until interrupted`);
			}
			return e;
		})
		.filter((e): e is PlaylistEntry => e !== null);

	return {
		definition: { version: 1, mode: raw.mode, entries: checked },
		warnings,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/parsePlaylist.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Playlist/
git commit -m "feat(playlist): definition types and document parser"
```

---

### Task 2: Pure engine — `evaluate` and `collectCrossings`

**Files:**
- Create: `src/Providers/Playlist/playlistEngine.ts`
- Test: `src/Providers/Playlist/playlistEngine.test.ts`

**Interfaces:**
- Consumes: `PlaylistDefinition`, `PlaylistApp`, `MediaEntry`, `playlistUtcMs` from Task 1.
- Produces (used by Tasks 4–6):

```ts
export interface RulesSnapshot {
	disabledApps: ReadonlySet<string>;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
	lockedFocus: ReadonlyMap<PlaylistApp, string>;
	lockedSettings: ReadonlyMap<string, Record<string, unknown>>;
	browserShouldBe: { open: true; url: string } | { open: false };
}
export const ALLOW_ALL: RulesSnapshot; // null-definition snapshot: everything allowed
export function evaluate(def: PlaylistDefinition | null, nowMs: number): RulesSnapshot;

export type TriggerEvent =
	| { kind: "jump"; atMs: number; to: string }
	| { kind: "file"; atMs: number; path: string }
	| { kind: "focus"; atMs: number; app: PlaylistApp; itemId: string; mode: "once" | "locked" };
export function collectCrossings(
	def: PlaylistDefinition | null,
	prevMs: number,
	nowMs: number,
): TriggerEvent[]; // sorted by atMs ascending; empty when def is null or nowMs <= prevMs

export function initialFocusEvents(def: PlaylistDefinition | null, nowMs: number): TriggerEvent[];
// focus entries whose window CONTAINS nowMs — fired once at provider activation
// (covers refresh / late-join, and focus entries with no start).
```

Semantics to implement exactly (spec §Trigger semantics): windows are half-open `[start, end)`; missing bound = unbounded. `isItemAvailable`: case-insensitive itemId match; no matching entry → `mode === 'annotate'`; otherwise available iff SOME matching window contains nowMs. `browserShouldBe`: among browser entries with `at ≤ now < (closeAt ?? ∞)`, the latest `at` wins; none → `{open: false}`. `lockedFocus`: media entries with `focus: 'locked'` whose window contains now (last entry wins per app). Crossings: `prev < at ≤ now`; media focus crossings use `start` as `at` (entries without `start` never cross — they are handled by `initialFocusEvents`).

- [ ] **Step 1: Write the failing test**

```ts
// src/Providers/Playlist/playlistEngine.test.ts
import { describe, expect, it } from "vitest";
import { ALLOW_ALL, collectCrossings, evaluate, initialFocusEvents } from "./playlistEngine";
import { playlistUtcMs, type PlaylistDefinition } from "./playlistTypes";

const T = (s: string) => playlistUtcMs(`2001-09-11T${s}`);

const def: PlaylistDefinition = {
	version: 1,
	mode: "restrict",
	entries: [
		{ kind: "media", app: "tv", itemId: "CNN", start: "2001-09-11T12:46:00", end: "2001-09-11T13:30:00", focus: "locked" },
		{ kind: "media", app: "tv", itemId: "ABC" }, // unbounded window, no focus
		{ kind: "media", app: "radio", itemId: "wnyc", focus: "once" }, // no start: initial-focus only
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true }, locked: true },
		{ kind: "file", path: "Documents:Newspapers:x.pdf", at: "2001-09-11T13:00:00" },
		{ kind: "jump", at: "2001-09-11T13:03:00", to: "2001-09-11T13:59:00" },
		{ kind: "browser", url: "https://a.example/", at: "2001-09-11T12:50:00", closeAt: "2001-09-11T12:55:00" },
		{ kind: "browser", url: "https://b.example/", at: "2001-09-11T12:52:00" },
	],
};

describe("evaluate", () => {
	it("null definition allows everything", () => {
		expect(evaluate(null, T("12:00:00"))).toBe(ALLOW_ALL);
		expect(ALLOW_ALL.isItemAvailable("tv", "anything")).toBe(true);
		expect(ALLOW_ALL.disabledApps.size).toBe(0);
	});
	it("windows are half-open [start, end)", () => {
		expect(evaluate(def, T("12:45:59")).isItemAvailable("tv", "CNN")).toBe(false);
		expect(evaluate(def, T("12:46:00")).isItemAvailable("tv", "CNN")).toBe(true);
		expect(evaluate(def, T("13:29:59")).isItemAvailable("tv", "CNN")).toBe(true);
		expect(evaluate(def, T("13:30:00")).isItemAvailable("tv", "CNN")).toBe(false);
	});
	it("itemId match is case-insensitive", () => {
		expect(evaluate(def, T("12:50:00")).isItemAvailable("tv", "cnn")).toBe(true);
	});
	it("restrict mode hides unlisted items; annotate mode allows them", () => {
		expect(evaluate(def, T("12:50:00")).isItemAvailable("tv", "NBC")).toBe(false);
		const annotate = { ...def, mode: "annotate" as const };
		expect(evaluate(annotate, T("12:50:00")).isItemAvailable("tv", "NBC")).toBe(true);
		// listed items stay window-bound even in annotate mode
		expect(evaluate(annotate, T("12:00:00")).isItemAvailable("tv", "CNN")).toBe(false);
	});
	it("collects disabled apps and locked settings", () => {
		const snap = evaluate(def, T("12:00:00"));
		expect(snap.disabledApps.has("TimeMachine.app")).toBe(true);
		expect(snap.lockedSettings.get("TV.app")).toEqual({ captionsOn: true });
	});
	it("locked focus is active only inside its window", () => {
		expect(evaluate(def, T("12:50:00")).lockedFocus.get("tv")).toBe("CNN");
		expect(evaluate(def, T("13:31:00")).lockedFocus.get("tv")).toBeUndefined();
	});
	it("browserShouldBe: latest at wins; closeAt closes", () => {
		expect(evaluate(def, T("12:49:00")).browserShouldBe).toEqual({ open: false });
		expect(evaluate(def, T("12:51:00")).browserShouldBe).toEqual({ open: true, url: "https://a.example/" });
		expect(evaluate(def, T("12:53:00")).browserShouldBe).toEqual({ open: true, url: "https://b.example/" });
		// a closed at 12:55 but b (no closeAt) persists
		expect(evaluate(def, T("12:56:00")).browserShouldBe).toEqual({ open: true, url: "https://b.example/" });
	});
});

describe("collectCrossings", () => {
	it("fires events in (prev, now], sorted by atMs", () => {
		const events = collectCrossings(def, T("12:59:59"), T("13:03:00"));
		expect(events.map((e) => e.kind)).toEqual(["file", "jump"]);
	});
	it("fires nothing on a backward or zero move", () => {
		expect(collectCrossings(def, T("13:10:00"), T("13:00:00"))).toEqual([]);
		expect(collectCrossings(def, T("13:00:00"), T("13:00:00"))).toEqual([]);
	});
	it("media focus crossings use start as at, carrying mode", () => {
		const events = collectCrossings(def, T("12:45:59"), T("12:46:00"));
		expect(events).toEqual([
			{ kind: "focus", atMs: T("12:46:00"), app: "tv", itemId: "CNN", mode: "locked" },
		]);
	});
	it("null definition yields nothing", () => {
		expect(collectCrossings(null, 0, 9e12)).toEqual([]);
	});
});

describe("initialFocusEvents", () => {
	it("returns focus entries whose window contains now (incl. no-start entries)", () => {
		const events = initialFocusEvents(def, T("12:50:00"));
		expect(events.map((e) => (e.kind === "focus" ? e.itemId : ""))).toEqual(["CNN", "wnyc"]);
	});
	it("excludes focus entries outside their window", () => {
		const events = initialFocusEvents(def, T("13:31:00"));
		expect(events.map((e) => (e.kind === "focus" ? e.itemId : ""))).toEqual(["wnyc"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/playlistEngine.test.ts`
Expected: FAIL — cannot resolve `./playlistEngine`.

- [ ] **Step 3: Write the implementation**

```ts
// src/Providers/Playlist/playlistEngine.ts
// Pure playlist engine — no React, no classicy. evaluate() answers "what should
// the world look like at this clock position" (idempotent); collectCrossings()
// yields the one-shot events between two tick positions. Only natural ticking
// fires events; the provider (Task 5) enforces that by what it passes here.
import {
	playlistUtcMs,
	type MediaEntry,
	type PlaylistApp,
	type PlaylistDefinition,
} from "./playlistTypes";

export interface RulesSnapshot {
	disabledApps: ReadonlySet<string>;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
	lockedFocus: ReadonlyMap<PlaylistApp, string>;
	lockedSettings: ReadonlyMap<string, Record<string, unknown>>;
	browserShouldBe: { open: true; url: string } | { open: false };
}

export const ALLOW_ALL: RulesSnapshot = {
	disabledApps: new Set(),
	isItemAvailable: () => true,
	lockedFocus: new Map(),
	lockedSettings: new Map(),
	browserShouldBe: { open: false },
};

// Half-open window [start, end); a missing bound is unbounded.
const withinWindow = (e: MediaEntry, nowMs: number): boolean =>
	(e.start === undefined || playlistUtcMs(e.start) <= nowMs) &&
	(e.end === undefined || nowMs < playlistUtcMs(e.end));

export function evaluate(def: PlaylistDefinition | null, nowMs: number): RulesSnapshot {
	if (!def) return ALLOW_ALL;

	const disabledApps = new Set<string>();
	const lockedSettings = new Map<string, Record<string, unknown>>();
	const lockedFocus = new Map<PlaylistApp, string>();
	const mediaByApp = new Map<PlaylistApp, MediaEntry[]>();
	let browser: RulesSnapshot["browserShouldBe"] = { open: false };
	let browserAt = Number.NEGATIVE_INFINITY;

	for (const e of def.entries) {
		switch (e.kind) {
			case "app":
				disabledApps.add(e.appId);
				break;
			case "settings":
				if (e.locked) lockedSettings.set(e.appId, e.values);
				break;
			case "media": {
				const list = mediaByApp.get(e.app) ?? [];
				list.push(e);
				mediaByApp.set(e.app, list);
				if (e.focus === "locked" && withinWindow(e, nowMs)) lockedFocus.set(e.app, e.itemId);
				break;
			}
			case "browser": {
				const atMs = playlistUtcMs(e.at);
				const closeMs = e.closeAt === undefined ? Number.POSITIVE_INFINITY : playlistUtcMs(e.closeAt);
				if (atMs <= nowMs && nowMs < closeMs && atMs >= browserAt) {
					browser = { open: true, url: e.url };
					browserAt = atMs;
				}
				break;
			}
			default:
				break;
		}
	}

	const isItemAvailable = (app: PlaylistApp, itemId: string): boolean => {
		const lc = itemId.toLowerCase();
		const matching = (mediaByApp.get(app) ?? []).filter((m) => m.itemId.toLowerCase() === lc);
		if (matching.length === 0) return def.mode === "annotate";
		return matching.some((m) => withinWindow(m, nowMs));
	};

	return { disabledApps, isItemAvailable, lockedFocus, lockedSettings, browserShouldBe: browser };
}

export type TriggerEvent =
	| { kind: "jump"; atMs: number; to: string }
	| { kind: "file"; atMs: number; path: string }
	| { kind: "focus"; atMs: number; app: PlaylistApp; itemId: string; mode: "once" | "locked" };

export function collectCrossings(
	def: PlaylistDefinition | null,
	prevMs: number,
	nowMs: number,
): TriggerEvent[] {
	if (!def || nowMs <= prevMs) return [];
	const out: TriggerEvent[] = [];
	for (const e of def.entries) {
		if (e.kind === "jump") {
			const atMs = playlistUtcMs(e.at);
			if (prevMs < atMs && atMs <= nowMs) out.push({ kind: "jump", atMs, to: e.to });
		} else if (e.kind === "file") {
			const atMs = playlistUtcMs(e.at);
			if (prevMs < atMs && atMs <= nowMs) out.push({ kind: "file", atMs, path: e.path });
		} else if (e.kind === "media" && e.focus !== undefined && e.start !== undefined) {
			const atMs = playlistUtcMs(e.start);
			if (prevMs < atMs && atMs <= nowMs) {
				out.push({ kind: "focus", atMs, app: e.app, itemId: e.itemId, mode: e.focus });
			}
		}
	}
	return out.sort((a, b) => a.atMs - b.atMs);
}

// Focus entries whose window contains nowMs — fired once when the provider
// activates (page load / late join / refresh), covering entries with no start.
export function initialFocusEvents(
	def: PlaylistDefinition | null,
	nowMs: number,
): TriggerEvent[] {
	if (!def) return [];
	const out: TriggerEvent[] = [];
	for (const e of def.entries) {
		if (e.kind === "media" && e.focus !== undefined && withinWindow(e, nowMs)) {
			out.push({
				kind: "focus",
				atMs: e.start === undefined ? nowMs : playlistUtcMs(e.start),
				app: e.app,
				itemId: e.itemId,
				mode: e.focus,
			});
		}
	}
	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/playlistEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Playlist/playlistEngine.ts packages/frontend/src/Providers/Playlist/playlistEngine.test.ts
git commit -m "feat(playlist): pure engine - evaluate snapshots and edge-crossing events"
```

---

### Task 3: Loader — URL param + Directus fetch

**Files:**
- Create: `src/Providers/Playlist/loadPlaylist.ts`
- Test: `src/Providers/Playlist/loadPlaylist.test.ts`

**Interfaces:**
- Consumes: `parsePlaylist` (Task 1).
- Produces (used by Task 4):

```ts
export function playlistIdFromSearch(search: string): string | null;
// ?playlist=<id>; id must match /^[A-Za-z0-9-]{1,64}$/ (uuid-shaped), else null.

export interface LoadedPlaylist { title: string; definition: PlaylistDefinition; warnings: string[] }
export async function loadPlaylist(
	id: string,
	fetchFn?: typeof fetch,
): Promise<LoadedPlaylist>; // throws Error("playlist-unavailable") on any failure
```

Directus URL: `${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}` where `DIRECTUS_URL = (import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api-beta.911realtime.org"` (mirror `useFlightTrack.ts`). Response shape `{ data: { id, title, status, definition } }`. Reject non-OK, `status !== "published"`, or a null parse. Exactly ONE request — never parallel fetches (api-beta serialization constraint).

- [ ] **Step 1: Write the failing test**

```ts
// src/Providers/Playlist/loadPlaylist.test.ts
import { describe, expect, it, vi } from "vitest";
import { loadPlaylist, playlistIdFromSearch } from "./loadPlaylist";

const validRow = {
	data: {
		id: "abc-123",
		title: "Period 3",
		status: "published",
		definition: { version: 1, mode: "annotate", entries: [] },
	},
};

const okFetch = (body: unknown) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("playlistIdFromSearch", () => {
	it("extracts a well-formed id", () => {
		expect(playlistIdFromSearch("?playlist=abc-123")).toBe("abc-123");
	});
	it("returns null when absent or malformed", () => {
		expect(playlistIdFromSearch("")).toBeNull();
		expect(playlistIdFromSearch("?playlist=")).toBeNull();
		expect(playlistIdFromSearch("?playlist=has/slash")).toBeNull();
		expect(playlistIdFromSearch(`?playlist=${"x".repeat(65)}`)).toBeNull();
	});
});

describe("loadPlaylist", () => {
	it("returns title + parsed definition on success", async () => {
		const f = okFetch(validRow);
		const loaded = await loadPlaylist("abc-123", f);
		expect(loaded.title).toBe("Period 3");
		expect(loaded.definition.mode).toBe("annotate");
		expect(f).toHaveBeenCalledTimes(1);
		expect(String(f.mock.calls[0][0])).toContain("/items/playlists/abc-123");
	});
	it("throws playlist-unavailable on HTTP error", async () => {
		const f = vi.fn(async () => new Response("nope", { status: 403 }));
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
	it("throws on unpublished status", async () => {
		const f = okFetch({ data: { ...validRow.data, status: "draft" } });
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
	it("throws on a structurally invalid definition", async () => {
		const f = okFetch({ data: { ...validRow.data, definition: { version: 99 } } });
		await expect(loadPlaylist("abc-123", f)).rejects.toThrow("playlist-unavailable");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/loadPlaylist.test.ts`
Expected: FAIL — cannot resolve `./loadPlaylist`.

- [ ] **Step 3: Write the implementation**

```ts
// src/Providers/Playlist/loadPlaylist.ts
// Resolve-my-playlist seam. Today: id in the URL, anonymous Directus read.
// A future auth layer replaces only this module ("whatever playlist my teacher
// assigned"), leaving the provider/engine untouched.
import { parsePlaylist } from "./parsePlaylist";
import type { PlaylistDefinition } from "./playlistTypes";

const DIRECTUS_URL: string =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";

// uuid-shaped: letters, digits, hyphens. Anything else is ignored (no fetch).
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function playlistIdFromSearch(search: string): string | null {
	const id = new URLSearchParams(search).get("playlist");
	return id && ID_RE.test(id) ? id : null;
}

export interface LoadedPlaylist {
	title: string;
	definition: PlaylistDefinition;
	warnings: string[];
}

interface PlaylistRow {
	data?: { title?: unknown; status?: unknown; definition?: unknown };
}

// Exactly ONE request. Never add concurrent fetches here: parallel same-path
// requests to api-beta can return mixed response bodies (see useRouteIndex.ts).
export async function loadPlaylist(
	id: string,
	fetchFn: typeof fetch = fetch,
): Promise<LoadedPlaylist> {
	const fail = () => new Error("playlist-unavailable");
	let row: PlaylistRow;
	try {
		const res = await fetchFn(`${DIRECTUS_URL}/items/playlists/${encodeURIComponent(id)}`);
		if (!res.ok) throw fail();
		row = (await res.json()) as PlaylistRow;
	} catch (err) {
		console.warn("playlist fetch failed:", err);
		throw fail();
	}
	if (row.data?.status !== "published") throw fail();
	const { definition, warnings } = parsePlaylist(row.data.definition);
	for (const w of warnings) console.warn("playlist:", w);
	if (!definition) throw fail();
	return { title: String(row.data.title ?? ""), definition, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/loadPlaylist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Playlist/loadPlaylist.ts packages/frontend/src/Providers/Playlist/loadPlaylist.test.ts
git commit -m "feat(playlist): URL-param + Directus loader behind the resolve seam"
```

---

### Task 4: PlaylistContext + PlaylistProvider skeleton (load, app gating, mount)

**Files:**
- Create: `src/Providers/Playlist/playlistApps.ts`
- Create: `src/Providers/Playlist/PlaylistContext.ts`
- Create: `src/Providers/Playlist/PlaylistProvider.tsx`
- Modify: `src/app.tsx` (mount `PlaylistProvider` ABOVE `MediaStreamProvider`, lines 92–104)
- Test: `src/Providers/Playlist/PlaylistProvider.test.tsx`

**Interfaces:**
- Consumes: `loadPlaylist`/`playlistIdFromSearch` (Task 3), `evaluate`/`ALLOW_ALL` (Task 2); classicy: `useAppManager`, `useAppManagerDispatch`, `useClassicyDateTime`; `virtualUtcMs` from `src/Providers/MediaStream/virtualClock.ts`.
- Produces (used by Tasks 5–6):

```ts
// PlaylistContext.ts
export interface PlaylistContextValue {
	active: boolean; // a definition is loaded and enforcing
	title: string | null;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
}
export const PlaylistContext: React.Context<PlaylistContextValue>; // default: allow-all, active: false
export function usePlaylist(): PlaylistContextValue;

// playlistApps.ts
export const PLAYLIST_APP_IDS: Record<PlaylistApp, string>; // tv→TV.app, radio→RadioScanner.app, news→News.app, flights→FlightTracker.app
export const PLAYLIST_APP_META: Record<string, { name: string; icon: string }>;
// appId → { name, icon } for TV.app, RadioScanner.app, News.app, FlightTracker.app,
// Browser.app — copy each `appName` / `appIcon` value VERBATIM from the app
// component (grep `const appName` / `const appIcon` in each Applications/<X>/<X>.tsx).
export const PERMISSION_DENIED = "You don't have permission to open this app.";
```

Provider behavior in this task (tick loop comes in Task 5):
1. On mount: `playlistIdFromSearch(window.location.search)`; if null → render children with default context. If present → `loadPlaylist(id)`; on failure dispatch `{ type: "ClassicyDesktopShowErrorDialog", title: "Playlist", message: "This playlist could not be loaded." }` and stay inactive (fail-open).
2. **App-gating watcher** (covers EVERY open path — menus, desktop icons, dock — because classicy's desktop-icon branch never emits `ClassicyAppOpen`): subscribe to `useAppManager((s) => s.System.Manager.Applications.apps)`; whenever a disabled app has `open === true`, dispatch `{ type: "ClassicyAppClose", app: { id, name, icon } }` (meta from `PLAYLIST_APP_META`, falling back to `{ name: appId, icon: "" }`). The FIRST sweep after activation closes silently (stale persisted state); subsequent detections also dispatch `{ type: "ClassicyDesktopShowErrorDialog", title: "Playlist", message: PERMISSION_DENIED }`. Track with a `bootSweepDoneRef`.
3. Context value: `{ active, title, isItemAvailable }` where `isItemAvailable` comes from `evaluate(definition, virtualUtcMs(localDate, tzOffset))`, recomputed per tick render.

In `src/app.tsx`, wrap:

```tsx
<PlaylistProvider>
	<MediaStreamProvider>
		…existing children unchanged…
	</MediaStreamProvider>
</PlaylistProvider>
```

- [ ] **Step 1: Write the failing test**

```tsx
// src/Providers/Playlist/PlaylistProvider.test.tsx
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial classicy mock — full replacement breaks on transitive imports.
const dispatched: Array<Record<string, unknown>> = [];
let mockApps: Record<string, { open?: boolean; data?: Record<string, unknown> }> = {};
vi.mock("classicy", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useAppManagerDispatch: () => (a: Record<string, unknown>) => dispatched.push(a),
	useAppManager: (sel: (s: unknown) => unknown) =>
		sel({ System: { Manager: { Applications: { apps: mockApps }, DateAndTime: {} } } }),
	useClassicyDateTime: () => ({
		dateTime: "2001-09-11T12:50:00.000Z",
		localDate: new Date("2001-09-11T08:50:00.000Z"), // display-shifted (-4)
		tzOffset: -4,
		setDateTime: vi.fn(),
	}),
}));

import { PlaylistProvider } from "./PlaylistProvider";
import { PERMISSION_DENIED } from "./playlistApps";

const definition = {
	version: 1,
	mode: "annotate",
	entries: [{ kind: "app", appId: "TimeMachine.app", disabled: true }],
};
const row = { data: { title: "Test", status: "published", definition } };

describe("PlaylistProvider", () => {
	beforeEach(() => {
		dispatched.length = 0;
		mockApps = {};
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(row), { status: 200 })));
		window.history.replaceState(null, "", "/?playlist=abc-123");
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		window.history.replaceState(null, "", "/");
	});

	it("without ?playlist renders children and fetches nothing", () => {
		window.history.replaceState(null, "", "/");
		const { getByText } = render(<PlaylistProvider><p>kid</p></PlaylistProvider>);
		expect(getByText("kid")).toBeTruthy();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("force-closes a stale-open disabled app silently at activation", async () => {
		mockApps = { "TimeMachine.app": { open: true } };
		render(<PlaylistProvider><p>kid</p></PlaylistProvider>);
		await waitFor(() =>
			expect(dispatched.some((a) => a.type === "ClassicyAppClose")).toBe(true),
		);
		expect(dispatched.some((a) => a.type === "ClassicyDesktopShowErrorDialog")).toBe(false);
	});

	it("closes + shows the permission dialog when a disabled app opens later", async () => {
		mockApps = { "TimeMachine.app": { open: false } };
		const { rerender } = render(<PlaylistProvider><p>kid</p></PlaylistProvider>);
		await waitFor(() => expect(fetch).toHaveBeenCalled());
		mockApps = { "TimeMachine.app": { open: true } };
		rerender(<PlaylistProvider><p>kid</p></PlaylistProvider>);
		await waitFor(() => {
			expect(dispatched.some((a) => a.type === "ClassicyAppClose")).toBe(true);
			expect(
				dispatched.some(
					(a) => a.type === "ClassicyDesktopShowErrorDialog" && a.message === PERMISSION_DENIED,
				),
			).toBe(true);
		});
	});

	it("shows a load-failure dialog and stays fail-open", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 404 })));
		render(<PlaylistProvider><p>kid</p></PlaylistProvider>);
		await waitFor(() =>
			expect(
				dispatched.some(
					(a) =>
						a.type === "ClassicyDesktopShowErrorDialog" &&
						a.message === "This playlist could not be loaded.",
				),
			).toBe(true),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/PlaylistProvider.test.tsx`
Expected: FAIL — cannot resolve `./PlaylistProvider` / `./playlistApps`.

- [ ] **Step 3: Write the implementation**

`playlistApps.ts` (verify each name/icon against the app component before committing — grep `const appName` and `const appIcon` in `src/Applications/{TV/TV,RadioScanner/RadioScanner,News/News,FlightTracker/FlightTracker,Browser/Browser}.tsx` and copy the literal values / icon expressions):

```ts
// src/Providers/Playlist/playlistApps.ts
import { ClassicyIcons } from "classicy"; // adjust to however the app components import their icons
import type { PlaylistApp } from "./playlistTypes";

export const PLAYLIST_APP_IDS: Record<PlaylistApp, string> = {
	tv: "TV.app",
	radio: "RadioScanner.app",
	news: "News.app",
	flights: "FlightTracker.app",
};

// name/icon must MIRROR each component's appName/appIcon so menu entries match.
export const PLAYLIST_APP_META: Record<string, { name: string; icon: string }> = {
	"TV.app": { name: "TV", icon: ClassicyIcons.applications.epg.app as string },
	// …fill in RadioScanner.app / News.app / FlightTracker.app / Browser.app the same way…
};

export const PERMISSION_DENIED = "You don't have permission to open this app.";
```

```tsx
// src/Providers/Playlist/PlaylistProvider.tsx
// Non-persisted playlist runtime. Lives OUTSIDE ClassicyStore/localStorage/
// ClassicyFileSystem by construction — Empty Trash and store resets can't
// touch it; a refresh re-fetches from Directus.
import { useAppManager, useAppManagerDispatch, useClassicyDateTime } from "classicy";
import {
	type FC,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { virtualUtcMs } from "../MediaStream/virtualClock";
import { evaluate } from "./playlistEngine";
import { loadPlaylist, playlistIdFromSearch } from "./loadPlaylist";
import { PLAYLIST_APP_META, PERMISSION_DENIED } from "./playlistApps";
import { PlaylistContext, type PlaylistContextValue } from "./PlaylistContext";
import type { PlaylistDefinition } from "./playlistTypes";

export const PlaylistProvider: FC<{ children: ReactNode }> = ({ children }) => {
	const dispatch = useAppManagerDispatch();
	// tick: true = per-second updates. The bare hook may tick per-minute (the
	// menu-bar clock cadence) — windows/triggers need 1 s resolution.
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const apps = useAppManager(
		(s) => s.System.Manager.Applications.apps,
	) as Record<string, { open?: boolean; data?: Record<string, unknown> }>;

	const [definition, setDefinition] = useState<PlaylistDefinition | null>(null);
	const [title, setTitle] = useState<string | null>(null);
	const bootSweepDoneRef = useRef(false);

	// Load once at mount (StrictMode double-mount guarded by the ref).
	const loadStartedRef = useRef(false);
	useEffect(() => {
		if (loadStartedRef.current) return;
		loadStartedRef.current = true;
		const id = playlistIdFromSearch(window.location.search);
		if (!id) return;
		loadPlaylist(id)
			.then((loaded) => {
				setDefinition(loaded.definition);
				setTitle(loaded.title);
			})
			.catch(() => {
				// Fail-open: a bad link degrades to the normal site, loudly.
				dispatch({
					type: "ClassicyDesktopShowErrorDialog",
					title: "Playlist",
					message: "This playlist could not be loaded.",
				});
			});
	}, [dispatch]);

	const nowMs = virtualUtcMs(localDate, tzOffset);
	const snapshot = useMemo(() => evaluate(definition, nowMs), [definition, nowMs]);

	// App gating: reactive watcher, not action interception — classicy's
	// desktop-icon open path never emits ClassicyAppOpen, so vetoing the action
	// stream would leave a hole. Watching `open` covers every entry point.
	useEffect(() => {
		if (!definition) return;
		const silent = !bootSweepDoneRef.current;
		bootSweepDoneRef.current = true;
		for (const appId of snapshot.disabledApps) {
			if (apps[appId]?.open) {
				const meta = PLAYLIST_APP_META[appId] ?? { name: appId, icon: "" };
				dispatch({ type: "ClassicyAppClose", app: { id: appId, ...meta } });
				if (!silent) {
					dispatch({
						type: "ClassicyDesktopShowErrorDialog",
						title: "Playlist",
						message: PERMISSION_DENIED,
					});
				}
			}
		}
	}, [definition, snapshot, apps, dispatch]);

	const value = useMemo<PlaylistContextValue>(
		() => ({
			active: definition !== null,
			title,
			isItemAvailable: snapshot.isItemAvailable,
		}),
		[definition, title, snapshot],
	);

	return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};
```

```ts
// src/Providers/Playlist/PlaylistContext.ts
import { createContext, useContext } from "react";
import type { PlaylistApp } from "./playlistTypes";

export interface PlaylistContextValue {
	active: boolean;
	title: string | null;
	isItemAvailable: (app: PlaylistApp, itemId: string) => boolean;
}

// Default = no playlist: everything allowed. MediaStreamProvider consumes this
// default in tests that mount it without a PlaylistProvider.
export const PlaylistContext = createContext<PlaylistContextValue>({
	active: false,
	title: null,
	isItemAvailable: () => true,
});

export const usePlaylist = (): PlaylistContextValue => useContext(PlaylistContext);
```

Then edit `src/app.tsx`: import `PlaylistProvider` and wrap `<MediaStreamProvider>…</MediaStreamProvider>` with it (both mobile and desktop branches are inside).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/PlaylistProvider.test.tsx`
Expected: PASS. Also run `pnpm --filter @rt911/frontend exec tsc -b` — expect clean.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Playlist/ packages/frontend/src/app.tsx
git commit -m "feat(playlist): provider skeleton - load, context, app gating watcher"
```

---

### Task 5: Provider tick loop — crossings, browser diff, settings, locked reconciliation

**Files:**
- Create: `src/Providers/Playlist/playlistStoreActions.ts`
- Modify: `src/Providers/Playlist/PlaylistProvider.tsx`
- Test: extend `src/Providers/Playlist/PlaylistProvider.test.tsx`

**Interfaces:**
- Consumes: `collectCrossings`, `initialFocusEvents`, `RulesSnapshot` (Task 2); `setDateTimeFromUtc` from `src/Applications/TimeMachine/setVirtualClock.ts`; `tvTuneChannel` from `src/Applications/TV/TVContext.ts`; action creators from Tasks 8–11 (`radioTuneStation`, `newsFocusItem`, `flightTrackerFocusFlight`, `browserNavigate`) — **until those tasks land, import only `tvTuneChannel` and route the other three through a `FOCUS_DISPATCHERS` table with TODO-free graceful no-ops replaced task-by-task** (define the table with all four keys now; the three not-yet-implemented entries dispatch nothing and `console.warn("playlist: focus for <app> not wired yet")` — Tasks 8–10 replace them).
- Produces:
  - `playlistMergeAppData(appId: string, values: Record<string, unknown>): ActionMessage` (type `"ClassicyAppPlaylistMergeData"`) + registered handler `classicyPlaylistEventHandler` under prefix `"ClassicyAppPlaylist"` — merges `values` into `apps[appId].data` (TVContext-style store plugin).
  - Published-selection contract consumed for locked reconciliation (Tasks 7–10 must publish EXACTLY these keys): `apps["TV.app"].data.currentChannel: string` (source slug), `apps["RadioScanner.app"].data.activeStationSlug: string | null`, `apps["News.app"].data.openDocuments: number[]`, `apps["FlightTracker.app"].data.focusedFlight: string | null`.

Provider additions (all inside `PlaylistProvider`):

```tsx
// 1. Tick / seek discrimination + crossings. SEEK_THRESHOLD_MS matches
//    MediaStreamProvider (90_000): only natural ticking fires events.
const prevMsRef = useRef<number | null>(null);
const { setDateTime } = useClassicyDateTime(); // add to the existing destructure

useEffect(() => {
	if (!definition) return;
	const prev = prevMsRef.current;
	prevMsRef.current = nowMs;
	if (prev === null) {
		// Activation: fire focus entries whose window contains now.
		for (const e of initialFocusEvents(definition, nowMs)) applyFocus(e);
		return;
	}
	if (Math.abs(nowMs - prev) > 90_000) return; // seek: re-arm only, no events
	const events = collectCrossings(definition, prev, nowMs);
	for (const e of events) {
		if (e.kind === "jump") {
			setDateTimeFromUtc(setDateTime, e.to);
			// The clock moved; remaining same-tick events are in skipped territory.
			break;
		}
		if (e.kind === "file") {
			dispatch({ type: "ClassicyAppFinderOpenFile", path: e.path });
		}
		if (e.kind === "focus") applyFocus(e);
	}
}, [definition, nowMs, dispatch, setDateTime]);

// applyFocus: open the owning app through the gated meta table, then dispatch
// the app's tune command (consumers retry until the item exists — TV pattern).
const applyFocus = (e: Extract<TriggerEvent, { kind: "focus" }>): void => {
	const appId = PLAYLIST_APP_IDS[e.app];
	if (snapshotRef.current.disabledApps.has(appId)) return; // disable wins
	const meta = PLAYLIST_APP_META[appId] ?? { name: appId, icon: "" };
	dispatch({ type: "ClassicyAppOpen", app: { id: appId, ...meta } });
	FOCUS_DISPATCHERS[e.app](dispatch, e.itemId);
};

// 2. Browser desired-state diff (transitions only — closing by hand mid-window
//    is respected; the next TRANSITION re-drives it).
const prevBrowserRef = useRef<RulesSnapshot["browserShouldBe"]>({ open: false });
useEffect(() => {
	if (!definition) return;
	const prev = prevBrowserRef.current;
	const next = snapshot.browserShouldBe;
	prevBrowserRef.current = next;
	const meta = PLAYLIST_APP_META["Browser.app"] ?? { name: "Browser", icon: "" };
	if (next.open && (!prev.open || prev.url !== next.url)) {
		dispatch({ type: "ClassicyAppOpen", app: { id: "Browser.app", ...meta } });
		FOCUS_DISPATCHERS.browser(dispatch, next.url);
	} else if (!next.open && prev.open) {
		dispatch({ type: "ClassicyAppClose", app: { id: "Browser.app", ...meta } });
	}
}, [definition, snapshot, dispatch]);

// 3. Settings: one boot merge for ALL settings entries (after load), then a
//    per-tick revert pass for locked ones whose published values diverged.
const settingsSeededRef = useRef(false);
useEffect(() => {
	if (!definition || settingsSeededRef.current) return;
	settingsSeededRef.current = true;
	for (const e of definition.entries) {
		if (e.kind === "settings") dispatch(playlistMergeAppData(e.appId, e.values));
	}
}, [definition, dispatch]);

useEffect(() => {
	if (!definition) return;
	for (const [appId, values] of snapshot.lockedSettings) {
		const data = apps[appId]?.data ?? {};
		const diverged = Object.entries(values).filter(
			([k, v]) => JSON.stringify(data[k]) !== JSON.stringify(v),
		);
		if (diverged.length > 0) {
			dispatch(playlistMergeAppData(appId, Object.fromEntries(diverged)));
		}
	}
}, [definition, snapshot, apps, dispatch]);

// 4. Locked-focus reconciliation against published selections.
useEffect(() => {
	if (!definition) return;
	for (const [app, itemId] of snapshot.lockedFocus) {
		const appId = PLAYLIST_APP_IDS[app];
		const data = apps[appId]?.data ?? {};
		const current =
			app === "tv" ? (data.currentChannel as string | undefined)
			: app === "radio" ? (data.activeStationSlug as string | undefined)
			: app === "flights" ? (data.focusedFlight as string | undefined)
			: undefined; // news handled below
		const newsOpen =
			app === "news" &&
			((data.openDocuments as number[] | undefined) ?? []).includes(Number(itemId));
		const inPlace =
			app === "news" ? newsOpen : current?.toLowerCase() === itemId.toLowerCase();
		if (!inPlace) FOCUS_DISPATCHERS[app](dispatch, itemId);
	}
}, [definition, snapshot, apps, dispatch]);
```

`FOCUS_DISPATCHERS` (module scope in `PlaylistProvider.tsx`; keys `tv|radio|news|flights|browser`): `tv` → `dispatch(tvTuneChannel(itemId))` now; others `console.warn` no-ops replaced by Tasks 8–11. Keep a `snapshotRef` (`useRef` updated each render) so `applyFocus` reads the current snapshot without effect-ordering hazards.

`playlistStoreActions.ts`:

```ts
// src/Providers/Playlist/playlistStoreActions.ts
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerAppEventHandler } from "classicy";

/** Merge keys into apps[appId].data — generic settings write, no per-app actions. */
export const playlistMergeAppData = (
	appId: string,
	values: Record<string, unknown>,
): ActionMessage => ({ type: "ClassicyAppPlaylistMergeData", appId, values });

export const classicyPlaylistEventHandler = (
	ds: ClassicyStore,
	action: ActionMessage,
) => {
	if (action.type !== "ClassicyAppPlaylistMergeData") return ds;
	const app = ds.System.Manager.Applications.apps[action.appId as string];
	if (!app) return ds;
	app.data = { ...(app.data ?? {}), ...(action.values as Record<string, unknown>) };
	return ds;
};

registerAppEventHandler("ClassicyAppPlaylist", classicyPlaylistEventHandler);
```

- [ ] **Step 1: Write failing tests** — extend `PlaylistProvider.test.tsx` with a controllable clock: replace the static `useClassicyDateTime` mock with one reading from a mutable `let mockClock = { dateTime, localDate, tzOffset: -4, setDateTime }` object, and add a `tick(seconds)` helper that advances `mockClock` and `rerender`s. Test cases (write all five; assert on the `dispatched` array):
  1. crossing a `jump` `at` calls `setDateTime` with the parsed `to` Date;
  2. crossing a `file` `at` dispatches `ClassicyAppFinderOpenFile` with the path;
  3. a >90 s clock move dispatches NO crossing events but re-arms (a subsequent tick across a re-armed `at` fires it);
  4. `settings` entries dispatch one `ClassicyAppPlaylistMergeData` per entry at activation; a locked entry whose store value then diverges dispatches a corrective merge on the next tick;
  5. a `browser` entry opens `Browser.app` at `at` and closes it at `closeAt` (transitions only).
- [ ] **Step 2: Run to verify the new tests fail** — `pnpm --filter @rt911/frontend exec vitest run src/Providers/Playlist/PlaylistProvider.test.tsx`.
- [ ] **Step 3: Implement** the code above (plus `classicyPlaylistEventHandler` unit-tested directly with a hand-built `ClassicyStore` fixture — copy the fixture style from any existing context test, or build `{ System: { Manager: { Applications: { apps: { "TV.app": { data: {} } } } } } }` and cast).
- [ ] **Step 4: Run to verify pass** — same command; then `pnpm --filter @rt911/frontend exec tsc -b`.
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): tick loop - crossings, browser schedule, settings, locked reconciliation"`.

---

### Task 6: Catalog gating in MediaStreamProvider

**Files:**
- Modify: `src/Providers/MediaStream/MediaStreamProvider.tsx` (reveal-tick effect ~lines 561–590; context value assembly; `mp3History` + `sources` exposure)
- Test: extend `src/Providers/MediaStream/MediaStreamProvider.test.tsx` if it exists, else create `src/Providers/MediaStream/playlistGating.test.tsx`

**Interfaces:**
- Consumes: `usePlaylist()` (Task 4). Default context = allow-all, so ALL existing MediaStreamProvider tests keep passing unmodified.
- Produces: no new API — `items`, `mp3Items`, `mp3History`, `newsItems`, `flightPositions`, `sources` are now playlist-gated before publication.

Changes, exactly:

1. `const { isItemAvailable } = usePlaylist();` at the top of the component.
2. In the per-second reveal effect, extend the existing filters (add `isItemAvailable` to the dep array — the effect already re-runs per tick on `localDate`):

```ts
setItems((prev) =>
	mergeById(prev, dueMedia).filter(
		(item) => keepMediaItem(item, now) && isItemAvailable("tv", item.source ?? ""),
	),
);
setMp3Items((prev) =>
	mergeById(prev, dueMp3).filter(
		(item) => keepMediaItem(item, now) && isItemAvailable("radio", item.source ?? ""),
	),
);
setNewsItems((prev) =>
	mergeById(prev, dueNews).filter(
		(item) => keepMediaItem(item, now) && isItemAvailable("news", String(item.id)),
	),
);
// pager/usenet/weather: NOT gated (spec: restrict scope is tv/radio/news/flights)
setFlightPositions((prev) =>
	mergeById(prev, dueFlights).filter(
		(p) => keepInstantItem(p, now) && isItemAvailable("flights", p.flight),
	),
);
```

3. Gate the two non-tick surfaces with memos placed just before the context value:

```ts
const gatedMp3History = useMemo(
	() => mp3History.filter((i) => isItemAvailable("radio", i.source ?? "")),
	[mp3History, isItemAvailable],
);
const gatedSources = useMemo<AvailableSources>(
	() => ({
		...sources,
		video: sources.video.filter((s) => isItemAvailable("tv", s)),
		audio: sources.audio.filter((s) => isItemAvailable("radio", s)),
	}),
	[sources, isItemAvailable],
);
```

Pass `gatedMp3History` / `gatedSources` into the context value where `mp3History` / `sources` were. (`isItemAvailable`'s identity changes each tick while a playlist is active — that is what re-opens/closes windows within a second; with no playlist the default is a stable constant and behavior is byte-identical to today.)

- [ ] **Step 1: Write failing tests** — mount `MediaStreamProvider` inside a hand-rolled `PlaylistContext.Provider` whose `isItemAvailable` blocks `("tv", "CNN")`, inject an item via the exposed `addItems` (source `CNN`, plus one `ABC`), and assert a consumer sees only `ABC`; second test: swap the context value to allow-all and assert `CNN` appears (window opening = pure function of predicate). Follow the existing MediaStreamProvider test file's harness for WebSocket stubbing; `afterEach(cleanup)`.
- [ ] **Step 2: Run to verify fail** — `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/`.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run to verify pass**, plus the FULL frontend suite (`pnpm test` from repo root) — this task touches the most-shared provider; every existing test must stay green.
- [ ] **Step 5: Commit** — `git commit -m "feat(playlist): gate media catalog and sources by availability windows"`.

---

### Task 7: TV publishes its current channel slug

**Files:**
- Modify: `src/Applications/TV/TV.tsx` (command-consumption effect at ~line 414 and the activePlayer set-path) and `src/Applications/TV/TVContext.ts`
- Test: extend the existing TV test file

**Interfaces:**
- Consumes: nothing new.
- Produces: `apps["TV.app"].data.currentChannel: string` — the `source` slug of the active single-view channel, updated whenever `activePlayer` changes. Exact contract consumed by Task 5's locked reconciliation.

Implementation: add an action `tvSetCurrentChannel(source: string): ActionMessage` (`type: "ClassicyAppTVSetCurrentChannel"`, handler case writes `data.currentChannel`) in `TVContext.ts`; in `TV.tsx`, in the same places `setActivePlayer(id)` commits a new active player (the command effect and the user click path), also `desktopEventDispatch(tvSetCurrentChannel(item.source))` for the resolved item. TDD steps as in Task 1 (failing test on the reducer case first, then wire, then a component-level test asserting the dispatch fires on tune). Commit: `feat(playlist): TV publishes current channel slug for locked focus`.

---

### Task 8: RadioScanner tune command + published slug

**Files:**
- Modify: `src/Applications/RadioScanner/RadioScannerContext.ts`, `src/Applications/RadioScanner/RadioScanner.tsx`
- Modify: `src/Providers/Playlist/PlaylistProvider.tsx` (replace the `radio` FOCUS_DISPATCHERS no-op)
- Test: extend the RadioScanner test file + reducer test

**Interfaces:**
- Consumes: TV's command pattern as the template (`TVContext.ts:37-42, 104-105, 131-140`; consumer `TV.tsx:413-451`).
- Produces:
  - `radioTuneStation(station: string): ActionMessage` (`type: "ClassicyAppRadioScannerTuneStation"`) → writes `data.command = { seq, kind: "tune", station }` (monotonic seq, same `nextSeq` helper shape as TVContext).
  - `apps["RadioScanner.app"].data.activeStationSlug: string | null`, kept current on every station change.

Steps: (1) failing reducer test for the new action case; (2) implement in `RadioScannerContext.ts`; (3) failing component test: seed `data.command = { seq: 1, kind: "tune", station: "<slug>" }`, assert the station activates (find the station-button click handler in `RadioScanner.tsx` — the one-button-per-station playback path — and extract/reuse it; consume the command with a `lastCommandSeqRef` exactly like `TV.tsx:413-425`, retrying while the station list doesn't contain the slug yet); (4) publish `activeStationSlug` by adding the field to the existing `ClassicyAppRadioScannerSetState` dispatch (`RadioScanner.tsx:233`) and its reducer case; (5) in `PlaylistProvider.tsx` set `FOCUS_DISPATCHERS.radio = (dispatch, itemId) => dispatch(radioTuneStation(itemId))`; (6) full file tests green; commit `feat(playlist): RadioScanner remote tune command + published station slug`.

**Caution:** RadioScanner keeps `activeStation` in LOCAL `useState` and only pushes to the store — the command consumer must drive the same local path the button click uses (audio-unlock/gesture semantics included), not write the store directly.

---

### Task 9: News focus command + published open documents

**Files:**
- Create: `src/Applications/News/NewsContext.ts`
- Modify: `src/Applications/News/News.tsx` (~line 107 `openDocumentDetails`)
- Modify: `src/Providers/Playlist/PlaylistProvider.tsx` (replace the `news` no-op)
- Test: `src/Applications/News/NewsContext.test.ts` + extend the News component test

**Interfaces:**
- Produces:
  - `newsFocusItem(docId: number): ActionMessage` (`type: "ClassicyAppNewsFocusItem"`) → `data.command = { seq, kind: "focus", docId }`, handler registered under prefix `"ClassicyAppNews"` (TVContext template).
  - `apps["News.app"].data.openDocuments: number[]` mirroring the component's local `openDocuments` state (dispatch a `ClassicyAppNewsSetOpenDocuments` action whenever it changes).

Consumer in `News.tsx`: effect on `[command, items]`; consume the seq ONLY when an item with `id === docId` exists in `items` (retry-on-update, TV pattern), then call the existing `openDocumentDetails(docId)`. Note `openDocumentDetails` requires the per-article window to exist in `appWindows` — if the window isn't found, leave the seq unconsumed to retry. Commit: `feat(playlist): News remote focus command + published open documents`.

---

### Task 10: FlightTracker focus command + published callsign

**Files:**
- Create: `src/Applications/FlightTracker/flightTrackerCommands.ts` (new registry file — do NOT overload `flightMapSettings.ts`'s existing handler; register a distinct prefix `"ClassicyAppFlightTrackerRemote"`)
- Modify: `src/Applications/FlightTracker/FlightTracker.tsx` (~lines 330, 643 — the `multiSelected`/`onSelectFlight` selection path)
- Modify: `src/Providers/Playlist/PlaylistProvider.tsx` (replace the `flights` no-op)
- Test: `flightTrackerCommands.test.ts` + extend the FlightTracker test

**Interfaces:**
- Produces:
  - `flightTrackerFocusFlight(callsign: string): ActionMessage` (`type: "ClassicyAppFlightTrackerRemoteFocus"`) → `data.command = { seq, kind: "focus", callsign }`.
  - `apps["FlightTracker.app"].data.focusedFlight: string | null` — set whenever the selected flight changes (dispatch from the `onSelectFlight` path), cleared on deselect.

Consumer: effect on `[command, flightPositions]`; when a position with `flight === callsign` (case-insensitive) exists, invoke the same selection routine `onSelectFlight` uses and consume the seq; otherwise retry on next positions update. Commit: `feat(playlist): FlightTracker remote focus command + published callsign`.

---

### Task 11: Browser navigate command

**Files:**
- Modify: `src/Applications/Browser/BrowserContext.ts` (add command action to the existing `"ClassicyAppBrowser"` handler), `src/Applications/Browser/Browser.tsx` (~line 278 `useBrowserNavigation` destructure — `goTo` is in scope there)
- Modify: `src/Providers/Playlist/PlaylistProvider.tsx` (replace the `browser` no-op)
- Test: extend the Browser test file + BrowserContext reducer test

**Interfaces:**
- Produces: `browserNavigate(url: string): ActionMessage` (`type: "ClassicyAppBrowserNavigate"`) → `data.command = { seq, kind: "navigate", url }`. Consumer in `Browser.tsx`: effect on `[command]` after the navigation hook is initialized; per new seq, call `goTo(command.url)`. No retry condition needed (navigation needs no stream data); consume immediately. The Browser is a single persistent window — a later scheduled URL simply navigates it (spec decision).

Commit: `feat(playlist): Browser remote navigate command`.

---

### Task 12: E2E, docs, and rule amendments

**Files:**
- Create: `e2e/tests/playlist.spec.ts` (in `packages/frontend/e2e/tests/`)
- Modify: `packages/frontend/CLAUDE.md` (mental-model bullet + hard rule 2)
- Test: the e2e spec itself

E2E (route-intercepted — no live Directus dependency; follow `e2e/fixtures/index.ts` conventions; assert behavior/store, never Classicy menu UI — menu clicks are flaky):

```ts
// e2e/tests/playlist.spec.ts
import { expect, test } from "../fixtures";

const definition = {
	version: 1,
	mode: "annotate",
	entries: [
		{ kind: "app", appId: "TimeMachine.app", disabled: true },
		{ kind: "settings", appId: "TV.app", values: { captionsOn: true } },
	],
};

test("playlist disables an app and seeds settings", async ({ page }) => {
	await page.route("**/items/playlists/e2e-test", (route) =>
		route.fulfill({
			json: { data: { id: "e2e-test", title: "E2E", status: "published", definition } },
		}),
	);
	await page.goto("/?playlist=e2e-test");

	// Settings seeded into the store (assert via localStorage-persisted state).
	await expect
		.poll(async () =>
			page.evaluate(() => {
				const raw = localStorage.getItem("classicyDesktopState");
				if (!raw) return undefined;
				const s = JSON.parse(raw);
				return s?.System?.Manager?.Applications?.apps?.["TV.app"]?.data?.captionsOn;
			}),
		)
		.toBe(true);

	// Opening the disabled app (double-click its desktop icon) surfaces the dialog.
	await page.getByText("Time Machine", { exact: true }).dblclick();
	await expect(
		page.getByText("You don't have permission to open this app."),
	).toBeVisible();
});
```

CLAUDE.md amendments (`packages/frontend/CLAUDE.md`):
- Mental model, "One virtual clock, one writer" bullet: change to "…**`TimeMachine.tsx` and the Playlist engine (`src/Providers/Playlist/`) are the only writers, both via `setDateTimeFromUtc`**…".
- Hard rule 2: same amendment, plus a new bullet under "What this package does own": `src/Providers/Playlist/ — the teacher-playlist engine (see plans/2026-07-16-teacher-playlists-design.md); its runtime state is deliberately non-persisted.`

Steps: write spec → run `pnpm --filter @rt911/frontend exec playwright test e2e/tests/playlist.spec.ts` against a running dev server (`pnpm dev`; beware the stale-5173 trap — verify the dev server you hit is THIS worktree's) → fix → edit CLAUDE.md → full gate `pnpm build && pnpm lint && pnpm test` → commit `feat(playlist): e2e coverage + clock-writer rule amendment`.

---

### Task 13 (operator): Directus `playlists` collection

Not code — run against the Directus admin (needs an admin token; the collection is created ONCE). Known gotchas: the `definition` field MUST have `special: ["cast-json"]` (else reads 400 opaquely); schema-op bursts can wedge Directus introspection ("hit infinite loop") — run these serially and restart `rt911-api` if introspection wedges; log response bodies on failure.

- [ ] Create collection + fields:

```bash
DIRECTUS_URL=https://api-beta.911realtime.org
curl -sS -X POST "$DIRECTUS_URL/collections" \
  -H "Authorization: Bearer $DIRECTUS_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "collection": "playlists",
    "meta": { "icon": "queue_music", "note": "Teacher lesson playlists (frontend ?playlist=<id>)" },
    "schema": {},
    "fields": [
      { "field": "id", "type": "uuid", "meta": { "special": ["uuid"] }, "schema": { "is_primary_key": true } },
      { "field": "status", "type": "string", "meta": { "interface": "select-dropdown", "options": { "choices": [ {"text":"Published","value":"published"}, {"text":"Draft","value":"draft"} ] } }, "schema": { "default_value": "draft" } },
      { "field": "title", "type": "string", "meta": { "interface": "input" }, "schema": {} },
      { "field": "definition", "type": "json", "meta": { "special": ["cast-json"], "interface": "input-code", "options": { "language": "json" } }, "schema": {} }
    ]
  }' | tee /dev/stderr | grep -q '"collection":"playlists"'
```

- [ ] Grant anonymous (public role) read — same posture as `flight_positions`; mirror however that collection's public-read permission row is configured in this Directus instance (check it first: `GET /permissions?filter[collection][_eq]=flight_positions`), then create the equivalent row for `playlists` with `action: "read"`.
- [ ] Seed one real test playlist row (definition from the e2e fixture above) and verify anonymously: `curl -sS "$DIRECTUS_URL/items/playlists/<id>"` returns the row with `definition` as a JSON object (not a string — if it's a string, the `cast-json` special is missing).
- [ ] Verify end-to-end: open `https://<frontend>/?playlist=<id>` and confirm the Time Machine icon shows the permission dialog on open.

---

## Self-review notes (already applied)

- Spec coverage: media windows (T2/T6), restrict/annotate (T2), hidden-entirely (T6), app disable + dialog copy (T4), focus once/locked all four apps (T5/T7–T10), settings default/locked (T5), file opens (T5), jumps + single-writer amendment (T5/T12), browser open/close (T5/T11), no-persistence (T4 by construction), fail-open load errors (T4), Directus collection + cast-json (T13), auth seam isolation (T3 module comment).
- Type consistency: `isItemAvailable(app, itemId)` signature identical in Tasks 2/4/6; published-selection keys in Task 5 match what Tasks 7–10 produce; `FOCUS_DISPATCHERS` keys = `PlaylistApp ∪ {browser}`.
- Known judgment call (flag to reviewer, not a defect): app-gating is a reactive watcher (close-on-open) rather than action interception, because classicy's desktop-icon open path bypasses `ClassicyAppOpen` entirely; a one-frame window flash is possible and accepted. The e2e in Task 12 exercises exactly this path.
