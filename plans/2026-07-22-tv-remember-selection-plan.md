# TV Remember Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the TV app's single-view active channel and MultiView grid selection (plus per-channel mute/volume) by `source` slug, and restore them on reload by resolving slugs back to live item ids.

**Architecture:** Translate at the persistence boundary. Runtime React state stays keyed by numeric MediaItem id (video elements are id-keyed). The store (`apps["TV.app"].data`) holds channel *identity* as `source` slugs. A one-shot restore effect resolves persisted slugs → current item ids once the stream's `items` first arrive.

**Tech Stack:** Vite + React + TypeScript, Vitest + @testing-library/react, the external `classicy` store (ClassicyState → localStorage snapshot).

## Global Constraints

- Runtime state (`selectedPlayers`, `mutedGridPlayers`, `gridPlayerVolumes`, `activePlayer`) stays keyed by numeric item id. Only what is written to / read from the store changes to slugs.
- Persisted fields live under `state.System.Manager.Applications.apps["TV.app"].data`.
- The single-view slug (`currentChannel`) is **already** written by the effect at `TV.tsx:208` — do not add a second writer for it.
- No new WebSocket/wire traffic; this is client-side ClassicyState only.
- Follow the existing test-mock idioms: `mockAppData.value` seeds `TV.app.data`, `mockItems.value` overrides `useMediaStream().items`, `useAppManagerDispatch` returns a captured `dispatch`.
- Reference spec: `plans/2026-07-22-tv-remember-selection-design.md`.

---

## File structure

- `packages/frontend/src/Applications/TV/TVContext.ts` — the reducer case `ClassicyAppTVSetGridState` writes the slug fields.
- `packages/frontend/src/Applications/TV/TVContext.test.ts` — reducer unit tests for the slug fields.
- `packages/frontend/src/Applications/TV/TV.tsx` — write side (`persistGridState` maps id→slug), restore side (new one-shot effect), and the three grid `useState` initializers.
- `packages/frontend/src/Applications/TV/TV.reorder.test.tsx` — update the one assertion that inspects the id-based `selectedPlayers` payload.
- `packages/frontend/src/Applications/TV/TV.embed.test.tsx` — update the one seed that injects id-based `selectedPlayers`, and add the restore test.

---

