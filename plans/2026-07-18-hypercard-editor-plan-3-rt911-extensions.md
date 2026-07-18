# HyperCard Editor — Plan 3 of 3: rt911 Extensions (Directus schemas + save provider)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rt911's 7 `directus*` plugin parts and the `setDateTime` command first-class citizens of the HyperCard editor (palette entries + typed inspector/builder forms), and give signed-in users server-side stack saving via a Directus `stacks` collection and an auth-gated save provider.

**Architecture:** Everything hangs off classicy's Plan-1/2 extension seams: `registerHyperCardPartEditorMeta`/`registerHyperCardCommandEditorMeta` for the editor forms, `registerHyperCardSaveProvider` for saving. The provider's auth gate crosses the React/module boundary the same way `setDateTime` crosses the reducer/clock boundary — a module-level holder updated by a tiny bridge component (the `HyperCardClockBridge` precedent). Server side reuses the deployed Teacher policy (playlist-auth precedent) with CRUD-own permissions on a new `stacks` collection.

**Tech Stack:** rt911 `packages/frontend` (Vite + React + TS + vitest + ESLint), classicy ≥ the `hypercard-editor` merge (local `main` at `4b76405`), Directus 12 at `https://api-beta.911realtime.org`.

## Global Constraints

- **Repo/branch:** rt911, branch `hypercard-editor-extensions` off `main` (Task 1 creates it). Frontend work only (`packages/frontend`), plus the Directus prod change in Task 2.
- **classicy is NOT yet published with the editor APIs.** All frontend tasks develop against the local build: run `pnpm use:local` from `packages/frontend` ONCE at branch start (Task 1) — it links `/home/robbiebyrd/classicy`. Do NOT run `pnpm use:published` or commit `pnpm-lock.yaml` churn mid-plan; the final task (6) switches back and gates the merge on the npm publish. The `.husky/pre-commit` classicy auto-bump is expected noise on every commit.
- **rt911 frontend conventions:** ESLint (not Biome) — `pnpm --filter @rt911/frontend exec eslint <files>`; tests `pnpm --filter @rt911/frontend exec vitest run <path>`; RTL test files need `afterEach(cleanup)` (no auto-cleanup in this repo); tabs per existing files.
- **Directus gotchas (hard-won):** `definition` json field MUST have the `cast-json` special or reads return strings; schema-op bursts can wedge introspection (restart rt911-api if "hit infinite loop"); always print response bodies; NEVER run parallel same-path requests to api-beta from the browser (mixed response bodies — serialize all REST loops); admin token comes from `sudo kubectl get secret video-grabber-secrets -n video-grabber -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d` and must never be written into any repo file.
- **Save-provider seam contract (from Plan 2):** providers must RETURN `{ok:false,error}` — never reject (a host `.catch` exists but is belt-and-braces); `meta.stackId` encodes `saved:<providerId>:<refId>` for provider-loaded stacks (the update-vs-create hook); `canSave()` is polled only on menu rebuild, so auth changes surface on the next edit action — accepted latency, document it; host runs `validateStack` on `load` results.
- **Auth seam:** components use `useAuth()` (`AuthContext.ts`: `{status: "loading"|"anonymous"|"signedIn", user: AuthUser|null, ...}`); auth state must NOT be persisted or duplicated — the bridge holder mirrors it in memory only.

## File Structure

```
packages/frontend/src/Applications/HyperCard/extensions/
  editorMetadata.ts              # Task 3 — part/command editor schemas (create)
  editorMetadata.test.ts         # Task 3
  stackProviderAuth.ts           # Task 4 — module-level auth holder + bridge (create)
  stackProviderAuth.test.tsx     # Task 4
  directusStackProvider.ts       # Task 5 — HyperCardSaveProvider impl (create)
  directusStackProvider.test.ts  # Task 5
  registerHyperCardExtensions.ts # Tasks 3+5 — call the new registrations (modify)
packages/frontend/src/Providers/Auth/
  stackApi.ts                    # Task 4 — Directus items/stacks CRUD (create)
  stackApi.test.ts               # Task 4
packages/frontend/src/
  Desktop.tsx                    # Task 5 — mount HyperCardStackAuthBridge (modify)
scripts (NOT committed; run from a scratch dir):
  stacks-apply.sh / stacks-verify.sh   # Task 2 — Directus collection + permissions
```

---

### Task 1: Branch + local classicy link + baseline

**Files:** none committed (environment setup).

- [ ] **Step 1: Branch and link**

```bash
cd /home/robbiebyrd/rt911 && git checkout -b hypercard-editor-extensions
cd packages/frontend && pnpm use:local
# sanity: the editor APIs must resolve from the local build
node -e "const c = require('classicy'); for (const k of ['registerHyperCardPartEditorMeta','registerHyperCardCommandEditorMeta','registerHyperCardSaveProvider']) { if (typeof c[k] !== 'function') throw new Error('missing ' + k) }; console.log('editor APIs: ok')"
```

