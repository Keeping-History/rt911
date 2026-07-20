# TV Thumbnail Drag-to-Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag a channel thumbnail to a new position in the TV app's strip with a classic Mac OS 8 dashed-outline drag visual, persisting the order in the app's Classicy state.

**Architecture:** Pure geometry/ordering helpers in a new `channelOrder.ts` (unit-tested), a new `ClassicyAppTVSetChannelOrder` action + handler in `TVContext.ts`, a `useThumbnailDrag` pointer-events hook, and wiring + overlay markup in `TV.tsx`'s thumbnail strip with new SCSS classes.

**Tech Stack:** React 18 + TypeScript, pointer events (no DnD library), CSS modules (SCSS), Vitest + Testing Library.

**Spec:** `plans/2026-07-20-tv-thumbnail-reorder-design.md`

## Global Constraints

- No new dependencies.
- Do not touch the `classicy` version (pre-commit auto-bumps it; that diff riding along is expected).
- Repo commands run from repo root: `pnpm --filter @rt911/frontend exec vitest run <file>`; full gates are `pnpm test`, `pnpm build` (tsc), `pnpm lint`.
- New test files need explicit `afterEach(cleanup)` (no RTL auto-cleanup in this repo's vitest setup).
- When mocking `classicy` in component tests, spread `...actual` and override only what the test needs (full replacement breaks on new imports).
- Tabs for indentation (match existing files).

---

### Task 1: Pure ordering/geometry helpers

**Files:**
- Create: `packages/frontend/src/Applications/TV/channelOrder.ts`
- Test: `packages/frontend/src/Applications/TV/channelOrder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sortByChannelOrder<T extends { source?: string }>(items: T[], order: string[]): T[]`
  - `insertionIndexFromX(rects: Array<{ left: number; width: number }>, pointerX: number): number` — rects in strip display order; returns 0..rects.length.
  - `applyReorder(sources: string[], fromIndex: number, toIndex: number): string[]` — `toIndex` is an insertion index (0..sources.length); returns **the same array reference** for a no-op drop so callers can skip dispatching.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/frontend/src/Applications/TV/channelOrder.test.ts
import { describe, expect, it } from "vitest";
import {
	applyReorder,
	insertionIndexFromX,
	sortByChannelOrder,
} from "./channelOrder";

const item = (source: string) => ({ source });

describe("sortByChannelOrder", () => {
	it("orders items by the saved order", () => {
		const items = [item("A"), item("B"), item("C")];
		expect(sortByChannelOrder(items, ["C", "A", "B"]).map((i) => i.source)).toEqual([
			"C",
			"A",
			"B",
		]);
	});

	it("appends unknown sources after ordered ones, keeping input order", () => {
		const items = [item("X"), item("B"), item("Y"), item("A")];
		expect(sortByChannelOrder(items, ["A", "B"]).map((i) => i.source)).toEqual([
			"A",
			"B",
			"X",
			"Y",
		]);
	});

	it("returns items unchanged for an empty order", () => {
		const items = [item("B"), item("A")];
		expect(sortByChannelOrder(items, []).map((i) => i.source)).toEqual(["B", "A"]);
	});

	it("ignores order entries with no matching item", () => {
		const items = [item("A")];
		expect(sortByChannelOrder(items, ["Z", "A"]).map((i) => i.source)).toEqual(["A"]);
	});
});

describe("insertionIndexFromX", () => {
	// Three 100px thumbnails at x = 0, 100, 200 → midpoints 50, 150, 250.
	const rects = [
		{ left: 0, width: 100 },
		{ left: 100, width: 100 },
		{ left: 200, width: 100 },
	];

	it("returns 0 before the first midpoint", () => {
		expect(insertionIndexFromX(rects, 10)).toBe(0);
	});

	it("returns the index between two midpoints", () => {
		expect(insertionIndexFromX(rects, 120)).toBe(1);
	});

	it("returns rects.length past the last midpoint", () => {
		expect(insertionIndexFromX(rects, 900)).toBe(3);
	});

	it("returns 0 for an empty strip", () => {
		expect(insertionIndexFromX([], 50)).toBe(0);
	});
});

describe("applyReorder", () => {
	const sources = ["A", "B", "C", "D"];

	it("moves an item forward (insertion index after removal)", () => {
		expect(applyReorder(sources, 0, 3)).toEqual(["B", "C", "A", "D"]);
	});

	it("moves an item backward", () => {
		expect(applyReorder(sources, 3, 1)).toEqual(["A", "D", "B", "C"]);
	});

	it("moves an item to the very end", () => {
		expect(applyReorder(sources, 1, 4)).toEqual(["A", "C", "D", "B"]);
	});

	it("returns the same reference when dropping onto its own slot", () => {
		expect(applyReorder(sources, 1, 1)).toBe(sources);
		expect(applyReorder(sources, 1, 2)).toBe(sources); // gap just after itself
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/channelOrder.test.ts`
Expected: FAIL — `Cannot find module './channelOrder'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

```typescript
// packages/frontend/src/Applications/TV/channelOrder.ts
// Pure ordering/geometry helpers for the TV thumbnail strip's drag-to-reorder.
// Kept free of React/DOM so they can be unit-tested directly.

/**
 * Sort items by a saved channel order (list of `source` slugs). Sources not in
 * the saved order append after the ordered ones in their input order, so new
 * channels (and the empty first-run order) render exactly as the wire delivers
 * them.
 */
export function sortByChannelOrder<T extends { source?: string }>(
	items: T[],
	order: string[],
): T[] {
	if (order.length === 0) return items;
	const rank = new Map(order.map((source, i) => [source, i]));
	// Stable: equal ranks (both unknown → Infinity) keep input order.
	return [...items].sort(
		(a, b) =>
			(rank.get(a.source ?? "") ?? Infinity) -
			(rank.get(b.source ?? "") ?? Infinity),
	);
}

/**
 * The insertion index for a pointer at `pointerX`, given the thumbnails'
 * rects in display order (any shared coordinate space): the number of
 * thumbnail midpoints left of the pointer. 0 = before the first thumbnail,
 * rects.length = after the last.
 */
export function insertionIndexFromX(
	rects: Array<{ left: number; width: number }>,
	pointerX: number,
): number {
	let index = 0;
	for (const rect of rects) {
		if (pointerX > rect.left + rect.width / 2) index++;
	}
	return index;
}

/**
 * Move `sources[fromIndex]` to insertion index `toIndex` (0..sources.length,
 * measured before removal). Returns the input array unchanged (same reference)
 * when the drop wouldn't move anything, so callers can skip persisting.
 */
export function applyReorder(
	sources: string[],
	fromIndex: number,
	toIndex: number,
): string[] {
	// Dropping into its own slot or the gap just after itself is a no-op.
	if (toIndex === fromIndex || toIndex === fromIndex + 1) return sources;
	const next = [...sources];
	const [moved] = next.splice(fromIndex, 1);
	// Removal shifted everything after fromIndex left by one.
	next.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);
	return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/channelOrder.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/channelOrder.ts packages/frontend/src/Applications/TV/channelOrder.test.ts
git commit -m "feat(tv): pure ordering/geometry helpers for thumbnail reorder"
```

---

### Task 2: `ClassicyAppTVSetChannelOrder` action + handler

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TVContext.ts` (action creator near `tvSetActivePlayer`; handler case near `"ClassicyAppTVSetDisabledChannels"`)
- Test: `packages/frontend/src/Applications/TV/TVContext.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `ActionMessage`, `classicyTVEventHandler`, `TV_APP_ID` from `TVContext.ts`.
- Produces: `tvSetChannelOrder(channelOrder: string[]): ActionMessage` (type `"ClassicyAppTVSetChannelOrder"`); handler persists `data.channelOrder: string[]`.

- [ ] **Step 1: Write the failing test**

Open `packages/frontend/src/Applications/TV/TVContext.test.ts`, mirror its existing store-fixture pattern (read the top of the file first — it builds a minimal `ClassicyStore` with a `TV.app` entry), and append:

```typescript
describe("tvSetChannelOrder", () => {
	it("persists the channel order into app data", () => {
		const store = makeStore(); // the file's existing store fixture helper
		const next = classicyTVEventHandler(
			store,
			tvSetChannelOrder(["WNBC", "WABC"]),
		);
		expect(next.System.Manager.Applications.apps["TV.app"].data?.channelOrder).toEqual(
			["WNBC", "WABC"],
		);
	});
});
```

(Add `tvSetChannelOrder` to the file's existing `./TVContext` import. If the fixture helper has a different name, use that name — do not add a second fixture.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts`
Expected: FAIL — `tvSetChannelOrder` is not exported.

- [ ] **Step 3: Implement**

In `TVContext.ts`, after `tvSetActivePlayer` (line ~99):

```typescript
/** Persist the user's custom thumbnail-strip channel order (source slugs). */
export const tvSetChannelOrder = (channelOrder: string[]): ActionMessage => ({
	type: "ClassicyAppTVSetChannelOrder",
	channelOrder,
});
```

In `classicyTVEventHandler`'s switch, after the `"ClassicyAppTVSetDisabledChannels"` case:

```typescript
// The thumbnail strip's user-arranged order. Sources missing from this
// list (channels added later) render after it in wire order.
case "ClassicyAppTVSetChannelOrder":
	apps[appId].data = { ...appData, channelOrder: action.channelOrder };
	return ds;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TVContext.ts packages/frontend/src/Applications/TV/TVContext.test.ts
git commit -m "feat(tv): ClassicyAppTVSetChannelOrder action persists strip order"
```

---

### Task 3: Strip renders in persisted order

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TV.tsx`
- Test: create `packages/frontend/src/Applications/TV/TV.reorder.test.tsx`

**Interfaces:**
- Consumes: `sortByChannelOrder` (Task 1); `data.channelOrder` shape (Task 2).
- Produces: `orderedItems` variable in `TV.tsx` used by the thumbnail-strip `.map`; `TV.reorder.test.tsx` with the classicy/useMediaStream mock scaffold Task 4's tests extend.

- [ ] **Step 1: Write the failing test**

Create `TV.reorder.test.tsx` modeled on `TV.embed.test.tsx`'s mock scaffold (hoisted `mockAppData`/`mockItems`, `vi.mock("classicy")` spreading `...actual`, `useMediaStream` mock, openreplay mock). Key differences from the embed test: capture dispatched actions, and give the strip more than one item by default.

```tsx
// packages/frontend/src/Applications/TV/TV.reorder.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

const mockAppData = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const dispatched = vi.hoisted(() => ({ actions: [] as Record<string, unknown>[] }));

const makeItem = (id: number, source: string) =>
	({
		id,
		url: `https://files.example.org/${source.toLowerCase()}/index.m3u8`,
		source,
		start_date: "2001-09-11T12:00:00",
		jump: 0,
		subtitles: "",
	}) as unknown as MediaItem;

const ITEMS = [makeItem(1, "WABC"), makeItem(2, "WCBS"), makeItem(3, "WNBC")];

vi.mock("classicy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("classicy")>();
	const fakeState = () => ({
		System: {
			Manager: {
				Applications: {
					apps: { "TV.app": { data: mockAppData.value, open: true, windows: [] } },
				},
			},
		},
	});
	return {
		...actual,
		ClassicyApp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		ClassicyWindow: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		QuickTimeVideoEmbed: () => <div data-testid="qt-embed" />,
		useAppManager: (selector: (s: unknown) => unknown) => selector(fakeState()),
		useAppManagerDispatch: () => (action: Record<string, unknown>) => {
			dispatched.actions.push(action);
		},
		useClassicyDateTime: () => ({ dateTime: "2001-09-11T12:40:00.000Z", paused: false }),
	};
});

vi.mock("../../Providers/MediaStream/useMediaStream", () => ({
	useMediaStream: () => ({
		items: ITEMS,
		sources: { video: ["WABC", "WCBS", "WNBC"], audio: [], pager: [], usenet: [] },
	}),
}));

vi.mock("../../openreplay", () => ({
	trackAppToggle: () => {},
	trackChannelChange: () => {},
}));

import { TV } from "./TV";

afterEach(() => {
	cleanup();
	mockAppData.value = {};
	dispatched.actions = [];
});

/** The strip's channel labels, in DOM order. */
const stripOrder = () =>
	screen.getAllByRole("button", { name: /^(WABC|WCBS|WNBC)$/ }).map((b) => b.textContent);

describe("thumbnail strip ordering", () => {
	it("renders wire order when no channelOrder is saved", () => {
		render(<TV />);
		expect(stripOrder()).toEqual(["WABC", "WCBS", "WNBC"]);
	});

	it("renders the persisted channelOrder", () => {
		mockAppData.value = { channelOrder: ["WNBC", "WABC", "WCBS"] };
		render(<TV />);
		expect(stripOrder()).toEqual(["WNBC", "WABC", "WCBS"]);
	});

	it("appends channels missing from the persisted order", () => {
		mockAppData.value = { channelOrder: ["WNBC"] };
		render(<TV />);
		expect(stripOrder()).toEqual(["WNBC", "WABC", "WCBS"]);
	});
});
```

Note: the thumbnail buttons' accessible name comes from the `<p>{item.source}</p>` title inside each button; if `getAllByRole` name-matching proves brittle, fall back to querying the strip container's buttons via `container.querySelectorAll` — but try the role query first.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx`
Expected: the two ordering tests FAIL (strip renders wire order regardless of `channelOrder`); the no-order test passes.

- [ ] **Step 3: Implement**

In `TV.tsx`:

1. Import: `import { sortByChannelOrder } from "./channelOrder";`
2. Below the `disabledChannels` memo (~line 121), read the persisted order:

```typescript
// The user's custom thumbnail-strip order (source slugs), arranged by drag.
const channelOrder = useMemo(
	() => (appState?.data?.channelOrder as string[] | undefined) ?? [],
	[appState?.data?.channelOrder],
);
```

3. Below `const { items } = useMediaStream(tvFilter);` (~line 149):

```typescript
// Strip display order: saved arrangement first, new channels appended.
const orderedItems = useMemo(
	() => sortByChannelOrder(items, channelOrder),
	[items, channelOrder],
);
```

4. In the thumbnail strip JSX (~line 1042), change `{items.map((item) => {` to `{orderedItems.map((item) => {`. Leave every other `items` usage alone (they are id-keyed lookups, order-independent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx src/Applications/TV/TV.embed.test.tsx`
Expected: PASS (reorder tests green; embed tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TV.tsx packages/frontend/src/Applications/TV/TV.reorder.test.tsx
git commit -m "feat(tv): thumbnail strip renders persisted channel order"
```

---

### Task 4: Pointer-drag hook, outline visuals, and commit-on-drop

**Files:**
- Create: `packages/frontend/src/Applications/TV/useThumbnailDrag.ts`
- Modify: `packages/frontend/src/Applications/TV/TV.tsx` (strip JSX), `packages/frontend/src/Applications/TV/TV.module.scss`
- Test: extend `packages/frontend/src/Applications/TV/TV.reorder.test.tsx`

**Interfaces:**
- Consumes: `insertionIndexFromX`, `applyReorder` (Task 1); `tvSetChannelOrder` (Task 2); `orderedItems` (Task 3).
- Produces:

```typescript
interface ThumbnailDragState {
	fromIndex: number;          // index in the displayed (ordered) strip
	active: boolean;            // true once past the movement threshold
	x: number;                  // outline top-left, strip-content coordinates
	y: number;
	width: number;              // dragged thumbnail's size
	height: number;
	insertionIndex: number;     // 0..n, where the drop would land
	insertionX: number;         // insertion bar x, strip-content coordinates
}

function useThumbnailDrag(options: {
	stripRef: React.RefObject<HTMLDivElement | null>;
	onCommit: (fromIndex: number, toIndex: number) => void;
}): {
	drag: ThumbnailDragState | null;
	thumbHandlers: (index: number) => {
		onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
		onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
		onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
		onPointerCancel: () => void;
	};
	suppressNextClick: React.MutableRefObject<boolean>; // true right after a real drag
}
```

- [ ] **Step 1: Write the failing tests**

Append to `TV.reorder.test.tsx`. jsdom has no layout, so mock each thumbnail button's `getBoundingClientRect` (100×75 boxes at x = 0/100/200) and the strip container's (left 0, width 300). A drag = `pointerDown` on a button, `pointerMove` past the 5px threshold to the target x, `pointerUp`.

```tsx
import { fireEvent } from "@testing-library/react";

/** Give the strip and its buttons deterministic layout in jsdom. */
function mockStripLayout() {
	const strip = document.querySelector(
		"[class*='tvThumbnailStrip']",
	) as HTMLElement;
	strip.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	const buttons = Array.from(strip.querySelectorAll("button"));
	buttons.forEach((b, i) => {
		b.getBoundingClientRect = () =>
			({ left: i * 100, top: 0, width: 100, height: 75, right: i * 100 + 100, bottom: 75, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect;
	});
	return buttons;
}

describe("thumbnail drag-to-reorder", () => {
	it("dispatches the new channel order on drop", () => {
		render(<TV />);
		const [first] = mockStripLayout();
		// Drag WABC (index 0) to the far right (past WNBC's midpoint at 250).
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerMove(first, { clientX: 270, clientY: 30, pointerId: 1 });
		fireEvent.pointerUp(first, { clientX: 270, clientY: 30, pointerId: 1 });
		expect(dispatched.actions).toContainEqual({
			type: "ClassicyAppTVSetChannelOrder",
			channelOrder: ["WCBS", "WNBC", "WABC"],
		});
	});

	it("shows the outline and insertion bar only while dragging", () => {
		const { container } = render(<TV />);
		const [first] = mockStripLayout();
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		// Below threshold: still nothing.
		fireEvent.pointerMove(first, { clientX: 52, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerMove(first, { clientX: 150, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).not.toBeNull();
		expect(container.querySelector("[class*='tvDragInsertionBar']")).not.toBeNull();
		fireEvent.pointerUp(first, { clientX: 150, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
	});

	it("does not dispatch for a no-op drop or a sub-threshold press", () => {
		render(<TV />);
		const [first] = mockStripLayout();
		// Sub-threshold press → click semantics, no reorder dispatch.
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerUp(first, { clientX: 51, clientY: 30, pointerId: 1 });
		// Real drag dropped back on its own slot.
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 2, button: 0 });
		fireEvent.pointerMove(first, { clientX: 70, clientY: 30, pointerId: 2 });
		fireEvent.pointerUp(first, { clientX: 40, clientY: 30, pointerId: 2 });
		expect(
			dispatched.actions.filter((a) => a.type === "ClassicyAppTVSetChannelOrder"),
		).toEqual([]);
	});

	it("cancels the drag on Escape without dispatching", () => {
		const { container } = render(<TV />);
		const [first] = mockStripLayout();
		fireEvent.pointerDown(first, { clientX: 50, clientY: 30, pointerId: 1, button: 0 });
		fireEvent.pointerMove(first, { clientX: 250, clientY: 30, pointerId: 1 });
		expect(container.querySelector("[class*='tvDragOutline']")).not.toBeNull();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector("[class*='tvDragOutline']")).toBeNull();
		fireEvent.pointerUp(first, { clientX: 250, clientY: 30, pointerId: 1 });
		expect(
			dispatched.actions.filter((a) => a.type === "ClassicyAppTVSetChannelOrder"),
		).toEqual([]);
	});

	it("still tunes the channel on a plain click", () => {
		render(<TV />);
		const buttons = mockStripLayout();
		fireEvent.click(buttons[1]);
		expect(dispatched.actions).toContainEqual(
			expect.objectContaining({ type: "ClassicyAppTVSetActivePlayer" }),
		);
	});
});
```

Note on the last test: check how `TV.tsx` persists `activePlayer` before asserting — if `setActivePlayer` is local state persisted through a different dispatch (search `tvSetActivePlayer` usage in `TV.tsx`), assert on that observable instead (e.g. the clicked thumbnail gaining the selected class). Do not weaken the drag tests; only adapt this click-behavior probe to whatever the component actually does today.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx`
Expected: the new drag tests FAIL (no handlers, no overlay elements); Task 3's ordering tests still PASS.

- [ ] **Step 3: Implement the hook**

```typescript
// packages/frontend/src/Applications/TV/useThumbnailDrag.ts
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { insertionIndexFromX } from "./channelOrder";

// A press only becomes a drag after this much pointer travel; below it,
// release falls through to the button's normal click (tune/select).
const DRAG_THRESHOLD_PX = 5;

export interface ThumbnailDragState {
	fromIndex: number;
	active: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	insertionIndex: number;
	insertionX: number;
}

interface PendingDrag {
	fromIndex: number;
	pointerId: number;
	startX: number;
	startY: number;
}

/**
 * Classic Mac outline drag for the thumbnail strip: the original stays put, a
 * dashed outline follows the cursor, and an insertion bar marks the drop slot.
 * Coordinates in the returned state are strip-content coordinates (relative to
 * the strip's border box, scroll included) so overlays can be absolutely
 * positioned inside the scrolling strip.
 */
export function useThumbnailDrag({
	stripRef,
	onCommit,
}: {
	stripRef: React.RefObject<HTMLDivElement | null>;
	onCommit: (fromIndex: number, toIndex: number) => void;
}) {
	const [drag, setDrag] = useState<ThumbnailDragState | null>(null);
	const pendingRef = useRef<PendingDrag | null>(null);
	// Set when a real drag completes so the button's onClick can ignore the
	// click the browser fires after pointerup.
	const suppressNextClick = useRef(false);

	// Escape cancels an in-flight drag; the eventual pointerup is then inert.
	useEffect(() => {
		if (!drag?.active) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			pendingRef.current = null;
			suppressNextClick.current = true;
			setDrag(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [drag?.active]);

	/** The strip's thumbnail buttons' rects + pointer, in strip-content coords. */
	const measure = (e: React.PointerEvent<HTMLElement>) => {
		const strip = stripRef.current;
		if (!strip) return null;
		const stripRect = strip.getBoundingClientRect();
		const toContentX = (clientX: number) =>
			clientX - stripRect.left + strip.scrollLeft;
		const buttons = Array.from(strip.querySelectorAll<HTMLElement>("button"));
		const rects = buttons.map((b) => {
			const r = b.getBoundingClientRect();
			return { left: toContentX(r.left), width: r.width, height: r.height };
		});
		return { rects, pointerX: toContentX(e.clientX), stripRect, strip };
	};

	const onPointerDown =
		(index: number) => (e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0) return;
			pendingRef.current = {
				fromIndex: index,
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
			};
			suppressNextClick.current = false;
			// Keeps move/up delivered to this element even outside the strip.
			e.currentTarget.setPointerCapture?.(e.pointerId);
		};

	const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
		const pending = pendingRef.current;
		if (!pending || pending.pointerId !== e.pointerId) return;
		const moved = Math.hypot(
			e.clientX - pending.startX,
			e.clientY - pending.startY,
		);
		if (!drag && moved < DRAG_THRESHOLD_PX) return;
		const m = measure(e);
		if (!m) return;
		const from = m.rects[pending.fromIndex];
		if (!from) return;
		const insertionIndex = insertionIndexFromX(m.rects, m.pointerX);
		// Insertion bar sits at the leading edge of the slot it points into, or
		// flush after the last thumbnail.
		const last = m.rects[m.rects.length - 1];
		const insertionX =
			insertionIndex < m.rects.length
				? m.rects[insertionIndex].left
				: last.left + last.width;
		setDrag({
			fromIndex: pending.fromIndex,
			active: true,
			x: m.pointerX - from.width / 2,
			y: e.clientY - m.stripRect.top - from.height / 2,
			width: from.width,
			height: from.height,
			insertionIndex,
			insertionX,
		});
	};

	const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
		const pending = pendingRef.current;
		if (!pending || pending.pointerId !== e.pointerId) return;
		pendingRef.current = null;
		if (drag?.active) {
			suppressNextClick.current = true;
			onCommit(drag.fromIndex, drag.insertionIndex);
		}
		setDrag(null);
	};

	const onPointerCancel = () => {
		pendingRef.current = null;
		setDrag(null);
	};

	const thumbHandlers = (index: number) => ({
		onPointerDown: onPointerDown(index),
		onPointerMove,
		onPointerUp,
		onPointerCancel,
	});

	return { drag, thumbHandlers, suppressNextClick };
}
```

- [ ] **Step 4: Wire into `TV.tsx`**

1. Imports:

```typescript
import { applyReorder } from "./channelOrder";
import { tvSetChannelOrder } from "./TVContext";
import { useThumbnailDrag } from "./useThumbnailDrag";
```

(merge into the existing `./TVContext` import list).

2. Near the other refs (~line 240):

```typescript
const stripRef = useRef<HTMLDivElement>(null);
const { drag, thumbHandlers, suppressNextClick } = useThumbnailDrag({
	stripRef,
	onCommit: (fromIndex, toIndex) => {
		const sources = orderedItems.map((i) => i.source ?? "");
		const next = applyReorder(sources, fromIndex, toIndex);
		if (next !== sources) desktopEventDispatch(tvSetChannelOrder(next));
	},
});
```

3. Strip container gains the ref: `<div className={styles.tvThumbnailStrip} ref={stripRef}>`.

4. Each thumbnail button (the `orderedItems.map` from Task 3): spread the handlers and guard the click. `index` comes from the map callback (`orderedItems.map((item, index) => …`):

```tsx
<button
	key={item.id}
	{...thumbHandlers(index)}
	className={/* unchanged */}
	onClick={() => {
		if (suppressNextClick.current) {
			suppressNextClick.current = false;
			return;
		}
		/* existing click body unchanged */
	}}
	/* existing onKeyDown / type unchanged */
>
```

5. Overlays, rendered as the strip's last children (inside the `tvThumbnailStrip` div, after the map):

```tsx
{drag?.active && (
	<>
		<div
			className={styles.tvDragOutline}
			style={{
				left: drag.x,
				top: drag.y,
				width: drag.width,
				height: drag.height,
			}}
		/>
		<div
			className={styles.tvDragInsertionBar}
			style={{ left: drag.insertionX }}
		/>
	</>
)}
```

6. In `TV.module.scss`, add `position: relative;` to `.tvThumbnailStrip` and append:

```scss
// Classic Mac OS 8 outline drag: a dashed "marching ants" rectangle follows
// the cursor while the original thumbnail stays put.
.tvDragOutline {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  border: 2px dashed var(--color-black, #000);
  background: transparent;
  animation: tvMarchingAnts 0.4s linear infinite;
}

// Where the dragged thumbnail will land.
.tvDragInsertionBar {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  top: 5%;
  height: 90%;
  width: 3px;
  margin-left: -1px;
  background: var(--color-theme-04);
}

@keyframes tvMarchingAnts {
  to {
    // Dashed borders can't animate directly; nudging the outline's
    // border-image position is heavier than it's worth, so approximate the
    // classic marching-ants shimmer by cycling the dash color.
    border-color: var(--color-system-05, #666);
  }
}
```

(If `var(--color-black)` / `var(--color-system-05)` don't exist in classicy's theme variables — check `node_modules/classicy/dist/classicy.css` for the real names — use the nearest existing dark/system variables; hex fallbacks keep it working regardless.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx src/Applications/TV/TV.embed.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/TV/useThumbnailDrag.ts packages/frontend/src/Applications/TV/TV.tsx packages/frontend/src/Applications/TV/TV.module.scss packages/frontend/src/Applications/TV/TV.reorder.test.tsx
git commit -m "feat(tv): classic Mac outline drag reorders the thumbnail strip"
```

---

### Task 5: Full verification + browser check

**Files:** none new.

- [ ] **Step 1: Run the full frontend gates**

```bash
pnpm test
pnpm build
pnpm lint
```

Expected: all pass. Fix anything that fails before proceeding.

- [ ] **Step 2: Browser-verify the drag**

Use the `packages/frontend:verify` skill (dev server at localhost:5173): open the TV app, drag a thumbnail — dashed outline follows the cursor, insertion bar shows the slot, drop reorders, order survives a page reload (Classicy persists app data to localStorage). Screenshot the mid-drag state.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix(tv): post-verification fixes for thumbnail reorder"
```

(Skip if nothing changed.)