## Task 1: Reducer persists slug-based grid fields

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TVContext.ts:137-145` (the `ClassicyAppTVSetGridState` case)
- Test: `packages/frontend/src/Applications/TV/TVContext.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClassicyAppTVSetGridState` action now carries `{ multiSelectMode: boolean, selectedChannels: string[], mutedChannels: string[], channelVolumes: Record<string, number> }` and writes those keys into `apps["TV.app"].data`. Task 2 dispatches this shape.

- [ ] **Step 1: Write the failing test**

Add to `TVContext.test.ts` (new `describe` block at end of file):

```ts
describe("classicyTVEventHandler — grid selection (slug-based)", () => {
	it("persists selectedChannels, mutedChannels and channelVolumes", () => {
		const out = classicyTVEventHandler(storeWithApp(), {
			type: "ClassicyAppTVSetGridState",
			multiSelectMode: true,
			selectedChannels: ["WABC", "WNBC"],
			mutedChannels: ["WNBC"],
			channelVolumes: { WABC: 0.5 },
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({
			multiSelectMode: true,
			selectedChannels: ["WABC", "WNBC"],
			mutedChannels: ["WNBC"],
			channelVolumes: { WABC: 0.5 },
		});
	});

	it("preserves unrelated fields when writing grid state", () => {
		const out = classicyTVEventHandler(storeWithApp({ currentChannel: "CNN" }), {
			type: "ClassicyAppTVSetGridState",
			multiSelectMode: false,
			selectedChannels: [],
			mutedChannels: [],
			channelVolumes: {},
		});
		expect(
			out.System.Manager.Applications.apps["TV.app"].data,
		).toMatchObject({ currentChannel: "CNN", multiSelectMode: false, selectedChannels: [] });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts -t "slug-based"`
Expected: FAIL — the reducer still writes `selectedPlayers`/`mutedGridPlayers`/`gridPlayerVolumes`, so `selectedChannels` etc. are absent from `data`.

- [ ] **Step 3: Write minimal implementation**

In `TVContext.ts`, replace the `ClassicyAppTVSetGridState` case body (lines 137-145):

```ts
		case "ClassicyAppTVSetGridState":
			apps[appId].data = {
				...appData,
				multiSelectMode: action.multiSelectMode,
				selectedChannels: action.selectedChannels,
				mutedChannels: action.mutedChannels,
				channelVolumes: action.channelVolumes,
			};
			return ds;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts`
Expected: PASS (all existing cases plus the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TVContext.ts packages/frontend/src/Applications/TV/TVContext.test.ts
git commit -m "feat(tv): persist grid selection as source slugs in the reducer"
```

---

## Task 2: Write side — `persistGridState` maps live ids → slugs

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TV.tsx:494-502` (`persistGridState`)
- Test: `packages/frontend/src/Applications/TV/TV.reorder.test.tsx:154-160`

**Interfaces:**
- Consumes: `itemsRef` (`useRef` of the live `items`, defined at `TV.tsx:266-267`), runtime state `selectedPlayers: number[]`, `mutedGridPlayers: number[]`, `gridPlayerVolumesRef.current: Record<number, number>`.
- Produces: dispatches `ClassicyAppTVSetGridState` with the slug shape from Task 1. `channelVolumes` keys are `source` slugs.

- [ ] **Step 1: Update the failing test**

In `TV.reorder.test.tsx`, change the assertion in the test `"a plain click in multiview mode still toggles selection"` (lines 154-160) from the id-based payload to the slug-based one:

```ts
		expect(
			dispatched.some(
				(a) =>
					a.type === "ClassicyAppTVSetGridState" &&
					(a.selectedChannels as string[] | undefined)?.includes("WNBC"),
			),
		).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx -t "multiview mode still toggles"`
Expected: FAIL — `persistGridState` still dispatches `selectedPlayers` (ids), so `selectedChannels` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `TV.tsx`, replace `persistGridState` (lines 494-502) with the id→slug mapping version. `itemsRef` is already in scope (declared at line 266):

```ts
	const persistGridState = useCallback(() => {
		const idToSlug = (id: number) =>
			itemsRef.current.find((i) => i.id === id)?.source;
		const selectedChannels = selectedPlayers
			.map(idToSlug)
			.filter((s): s is string => !!s);
		const mutedChannels = mutedGridPlayers
			.map(idToSlug)
			.filter((s): s is string => !!s);
		const channelVolumes: Record<string, number> = {};
		for (const [id, vol] of Object.entries(gridPlayerVolumesRef.current)) {
			const slug = idToSlug(Number(id));
			if (slug) channelVolumes[slug] = vol;
		}
		desktopEventDispatch({
			type: "ClassicyAppTVSetGridState",
			multiSelectMode,
			selectedChannels,
			mutedChannels,
			channelVolumes,
		});
	}, [multiSelectMode, selectedPlayers, mutedGridPlayers, desktopEventDispatch]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx`
Expected: PASS (all reorder tests, including the updated multiview assertion).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TV.tsx packages/frontend/src/Applications/TV/TV.reorder.test.tsx
git commit -m "feat(tv): persist grid selection by mapping live item ids to slugs"
```

---

## Task 3: Restore side — one-shot slug→id restore on load

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TV.tsx` — the three grid `useState` initializers (lines 222-234), the persist-on-mount effect (lines 506-508), and a new restore effect placed immediately after the re-home effect (after line 330).
- Test: `packages/frontend/src/Applications/TV/TV.embed.test.tsx` — update the id-based seed at line 193; add a restore test.

**Interfaces:**
- Consumes: `appState` (from `useAppManager`), `items` (from `useMediaStream`), the setters `setActivePlayer`, `setSelectedPlayers`, `setMutedGridPlayers`, `setGridPlayerVolumes`. Persisted data keys from Task 1: `currentChannel: string`, `selectedChannels: string[]`, `mutedChannels: string[]`, `channelVolumes: Record<string, number>`.
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Write the failing test**

In `TV.embed.test.tsx`, first change the seed in the test `"bumps an already-mounted grid player…"` (line 193) from id-based to slug-based so it keeps passing after restore becomes the source of truth:

```ts
		mockAppData.value = { multiSelectMode: true, selectedChannels: ["WABC", "WNBC"] };
```

Then add a new `describe` block (the restore test) at the end of `TV.embed.test.tsx`, before the final closing of the file:

```ts
describe("TV — restores persisted selection by slug", () => {
	// Items whose ids differ from any previously-persisted ids: restore must key
	// off `source`, not the stale ids that a real reload would have thrown away.
	const RELOADED_WABC = { ...FAKE_ITEM, id: 101 } as unknown as MediaItem;
	const RELOADED_WNBC = { ...FAKE_ITEM_2, id: 202 } as unknown as MediaItem;

	it("restores the single-view active channel from currentChannel", () => {
		captured.props.length = 0;
		mockAppData.value = { currentChannel: "WNBC" };
		mockItems.value = [RELOADED_WABC, RELOADED_WNBC];
		render(<TV />);
		// Single view renders exactly one main player; it must be the restored channel.
		const names = captured.props.map((p) => p.name);
		expect(names).toContain("WNBC");
		expect(names).not.toContain("WABC");
	});

	it("falls back to the first channel when currentChannel no longer exists", () => {
		captured.props.length = 0;
		mockAppData.value = { currentChannel: "GONE" };
		mockItems.value = [RELOADED_WABC, RELOADED_WNBC];
		render(<TV />);
		const names = captured.props.map((p) => p.name);
		expect(names).toContain("WABC"); // items[0]
		expect(names).not.toContain("WNBC");
	});

	it("restores the MultiView grid selection from selectedChannels", () => {
		captured.props.length = 0;
		mockAppData.value = {
			multiSelectMode: true,
			selectedChannels: ["WABC", "WNBC"],
		};
		mockItems.value = [RELOADED_WABC, RELOADED_WNBC];
		render(<TV />);
		const names = captured.props.map((p) => p.name);
		expect(names).toContain("WABC");
		expect(names).toContain("WNBC");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.embed.test.tsx -t "restores persisted selection"`
Expected: FAIL — the single-view test restores nothing (active player re-homes to `items[0]` = WABC, not WNBC), and the grid test renders no selected players (init is empty, no restore effect yet).

- [ ] **Step 3: Write minimal implementation — part A: empty the grid initializers**

In `TV.tsx`, change the three grid `useState` initializers so they no longer read the removed id-based fields. `activePlayer` (line 201-203) and `multiSelectMode` (line 219-221) are left unchanged.

Replace lines 222-234:

```ts
	const [selectedPlayers, setSelectedPlayers] = useState<number[]>([]);
	const [mutedGridPlayers, setMutedGridPlayers] = useState<number[]>([]);
	// Per-player volume (0..1) keyed by item id. Restored from channelVolumes
	// (slug-keyed) once items arrive; see the restore effect below.
	const [gridPlayerVolumes, setGridPlayerVolumes] = useState<
		Record<number, number>
	>({});
```

- [ ] **Step 4: Write minimal implementation — part B: the restore effect**

In `TV.tsx`, immediately AFTER the re-home effect that ends at line 330, add the one-shot restore effect. Placement after the re-home effect is required: both call `setActivePlayer` on the first commit, and the later effect wins — so a resolved slug overrides the re-home fallback, while an unresolved slug leaves the re-home's `items[0]` in place.

```ts
	// One-shot restore of the persisted selection. Persistence stores channel
	// identity as `source` slugs (ids rotate on program rollover / fresh stream),
	// so we resolve slugs → current item ids the first time items arrive. Guarded
	// by restoredRef so it runs exactly once and never clobbers later user edits.
	const restoredRef = useRef(false);
	useEffect(() => {
		if (restoredRef.current || items.length === 0) return;
		restoredRef.current = true;
		const data = appState?.data ?? {};
		const slugToId = (slug: string) =>
			items.find((i) => i.source === slug)?.id;

		const currentChannel = data.currentChannel as string | undefined;
		if (currentChannel) {
			const id = slugToId(currentChannel);
			if (id !== undefined) setActivePlayer(id);
		}

		const selectedChannels = (data.selectedChannels as string[] | undefined) ?? [];
		const restoredSelected = selectedChannels
			.map(slugToId)
			.filter((id): id is number => id !== undefined);
		if (restoredSelected.length > 0) setSelectedPlayers(restoredSelected);

		const mutedChannels = (data.mutedChannels as string[] | undefined) ?? [];
		const restoredMuted = mutedChannels
			.map(slugToId)
			.filter((id): id is number => id !== undefined);
		if (restoredMuted.length > 0) setMutedGridPlayers(restoredMuted);

		const channelVolumes =
			(data.channelVolumes as Record<string, number> | undefined) ?? {};
		const restoredVolumes: Record<number, number> = {};
		for (const [slug, vol] of Object.entries(channelVolumes)) {
			const id = slugToId(slug);
			if (id !== undefined) restoredVolumes[id] = vol;
		}
		if (Object.keys(restoredVolumes).length > 0)
			setGridPlayerVolumes(restoredVolumes);
	}, [items, appState]);
```

- [ ] **Step 5: Write minimal implementation — part C: skip the first persist**

The persist-on-mount effect would otherwise dispatch `SetGridState` with an empty selection before restore runs, overwriting the persisted slugs. Skip the first invocation so persistence only fires on real changes (including the restore-induced state change).

Replace the persist-on-mount effect (lines 506-508):

```ts
	// Skip the very first run: on mount the selection is empty/not-yet-restored,
	// and persisting it would overwrite the stored slugs the restore effect reads.
	// The restore effect's setState re-fires this via persistGridState's identity.
	const persistedOnceRef = useRef(false);
	useEffect(() => {
		if (!persistedOnceRef.current) {
			persistedOnceRef.current = true;
			return;
		}
		persistGridState();
	}, [persistGridState]);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.embed.test.tsx`
Expected: PASS — restore tests pass, and the pre-existing ABR grid test (now seeded with `selectedChannels`) still mounts both grid players.

- [ ] **Step 7: Run the full TV suite**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV`
Expected: PASS — `TVContext.test.ts`, `TV.reorder.test.tsx`, `TV.embed.test.tsx`, and all other TV specs green.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm --filter @rt911/frontend exec tsc -b && pnpm --filter @rt911/frontend exec eslint src/Applications/TV`
Expected: no errors. (Confirm no unused-variable warnings from the removed id-based initializer reads.)

- [ ] **Step 9: Commit**

```bash
git add packages/frontend/src/Applications/TV/TV.tsx packages/frontend/src/Applications/TV/TV.embed.test.tsx
git commit -m "feat(tv): restore single-view and MultiView selection from slugs on load"
```

---

## Task 4: Runtime verification in the real desktop

**Files:** none (manual/Playwright verification).

**Interfaces:** none.

- [ ] **Step 1: Launch and drive the frontend**

Use the `packages/frontend:verify` skill to start the Vite dev server and drive the desktop with Playwright MCP.

- [ ] **Step 2: Verify single view**

Open the TV app, tune to a non-default channel (not the first in the strip), reload the page. Expected: the same channel is active after reload (not `items[0]`).

- [ ] **Step 3: Verify MultiView**

Enter MultiView, select 2-3 channels, mute one and change another's volume, reload. Expected: the same channels are in the grid, the muted channel is still muted, and the adjusted volume is retained.

- [ ] **Step 4: Verify the disabled-channel fallback**

Tune single view to channel X, disable X in Settings, reload. Expected: single view falls back to the first available channel (no crash, no blank permanent state).

---

## Self-Review

**Spec coverage:**
- "Remember last single-view channel" → Task 3 restore effect (`currentChannel` → `activePlayer`). ✅
- "Remember MultiView selected videos" → Task 1 (reducer `selectedChannels`), Task 2 (write), Task 3 (restore). ✅
- "Selection + mute/volume survive reload" (user decision) → `mutedChannels` + `channelVolumes` across Tasks 1-3. ✅
- "Fall back to first channel on missing" (user decision) → Task 3 relies on the existing re-home effect; covered by the fallback test in Task 3 Step 1 and Task 4 Step 4. ✅
- "Persist to app state / reload from ClassicyState" → all writes go through the reducer into `apps["TV.app"].data`, which Classicy snapshots to localStorage. ✅

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step shows full code. ✅

**Type consistency:** `selectedChannels: string[]`, `mutedChannels: string[]`, `channelVolumes: Record<string, number>` used identically in the reducer (Task 1), the dispatch (Task 2), and the restore reads (Task 3). Runtime setters (`setActivePlayer`, `setSelectedPlayers`, `setMutedGridPlayers`, `setGridPlayerVolumes`) match their `useState` declarations. `slugToId`/`idToSlug` return `number | undefined` / `string | undefined` and are narrowed before use. ✅