Expected: `editor APIs: ok`. If `use:local` needs a fresh classicy build first: `cd /home/robbiebyrd/classicy && pnpm build:source`.

- [ ] **Step 2: Baseline the suite**

```bash
cd /home/robbiebyrd/rt911 && pnpm --filter @rt911/frontend exec vitest run 2>&1 | tail -3
pnpm --filter @rt911/frontend exec tsc -b 2>&1 | tail -3
```

Record the passing counts — later tasks must not regress them. If tsc fails against the local classicy types, STOP and report (the local build may be stale — rebuild classicy first).

---

### Task 2: Directus `stacks` collection + Teacher-policy CRUD-own permissions — **PROD CHANGE, controller/user checkpoint**

**Files:** two throwaway scripts in the session scratch dir (never committed).

**Interfaces:**
- Produces: collection `stacks` — fields `id` (integer PK auto), `name` (string, required), `definition` (json **with `special: ["cast-json"]`**), `user_created` (uuid, special `user-created`, hidden), `date_created`/`date_updated` (timestamps, specials `date-created`/`date-updated`); Teacher-policy permissions: create (fields `name,definition`), read (own: `{"user_created":{"_eq":"$CURRENT_USER"}}`, fields `*`), update (own, fields `name,definition`), delete (own). NO public/anonymous access. Later tasks rely on the REST shapes verified here.

- [ ] **Step 1: Apply script** — model on the playlist-auth `apply.sh` precedent (`plans/2026-07-16-playlist-auth-plan.md:60-110` — same `req()` helper, same idempotent have-checks). Key bodies:

```bash
TOKEN=$(sudo kubectl get secret video-grabber-secrets -n video-grabber -o jsonpath='{.data.DIRECTUS_API_TOKEN}' | base64 -d)
URL=https://api-beta.911realtime.org
# collection (skip if GET /collections/stacks succeeds):
req POST /collections '{
  "collection": "stacks",
  "meta": { "icon": "style", "note": "User-authored HyperCard stacks (editor saves)", "display_template": "{{name}}" },
  "schema": {},
  "fields": [
    { "field": "id", "type": "integer", "meta": {"hidden": true, "readonly": true}, "schema": {"is_primary_key": true, "has_auto_increment": true} },
    { "field": "name", "type": "string", "meta": {"interface": "input", "required": true}, "schema": {"is_nullable": false} },
    { "field": "definition", "type": "json", "meta": {"interface": "input-code", "special": ["cast-json"]}, "schema": {} }
  ]
}'
# then the three system fields via POST /fields/stacks exactly as the playlist-auth
# precedent did for playlists (user-created / date-created / date-updated specials)
# then four POST /permissions rows against the EXISTING Teacher policy id
# (GET /policies?filter[name][_eq]=Teacher) with OWN='{"user_created":{"_eq":"$CURRENT_USER"}}':
#   create: fields ["name","definition"]
#   read:   fields ["*"], permissions OWN
#   update: fields ["name","definition"], permissions OWN
#   delete: fields ["*"], permissions OWN
```

- [ ] **Step 2: Verify script** — mirror the playlist-auth `verify.sh` enforcement matrix (same mkuser/login/trap-cleanup harness, `plans/2026-07-16-playlist-auth-plan.md:112-150`): two throwaway Teacher users; assert A creates `{"name":"Verify Stack","definition":{"name":"Verify Stack","cards":[{"id":"c1"}]}}` → 200 with `definition` returned as an OBJECT (cast-json check: `type(d['definition']) is dict`); A lists → sees own row; B lists → does NOT see A's row; B PATCH/DELETE A's row → 403; anonymous GET → 401/403; A DELETE own → 204. Cleanup deletes users + rows even on failure.

- [ ] **Step 3: Run apply then verify; paste both outputs into the SDD ledger.** If introspection wedges ("hit infinite loop"), restart the api pod (`sudo kubectl rollout restart deployment rt911-api -n <its namespace>` — find it with `sudo kubectl get deploy -A | grep -i directus`) and re-run verify only.

---

### Task 3: Editor metadata for the 7 parts + `setDateTime` command

**Files:**
- Create: `packages/frontend/src/Applications/HyperCard/extensions/editorMetadata.ts`
- Test: `packages/frontend/src/Applications/HyperCard/extensions/editorMetadata.test.ts`
- Modify: `packages/frontend/src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts` (one call)

**Interfaces:**
- Consumes: classicy's `registerHyperCardPartEditorMeta(type, meta)`, `registerHyperCardCommandEditorMeta(name, meta)`, `getHyperCardPartEditorMeta`, `getHyperCardCommandEditorMeta`, types `HyperCardPartEditorMeta`, `HCOptionField`.
- Produces: `registerHyperCardEditorMetadata(): void` (idempotent by registry semantics), called from `registerHyperCardExtensions()` after the part registrations.
- Option schemas are derived from what each part component actually reads (verified against source; keys must match EXACTLY):
  - `directusAudio` "Audio Clip" [200, 96]: `itemId` text (expression-capable), `url` text.
  - `directusVideo` "TV Video" [320, 180]: `channelId` number, `url` text, `start` text, `end` text, `autoPlay` checkbox, `controls` checkbox (default true), `loop` checkbox, `captions` checkbox, `overlay` checkbox.
  - `directusMultiview` "TV Multiview" [404, 236]: `audio` text ("solo" | "all" | "mute"), `columns` number, `videos` json.
  - `directusNews` "News Item" [280, 160]: `itemId` text, `showImage` checkbox (default true), `showDate` checkbox (default true).
  - `directusPager` "Pager Message" [280, 120]: `itemId` text.
  - `directusWeatherStation` "Weather Station" [260, 300]: `station` text (ICAO id).
  - `directusFlightMap` "Flight Map" [404, 300]: `flight` text, `notablesOnly` checkbox, `darkMap` checkbox, `mapStyle` text, `pinColor` text, `notablePinColor` text, `observerPinColor` text, `radarSweep` checkbox, `trailMultiplier` number.
  - Command `setDateTime` "Set Date/Time": fields `to` text ("UTC datetime, e.g. 2001-09-11T12:46:00Z"), `toVar` text ("…or read it from this stack variable").

- [ ] **Step 1: Failing test** — `editorMetadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	getHyperCardCommandEditorMeta,
	getHyperCardPartEditorMeta,
} from "classicy";
import { registerHyperCardEditorMetadata } from "./editorMetadata";

describe("registerHyperCardEditorMetadata", () => {
	it("registers editor metadata for all seven directus parts", () => {
		registerHyperCardEditorMetadata();
		for (const type of [
			"directusAudio",
			"directusVideo",
			"directusMultiview",
			"directusNews",
			"directusPager",
			"directusWeatherStation",
			"directusFlightMap",
		]) {
			const meta = getHyperCardPartEditorMeta(type);
			expect(meta, type).toBeDefined();
			expect(meta?.label.length, type).toBeGreaterThan(0);
			expect(meta?.defaultSize?.[0], type).toBeGreaterThan(0);
			expect(meta?.optionsSchema?.length, type).toBeGreaterThan(0);
		}
	});

	it("schema keys match what the part components read", () => {
		registerHyperCardEditorMetadata();
		const keys = (type: string) =>
			getHyperCardPartEditorMeta(type)?.optionsSchema?.map((f) => f.key);
		expect(keys("directusVideo")).toEqual([
			"channelId", "url", "start", "end", "autoPlay", "controls", "loop", "captions", "overlay",
		]);
		expect(keys("directusNews")).toEqual(["itemId", "showImage", "showDate"]);
		expect(keys("directusFlightMap")).toContain("trailMultiplier");
		expect(
			getHyperCardPartEditorMeta("directusMultiview")?.optionsSchema?.find(
				(f) => f.key === "videos",
			)?.kind,
		).toBe("json");
	});

	it("registers the setDateTime command builder fields", () => {
		registerHyperCardEditorMetadata();
		const meta = getHyperCardCommandEditorMeta("setDateTime");
		expect(meta?.fields.map((f) => f.key)).toEqual(["to", "toVar"]);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @rt911/frontend exec vitest run src/Applications/HyperCard/extensions/editorMetadata.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `editorMetadata.ts`**

```ts
/**
 * Editor metadata for rt911's HyperCard extensions: how the stack editor's
 * palette, inspector, and script builder present the directus* plugin parts
 * and the setDateTime command. Keys mirror EXACTLY what each part component
 * reads from `options` — see the doc comment atop each Directus*Part.tsx.
 */
import {
	type HCOptionField,
	registerHyperCardCommandEditorMeta,
	registerHyperCardPartEditorMeta,
} from "classicy";

const text = (key: string, label: string): HCOptionField => ({ key, label, kind: "text" });
const num = (key: string, label: string): HCOptionField => ({ key, label, kind: "number" });
const check = (key: string, label: string, dflt?: boolean): HCOptionField => ({
	key,
	label,
	kind: "checkbox",
	...(dflt === undefined ? {} : { default: dflt }),
});

export function registerHyperCardEditorMetadata(): void {
	registerHyperCardPartEditorMeta("directusAudio", {
		label: "Audio Clip",
		defaultSize: [200, 96],
		optionsSchema: [
			text("itemId", "Clip id (or variable)"),
			text("url", "Direct audio URL"),
		],
	});
	registerHyperCardPartEditorMeta("directusVideo", {
		label: "TV Video",
		defaultSize: [320, 180],
		defaultOptions: { controls: true },
		optionsSchema: [
			num("channelId", "TV channel id"),
			text("url", "Direct HLS URL"),
			text("start", "Start (offset or wall clock)"),
			text("end", "End (offset or wall clock)"),
			check("autoPlay", "Auto-play"),
			check("controls", "Controls", true),
			check("loop", "Loop"),
			check("captions", "Captions"),
			check("overlay", "Channel overlay"),
		],
	});
	registerHyperCardPartEditorMeta("directusMultiview", {
		label: "TV Multiview",
		defaultSize: [404, 236],
		defaultOptions: { audio: "solo", videos: [] },
		optionsSchema: [
			text("audio", "Audio (solo | all | mute)"),
			num("columns", "Columns (blank = auto)"),
			{ key: "videos", label: "Videos", kind: "json" },
		],
	});
	registerHyperCardPartEditorMeta("directusNews", {
		label: "News Item",
		defaultSize: [280, 160],
		optionsSchema: [
			text("itemId", "News item id (or variable)"),
			check("showImage", "Show image", true),
			check("showDate", "Show date", true),
		],
	});
	registerHyperCardPartEditorMeta("directusPager", {
		label: "Pager Message",
		defaultSize: [280, 120],
		optionsSchema: [text("itemId", "Pager item id (or variable)")],
	});
	registerHyperCardPartEditorMeta("directusWeatherStation", {
		label: "Weather Station",
		defaultSize: [260, 300],
		optionsSchema: [text("station", "ICAO station id")],
	});
	registerHyperCardPartEditorMeta("directusFlightMap", {
		label: "Flight Map",
		defaultSize: [404, 300],
		optionsSchema: [
			text("flight", "Flight (or variable)"),
			check("notablesOnly", "Notable flights only"),
			check("darkMap", "Dark map"),
			text("mapStyle", "Map style"),
			text("pinColor", "Pin color"),
			text("notablePinColor", "Notable pin color"),
			text("observerPinColor", "Observer pin color"),
			check("radarSweep", "Radar sweep"),
			num("trailMultiplier", "Trail multiplier"),
		],
	});

	registerHyperCardCommandEditorMeta("setDateTime", {
		label: "Set Date/Time",
		fields: [
			text("to", "UTC datetime, e.g. 2001-09-11T12:46:00Z"),
			text("toVar", "…or read it from this stack variable"),
		],
	});
}
```

- [ ] **Step 4: Wire into the hub** — in `registerHyperCardExtensions.ts`, import and call after the `registerHyperCardPart` block:

```ts
import { registerHyperCardEditorMetadata } from "./editorMetadata";
...
	// Editor metadata: palette entries + typed inspector/builder forms for the
	// parts and command registered above.
	registerHyperCardEditorMetadata();
```

- [ ] **Step 5: Run to verify pass**, then lint + commit:

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/HyperCard/extensions/
pnpm --filter @rt911/frontend exec eslint src/Applications/HyperCard/extensions/editorMetadata.ts src/Applications/HyperCard/extensions/editorMetadata.test.ts src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts
git add packages/frontend/src/Applications/HyperCard/extensions/
git commit -m "feat(hypercard): editor metadata for directus parts and setDateTime command"
```

---

### Task 4: `stackApi.ts` + the auth holder/bridge

**Files:**
- Create: `packages/frontend/src/Providers/Auth/stackApi.ts` + `stackApi.test.ts`
- Create: `packages/frontend/src/Applications/HyperCard/extensions/stackProviderAuth.ts` + `stackProviderAuth.test.tsx`

**Interfaces:**
- Consumes: `DIRECTUS_URL` from `../Playlist/loadPlaylist`; `AuthRequiredError`, `ForbiddenError` from `./authApi`; classicy's `validateStack`; `useAuth` from `./AuthContext` (bridge only).
- Produces:
  - `interface StackSummary { id: number; name: string; date_updated: string | null; user_created: string | null }`
  - `interface StackRecord extends StackSummary { definition: unknown }`
  - `listMyStacks(fetchFn?)`: GET `items/stacks?fields=id,name,date_updated,user_created&sort=-date_updated&limit=200` — permissions are own-only, so no client-side filter.
  - `getStack(id: number, fetchFn?)`, `createStack(name, definition, fetchFn?)`, `updateStack(id, patch: {name?, definition?}, fetchFn?)`, `deleteStack(id, fetchFn?)` — all `credentials: "include"`, same `handle`/`serverMessage` 401→AuthRequiredError / 403→ForbiddenError mapping as playlistApi (copy those two helpers into stackApi rather than exporting them from playlistApi — they're private there; a 10-line duplication beats widening playlistApi's surface).
  - `assertValidStackDefinition(definition: unknown): void` — throws with the first `validateStack` error message; called by create/update.
  - `setStackProviderAuth(signedIn: boolean): void` / `isStackProviderSignedIn(): boolean` — module-level holder in `stackProviderAuth.ts`.
  - `HyperCardStackAuthBridge: FC` — renders null; `useEffect` mirrors `useAuth().status === "signedIn"` into the holder (and resets to false on unmount). Same bridge idiom as `HyperCardClockBridge`.

- [ ] **Step 1: Failing tests.** `stackApi.test.ts` (mocked `fetchFn`, no RTL needed):

```ts
import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError } from "./authApi";
import {
	assertValidStackDefinition,
	createStack,
	deleteStack,
	getStack,
	listMyStacks,
	updateStack,
} from "./stackApi";

const VALID_DEF = { name: "My Stack", cards: [{ id: "c1" }] };

function okFetch(data: unknown) {
	return vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
}

describe("stackApi", () => {
	it("listMyStacks hits items/stacks with own-only fields and returns rows", async () => {
		const rows = [{ id: 1, name: "A", date_updated: null, user_created: "u1" }];
		const fetchFn = okFetch(rows);
		await expect(listMyStacks(fetchFn)).resolves.toEqual(rows);
		const url = String(fetchFn.mock.calls[0][0]);
		expect(url).toContain("/items/stacks?fields=id,name,date_updated,user_created");
		expect(fetchFn.mock.calls[0][1]).toMatchObject({ credentials: "include" });
	});

	it("createStack validates the definition and POSTs name+definition", async () => {
		const fetchFn = okFetch({ id: 2, name: "My Stack", definition: VALID_DEF });
		await createStack("My Stack", VALID_DEF, fetchFn);
		const [, init] = fetchFn.mock.calls[0];
		expect(init).toMatchObject({ method: "POST", credentials: "include" });
		expect(JSON.parse(String(init?.body))).toEqual({ name: "My Stack", definition: VALID_DEF });
		await expect(createStack("Bad", { name: "", cards: [] }, fetchFn)).rejects.toThrow(/non-empty/);
	});

	it("updateStack PATCHes only the given keys; deleteStack DELETEs", async () => {
		const fetchFn = okFetch({ id: 3, name: "N", definition: VALID_DEF });
		await updateStack(3, { definition: VALID_DEF }, fetchFn);
		expect(fetchFn.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
		const del = vi.fn(async () => new Response(null, { status: 204 }));
		await expect(deleteStack(3, del)).resolves.toBeUndefined();
	});

	it("maps 401 to AuthRequiredError with the server message", async () => {
		const fetchFn = vi.fn(async () =>
			new Response(JSON.stringify({ errors: [{ message: "expired" }] }), { status: 401 }),
		);
		await expect(getStack(9, fetchFn)).rejects.toBeInstanceOf(AuthRequiredError);
	});

	it("assertValidStackDefinition surfaces the first validator error", () => {
		expect(() => assertValidStackDefinition({ cards: [] })).toThrow();
		expect(() => assertValidStackDefinition(VALID_DEF)).not.toThrow();
	});
});
```

`stackProviderAuth.test.tsx` (RTL — remember `afterEach(cleanup)`):

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthContext } from "../../../Providers/Auth/AuthContext";
import {
	HyperCardStackAuthBridge,
	isStackProviderSignedIn,
	setStackProviderAuth,
} from "./stackProviderAuth";

afterEach(cleanup);
afterEach(() => setStackProviderAuth(false));

const authValue = (status: "signedIn" | "anonymous") => ({
	status,
	user: null,
	signInWithEmail: async () => {},
	signInWithProvider: () => {},
	signOut: async () => {},
	refresh: async () => {},
	register: async () => {},
});

describe("HyperCardStackAuthBridge", () => {
	it("mirrors signed-in status into the module holder and resets on unmount", () => {
		expect(isStackProviderSignedIn()).toBe(false);
		const { rerender, unmount } = render(
			<AuthContext.Provider value={authValue("signedIn")}>
				<HyperCardStackAuthBridge />
			</AuthContext.Provider>,
		);
		expect(isStackProviderSignedIn()).toBe(true);
		rerender(
			<AuthContext.Provider value={authValue("anonymous")}>
				<HyperCardStackAuthBridge />
			</AuthContext.Provider>,
		);
		expect(isStackProviderSignedIn()).toBe(false);
		unmount();
		expect(isStackProviderSignedIn()).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure** (both files: modules missing).

- [ ] **Step 3: Implement `stackApi.ts`**

```ts
// HyperCard editor's server-save seam. Every request rides the signed-in
// user's Directus session cookie; the Teacher policy's permissions are
// own-rows-only, so list needs no client-side filter (unlike playlistApi).
import { validateStack } from "classicy";
import { DIRECTUS_URL } from "../Playlist/loadPlaylist";
import { AuthRequiredError, ForbiddenError } from "./authApi";

export interface StackSummary {
	id: number;
	name: string;
	date_updated: string | null;
	user_created: string | null;
}

export interface StackRecord extends StackSummary {
	definition: unknown;
}

interface DirectusErrorBody {
	errors?: { message?: unknown }[];
}

async function serverMessage(res: Response, fallback: string): Promise<string> {
	try {
		const body = (await res.json()) as DirectusErrorBody;
		const message = body.errors?.[0]?.message;
		return typeof message === "string" ? message : fallback;
	} catch {
		return fallback;
	}
}

async function handle<T>(res: Response, fallback: string): Promise<T> {
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, fallback));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, fallback));
	if (!res.ok) throw new Error(await serverMessage(res, fallback));
	const body = (await res.json()) as { data: T };
	return body.data;
}

/** Throws with the first structural error when the definition isn't a valid stack. */
export function assertValidStackDefinition(definition: unknown): void {
	const result = validateStack(definition);
	if ("errors" in result) throw new Error(result.errors[0]);
}

const LIST_FIELDS = "id,name,date_updated,user_created";

export async function listMyStacks(fetchFn: typeof fetch = fetch): Promise<StackSummary[]> {
	const res = await fetchFn(
		`${DIRECTUS_URL}/items/stacks?fields=${LIST_FIELDS}&sort=-date_updated&limit=200`,
		{ credentials: "include" },
	);
	return handle<StackSummary[]>(res, "Failed to list stacks");
}

export async function getStack(id: number, fetchFn: typeof fetch = fetch): Promise<StackRecord> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, { credentials: "include" });
	return handle<StackRecord>(res, "Failed to load stack");
}

export async function createStack(
	name: string,
	definition: unknown,
	fetchFn: typeof fetch = fetch,
): Promise<StackRecord> {
	assertValidStackDefinition(definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, definition }),
	});
	return handle<StackRecord>(res, "Failed to save stack");
}

export async function updateStack(
	id: number,
	patch: { name?: string; definition?: unknown },
	fetchFn: typeof fetch = fetch,
): Promise<StackRecord> {
	if (patch.definition !== undefined) assertValidStackDefinition(patch.definition);
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	return handle<StackRecord>(res, "Failed to update stack");
}

export async function deleteStack(id: number, fetchFn: typeof fetch = fetch): Promise<void> {
	const res = await fetchFn(`${DIRECTUS_URL}/items/stacks/${id}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (res.status === 401) throw new AuthRequiredError(await serverMessage(res, "Failed to delete stack"));
	if (res.status === 403) throw new ForbiddenError(await serverMessage(res, "Failed to delete stack"));
	if (!res.ok) throw new Error(await serverMessage(res, "Failed to delete stack"));
}
```

- [ ] **Step 4: Implement `stackProviderAuth.ts`**

```tsx
/**
 * Module-level auth mirror for the Directus stack save provider. classicy's
 * save-provider registry lives outside React, but auth state lives in
 * AuthContext — this bridge (the HyperCardClockBridge idiom) mirrors the
 * signed-in flag into module scope so the provider's canSave() can read it.
 * In-memory only; never persisted.
 */
import { type FC, useEffect } from "react";
import { useAuth } from "../../../Providers/Auth/AuthContext";

let signedIn = false;

export function setStackProviderAuth(value: boolean): void {
	signedIn = value;
}

export function isStackProviderSignedIn(): boolean {
	return signedIn;
}

export const HyperCardStackAuthBridge: FC = () => {
	const { status } = useAuth();
	useEffect(() => {
		setStackProviderAuth(status === "signedIn");
		return () => setStackProviderAuth(false);
	}, [status]);
	return null;
};
```

- [ ] **Step 5: Run to verify pass**, then lint + commit:

```bash
pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/stackApi.test.ts src/Applications/HyperCard/extensions/stackProviderAuth.test.tsx
pnpm --filter @rt911/frontend exec eslint packages/frontend/src/Providers/Auth/stackApi.ts packages/frontend/src/Applications/HyperCard/extensions/stackProviderAuth.ts 2>/dev/null || pnpm --filter @rt911/frontend exec eslint src/Providers/Auth/stackApi.ts src/Applications/HyperCard/extensions/stackProviderAuth.ts
git add packages/frontend/src/Providers/Auth/stackApi.ts packages/frontend/src/Providers/Auth/stackApi.test.ts packages/frontend/src/Applications/HyperCard/extensions/stackProviderAuth.ts packages/frontend/src/Applications/HyperCard/extensions/stackProviderAuth.test.tsx
git commit -m "feat(hypercard): stackApi CRUD seam and stack-provider auth bridge"
```

---

### Task 5: `DirectusStackSaveProvider` + wiring

**Files:**
- Create: `packages/frontend/src/Applications/HyperCard/extensions/directusStackProvider.ts` + `directusStackProvider.test.ts`
- Modify: `packages/frontend/src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts` (register the provider)
- Modify: `packages/frontend/src/Desktop.tsx` (mount `<HyperCardStackAuthBridge />` beside `HyperCardClockBridge`)

**Interfaces:**
- Consumes: classicy's `registerHyperCardSaveProvider`, types `HyperCardSaveProvider`, `HCSavedStackRef`, `HCStack`; Task 4's stackApi + holder.
- Produces: `directusStackSaveProvider: HyperCardSaveProvider` and `registerDirectusStackProvider(): void`:
  - `id: "directus"`, `label: "911realtime"`.
  - `canSave: () => isStackProviderSignedIn()`.
  - `save(stack, meta)`: if `meta.stackId` matches `/^saved:directus:(\d+)$/` → `updateStack(id, { name: stack.name, definition: stack })`, else `createStack(stack.name, stack)`. Wrap EVERYTHING in try/catch and return `{ok:false, error: message}` on any throw — the provider must NEVER reject (Plan-2 seam contract). Success → `{ok:true}`.
  - `list()`: `listMyStacks()` mapped to `HCSavedStackRef[]` — `{ id: String(row.id), name: row.name, updatedAt: row.date_updated ?? undefined }`. (May reject — the host renders list rejections inline; that's the sanctioned path for list.)
  - `load(ref)`: `getStack(Number(ref.id))` → return `record.definition as HCStack` (host runs validateStack).

- [ ] **Step 1: Failing test** — `directusStackProvider.test.ts` (mock the stackApi module):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../Providers/Auth/stackApi", () => ({
	createStack: vi.fn(),
	updateStack: vi.fn(),
	listMyStacks: vi.fn(),
	getStack: vi.fn(),
}));

import { createStack, getStack, listMyStacks, updateStack } from "../../../Providers/Auth/stackApi";
import { directusStackSaveProvider } from "./directusStackProvider";
import { setStackProviderAuth } from "./stackProviderAuth";

const VALID = { name: "My Stack", cards: [{ id: "c1" }] };

beforeEach(() => {
	vi.clearAllMocks();
	setStackProviderAuth(false);
});

describe("directusStackSaveProvider", () => {
	it("canSave mirrors the auth holder", () => {
		expect(directusStackSaveProvider.canSave()).toBe(false);
		setStackProviderAuth(true);
		expect(directusStackSaveProvider.canSave()).toBe(true);
	});

	it("save creates for non-provider stackIds and updates for saved:directus ids", async () => {
		vi.mocked(createStack).mockResolvedValue({ id: 7, name: "My Stack", definition: VALID, date_updated: null, user_created: "u" });
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "getting-started" }),
		).resolves.toEqual({ ok: true });
		expect(createStack).toHaveBeenCalledWith("My Stack", VALID);

		vi.mocked(updateStack).mockResolvedValue({ id: 7, name: "My Stack", definition: VALID, date_updated: null, user_created: "u" });
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "saved:directus:7" }),
		).resolves.toEqual({ ok: true });
		expect(updateStack).toHaveBeenCalledWith(7, { name: "My Stack", definition: VALID });
	});

	it("save returns {ok:false} instead of rejecting when the API throws", async () => {
		vi.mocked(createStack).mockRejectedValue(new Error("session expired"));
		await expect(
			directusStackSaveProvider.save(VALID as never, { stackId: "x" }),
		).resolves.toEqual({ ok: false, error: "session expired" });
	});

	it("list maps rows to refs and load returns the definition", async () => {
		vi.mocked(listMyStacks).mockResolvedValue([
			{ id: 7, name: "A", date_updated: "2026-07-18T00:00:00Z", user_created: "u" },
		]);
		await expect(directusStackSaveProvider.list?.()).resolves.toEqual([
			{ id: "7", name: "A", updatedAt: "2026-07-18T00:00:00Z" },
		]);
		vi.mocked(getStack).mockResolvedValue({ id: 7, name: "A", definition: VALID, date_updated: null, user_created: "u" });
		await expect(
			directusStackSaveProvider.load?.({ id: "7", name: "A" }),
		).resolves.toEqual(VALID);
	});
});
```

- [ ] **Step 2: Run to verify failure**, then implement `directusStackProvider.ts`:

```ts
/**
 * The Directus-backed HyperCard save destination: signed-in users save stacks
 * to the `stacks` collection (own rows only) and reopen them via File → Open
 * Saved Stack. Contract notes (classicy save-provider seam): save() must
 * RESOLVE {ok:false} on failure — never reject; meta.stackId of
 * "saved:directus:<id>" means the open stack came from this provider, so save
 * updates that row instead of creating a new one.
 */
import type { HCSavedStackRef, HCStack, HyperCardSaveProvider } from "classicy";
import { registerHyperCardSaveProvider } from "classicy";
import {
	createStack,
	getStack,
	listMyStacks,
	updateStack,
} from "../../../Providers/Auth/stackApi";
import { isStackProviderSignedIn } from "./stackProviderAuth";

const SAVED_ID = /^saved:directus:(\d+)$/;

export const directusStackSaveProvider: HyperCardSaveProvider = {
	id: "directus",
	label: "911realtime",
	canSave: () => isStackProviderSignedIn(),
	save: async (stack: HCStack, meta: { stackId: string }) => {
		try {
			const match = SAVED_ID.exec(meta.stackId);
			if (match) {
				await updateStack(Number(match[1]), { name: stack.name, definition: stack });
			} else {
				await createStack(stack.name, stack);
			}
			return { ok: true } as const;
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			} as const;
		}
	},
	list: async (): Promise<HCSavedStackRef[]> => {
		const rows = await listMyStacks();
		return rows.map((row) => ({
			id: String(row.id),
			name: row.name,
			updatedAt: row.date_updated ?? undefined,
		}));
	},
	load: async (ref: HCSavedStackRef): Promise<HCStack> => {
		const record = await getStack(Number(ref.id));
		return record.definition as HCStack;
	},
};

export function registerDirectusStackProvider(): void {
	registerHyperCardSaveProvider(directusStackSaveProvider);
}
```

- [ ] **Step 3: Wire.** In `registerHyperCardExtensions.ts`: import + call `registerDirectusStackProvider();` after `registerHyperCardEditorMetadata();`. In `Desktop.tsx`: import `HyperCardStackAuthBridge` from `./Applications/HyperCard/extensions/stackProviderAuth` and render `<HyperCardStackAuthBridge />` directly beside the existing `<HyperCardClockBridge />` (it must sit INSIDE AuthProvider — verify the provider nesting in `app.tsx`/`Desktop.tsx` and place it accordingly; if `Desktop.tsx` mounts outside AuthProvider, mount the bridge where `PlaylistEditor`'s auth-consuming components live instead, and disclose the placement).

- [ ] **Step 4: Run to verify pass** + the full frontend suite + tsc, then lint + commit:

```bash
pnpm --filter @rt911/frontend exec vitest run
pnpm --filter @rt911/frontend exec tsc -b
git add packages/frontend/src/Applications/HyperCard/extensions/ packages/frontend/src/Desktop.tsx
git commit -m "feat(hypercard): Directus stack save provider, auth bridge mount, extension wiring"
```

---

### Task 6: End-to-end verification + merge gating

**Files:** none new (verification; small fixes as surfaced).

- [ ] **Step 1: Live browser pass against local classicy** (controller-driven; `pnpm dev` from repo root, note the port). Script:
1. Signed OUT: HyperCard → open Getting Started → Edit Stack → palette lists the 7 Directus parts by label ("TV Video", "Flight Map", …) after the 10 built-ins; select the `tvEmbed` part on the TV card → inspector shows typed fields (channelId number, autoPlay checkbox…); File menu has "Save a Copy…" but NOT "Save to 911realtime" (canSave false). "Open Saved Stack…" DOES appear (the provider is registered with `list`, and that item isn't auth-gated) — open it and verify the window shows the 401 list rejection as an inline error label rather than crashing; this is the sanctioned behavior.
2. Sign in (Account app) with a Teacher-role account → make any edit → File now shows "Save to 911realtime" → save → Directus row appears (`curl` as the teacher or check via admin token). Dirty marker clears.
3. File → Open Saved Stack… → the saved row lists → Open → stack opens with stackId `saved:directus:<id>`; edit → Save to 911realtime → row UPDATED (same id, new date_updated), not duplicated.
4. Script builder: add a `setDateTime` action to a button — the builder shows the "Set Date/Time" label with `to`/`toVar` fields; Browse → click → the desktop clock seeks (clock bridge fires).
5. Sign out → "Save to 911realtime" disappears after the next edit action (accepted menu-rebuild latency; verify it's gone after e.g. selecting a part).

- [ ] **Step 2: Fix anything surfaced** (failing test first where feasible; commit each fix).

- [ ] **Step 3: Merge gating — publish dependency.** This branch requires classicy ≥ the editor merge. Sequence (user actions in brackets):
1. [User] push classicy `main` → CI version-bumps + publishes to npm.
2. `cd packages/frontend && pnpm use:published && pnpm install` → verify `node -e` API check from Task 1 passes against the published version; run the full suite + `tsc -b` again.
3. Commit the lockfile state, push the branch, open a PR (CI must be green — it builds against published classicy), or land per the repo's usual flow.
Until step 1 happens, the branch stays local with `use:local` — do NOT merge or push it to CI beforehand (tsc would fail on the missing APIs).
