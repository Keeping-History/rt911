# TV Channel Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag the TV app's channel thumbnails into their own order, persisted locally, taking precedence over any future server-side ordering — without a drag ever focusing a video.

**Architecture:** A pure ordering module (`channelOrder.ts`) keyed on `item.source`, a hand-rolled pointer-event hook (`useThumbnailReorder.ts`) with a 5px drag threshold and one-shot click suppression, and a new `ClassicyAppTVSetChannelOrder` reducer case whose `apps["TV.app"].data.channelOrder` Classicy snapshots to `localStorage` for free. `TV.tsx` gains wiring only.

**Tech Stack:** React 19 + TypeScript, Vite, vitest + React Testing Library, `classicy` app-manager store, SCSS modules.

**Spec:** `plans/2026-07-20-tv-channel-reorder-design.md` — binding.

## Global Constraints

- Package root: `packages/frontend`. Run commands from repo root using the filter form shown in each task.
- Verify before every commit: `pnpm --filter @rt911/frontend exec tsc -b`, `pnpm --filter @rt911/frontend exec eslint .`, and the task's vitest run. CI requires all three green.
- **Ordering identity is `item.source` (channel slug), never `item.id`** — ids change as programs roll over the virtual clock.
- Unknown channels **append to the end**, preserving the incoming array's relative order (this is what lets future server-side ordering supply the default).
- `DRAG_THRESHOLD_PX = 5`.
- All TV state writes go through `desktopEventDispatch` — never touch `localStorage` directly.
- New test files MUST call `afterEach(cleanup)` — this repo's vitest setup has no RTL auto-cleanup.
- Keyboard reordering is an explicit non-goal; the existing `onKeyDown` (Enter/Space) path must remain byte-identical.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Use `git commit --no-verify` (the pre-commit hook bumps the classicy lockfile).

---

### Task 1: `channelOrder.ts` — pure ordering

**Files:**
- Create: `packages/frontend/src/Applications/TV/channelOrder.ts`
- Test: `packages/frontend/src/Applications/TV/channelOrder.test.ts`

**Interfaces:**
- Produces: `orderChannels(items: MediaItem[], channelOrder: string[]): MediaItem[]` and `moveChannel(order: string[], visibleOrder: string[], from: string, to: string): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";
import { moveChannel, orderChannels } from "./channelOrder";

const item = (id: number, source: string) => ({ id, source }) as unknown as MediaItem;

describe("orderChannels", () => {
	it("puts saved channels first, in the saved order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC"), item(3, "WCBS")];
		expect(orderChannels(items, ["WCBS", "WABC"]).map((i) => i.source)).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("appends unknown channels preserving their incoming relative order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC"), item(3, "WCBS")];
		// Incoming order of the unsaved ones (WABC, WNBC) must be preserved after WCBS.
		expect(orderChannels(items, ["WCBS"]).map((i) => i.source)).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("skips saved slugs that have no matching item", () => {
		const items = [item(1, "WABC")];
		expect(orderChannels(items, ["GONE", "WABC"]).map((i) => i.source)).toEqual(["WABC"]);
	});

	it("is stable when item ids change but sources do not (program rollover)", () => {
		const before = [item(1, "WABC"), item(2, "WNBC")];
		const after = [item(99, "WABC"), item(98, "WNBC")];
		const order = ["WNBC", "WABC"];
		expect(orderChannels(before, order).map((i) => i.source)).toEqual(
			orderChannels(after, order).map((i) => i.source),
		);
	});

	it("returns items unchanged when there is no saved order", () => {
		const items = [item(1, "WABC"), item(2, "WNBC")];
		expect(orderChannels(items, []).map((i) => i.source)).toEqual(["WABC", "WNBC"]);
	});

	it("ignores items with no source rather than throwing", () => {
		const items = [item(1, "WABC"), { id: 2 } as unknown as MediaItem];
		expect(orderChannels(items, ["WABC"]).length).toBe(2);
	});
});

describe("moveChannel", () => {
	it("materializes the visible order on the first drag", () => {
		// Saved order is empty; dragging WCBS onto WABC must keep WNBC in place.
		expect(moveChannel([], ["WABC", "WNBC", "WCBS"], "WCBS", "WABC")).toEqual([
			"WCBS",
			"WABC",
			"WNBC",
		]);
	});

	it("moves a channel forward, inserting before the target", () => {
		expect(moveChannel(["A", "B", "C"], ["A", "B", "C"], "A", "C")).toEqual(["B", "C", "A"]);
	});

	it("moves a channel backward, inserting before the target", () => {
		expect(moveChannel(["A", "B", "C"], ["A", "B", "C"], "C", "B")).toEqual(["A", "C", "B"]);
	});

	it("is a no-op when source and target are the same", () => {
		expect(moveChannel(["A", "B"], ["A", "B"], "A", "A")).toEqual(["A", "B"]);
	});

	it("does not mutate the input array", () => {
		const order = ["A", "B"];
		moveChannel(order, ["A", "B"], "B", "A");
		expect(order).toEqual(["A", "B"]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/channelOrder.test.ts`
Expected: FAIL — cannot resolve `./channelOrder`.

- [ ] **Step 3: Implement**

```ts
import type { MediaItem } from "../../Providers/MediaStream/MediaStreamContext";

/**
 * Channel ordering for the TV thumbnail strip.
 *
 * Ordering is keyed on `item.source` (the channel slug), never `item.id`:
 * ids belong to the currently-airing MediaItem and change every time the
 * virtual clock rolls into a new program, which would silently scramble a
 * saved order keyed on them.
 */

/**
 * Apply the user's saved order, appending anything unsaved.
 *
 * Saved channels come first in `channelOrder`'s sequence; every other item
 * follows in its **incoming relative order**. That's the precedence rule: the
 * user's arrangement wins, and the underlying order — today WebSocket arrival
 * order, tomorrow whatever server-side ordering exists — supplies the default
 * for channels the user has never dragged.
 */
export function orderChannels(items: MediaItem[], channelOrder: string[]): MediaItem[] {
	if (channelOrder.length === 0) return items;

	const bySource = new Map<string, MediaItem>();
	for (const item of items) {
		if (item.source) bySource.set(item.source, item);
	}

	const saved: MediaItem[] = [];
	const seen = new Set<string>();
	for (const source of channelOrder) {
		const item = bySource.get(source);
		// A saved slug with no item (channel disabled, or not yet streamed in)
		// is skipped rather than leaving a hole.
		if (item && !seen.has(source)) {
			saved.push(item);
			seen.add(source);
		}
	}

	const rest = items.filter((item) => !item.source || !seen.has(item.source));
	return [...saved, ...rest];
}

/**
 * Move `from` to sit immediately before `to`, returning a new slug array.
 *
 * `visibleOrder` is the strip's current on-screen order. When `from` isn't in
 * `order` yet — the common case, since the saved order starts empty — we
 * materialize `visibleOrder` first. Without that, the first drag would produce
 * a one-element array and send every other channel to the end.
 */
export function moveChannel(
	order: string[],
	visibleOrder: string[],
	from: string,
	to: string,
): string[] {
	if (from === to) return order;

	const base = order.includes(from) && order.includes(to) ? [...order] : [...visibleOrder];
	const fromIndex = base.indexOf(from);
	const toIndex = base.indexOf(to);
	if (fromIndex === -1 || toIndex === -1) return order;

	base.splice(fromIndex, 1);
	// Recompute after removal so a forward move lands before the target.
	base.splice(base.indexOf(to), 0, from);
	return base;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/channelOrder.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/channelOrder.ts packages/frontend/src/Applications/TV/channelOrder.test.ts
git commit --no-verify -m "feat(tv): channel ordering keyed on source slug

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `useThumbnailReorder.ts` — pointer gesture hook

**Files:**
- Create: `packages/frontend/src/Applications/TV/useThumbnailReorder.ts`
- Test: `packages/frontend/src/Applications/TV/useThumbnailReorder.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the hook reports the move; the caller applies `moveChannel`).
- Produces: `useThumbnailReorder(onReorder: (from: string, to: string) => void)` returning
  `{ dragSource: string | null, dropTarget: string | null, consumeSuppressedClick: () => boolean, handlers: (source: string) => { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown } }`.
  Also exports `DRAG_THRESHOLD_PX`.

- [ ] **Step 1: Write the failing tests**

```ts
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useThumbnailReorder } from "./useThumbnailReorder";

// Minimal PointerEvent stand-in: the hook only reads these fields.
const pointerEvent = (clientX: number, clientY = 0) =>
	({
		clientX,
		clientY,
		pointerId: 1,
		currentTarget: {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
			// Drop-target resolution walks the strip's children.
			parentElement: {
				children: [
					{ dataset: { source: "A" }, getBoundingClientRect: () => ({ left: 0, right: 100 }) },
					{ dataset: { source: "B" }, getBoundingClientRect: () => ({ left: 100, right: 200 }) },
				],
			},
		},
		preventDefault: vi.fn(),
	}) as unknown as React.PointerEvent<HTMLButtonElement>;

describe("useThumbnailReorder", () => {
	it("does not reorder or suppress a click when movement is below threshold", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(13)));
		act(() => h.onPointerUp(pointerEvent(13)));
		expect(onReorder).not.toHaveBeenCalled();
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("reorders and suppresses the click when movement exceeds threshold", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(onReorder).toHaveBeenCalledWith("A", "B");
		expect(result.current.consumeSuppressedClick()).toBe(true);
	});

	it("clears the suppression flag after a single read", () => {
		const { result } = renderHook(() => useThumbnailReorder(vi.fn()));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(result.current.consumeSuppressedClick()).toBe(true);
		// Second read must be false, or the *next* genuine click gets eaten.
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("exposes dragSource and dropTarget while dragging", () => {
		const { result } = renderHook(() => useThumbnailReorder(vi.fn()));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		expect(result.current.dragSource).toBe("A");
		expect(result.current.dropTarget).toBe("B");
	});

	it("aborts on pointer cancel without reordering or suppressing", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() => h.onPointerCancel(pointerEvent(150)));
		expect(onReorder).not.toHaveBeenCalled();
		expect(result.current.dragSource).toBe(null);
		expect(result.current.consumeSuppressedClick()).toBe(false);
	});

	it("aborts on Escape while dragging", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		act(() => h.onPointerMove(pointerEvent(150)));
		act(() =>
			h.onKeyDown({ key: "Escape" } as unknown as React.KeyboardEvent<HTMLButtonElement>),
		);
		act(() => h.onPointerUp(pointerEvent(150)));
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("does not reorder when released over its own tile", () => {
		const onReorder = vi.fn();
		const { result } = renderHook(() => useThumbnailReorder(onReorder));
		const h = result.current.handlers("A");
		act(() => h.onPointerDown(pointerEvent(10)));
		// Moves far enough to start a drag but stays within tile A's box.
		act(() => h.onPointerMove(pointerEvent(80)));
		act(() => h.onPointerUp(pointerEvent(80)));
		expect(onReorder).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/useThumbnailReorder.test.ts`
Expected: FAIL — cannot resolve `./useThumbnailReorder`.

- [ ] **Step 3: Implement**

```ts
import type React from "react";
import { useCallback, useRef, useState } from "react";

/**
 * Pointer-drag reordering for the TV thumbnail strip.
 *
 * A press is ambiguous until the pointer moves: under the threshold it stays a
 * click (focus a channel, or toggle it in multiview); past the threshold it
 * becomes a reorder drag and the click is suppressed. That threshold IS the
 * "dragging must not focus a video" requirement — not an add-on to it.
 *
 * Hand-rolled rather than dnd-kit: the activation constraint we'd configure
 * there is the same few lines, and this keeps mouse and touch on one path for
 * the shared mobile shell.
 */
export const DRAG_THRESHOLD_PX = 5;

interface DragState {
	source: string;
	startX: number;
	startY: number;
	dragging: boolean;
	cancelled: boolean;
}

/** Which tile's box contains `clientX`, read off the strip's DOM children. */
function sourceAtX(
	target: EventTarget & HTMLButtonElement,
	clientX: number,
): string | null {
	const strip = target.parentElement;
	if (!strip) return null;
	for (const child of Array.from(strip.children) as HTMLElement[]) {
		const source = child.dataset?.source;
		if (!source) continue;
		const { left, right } = child.getBoundingClientRect();
		if (clientX >= left && clientX <= right) return source;
	}
	return null;
}

export function useThumbnailReorder(onReorder: (from: string, to: string) => void) {
	const dragRef = useRef<DragState | null>(null);
	// Set on a completed drag, read-and-cleared by the tile's onClick guard.
	const suppressClickRef = useRef(false);
	const [dragSource, setDragSource] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<string | null>(null);

	const reset = useCallback(() => {
		dragRef.current = null;
		setDragSource(null);
		setDropTarget(null);
	}, []);

	/** Returns whether a drag just ended, clearing the flag so it can't leak
	 *  into the next genuine click. */
	const consumeSuppressedClick = useCallback(() => {
		const suppressed = suppressClickRef.current;
		suppressClickRef.current = false;
		return suppressed;
	}, []);

	const handlers = useCallback(
		(source: string) => ({
			onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
				dragRef.current = {
					source,
					startX: e.clientX,
					startY: e.clientY,
					dragging: false,
					cancelled: false,
				};
				// Keep receiving moves even if the pointer leaves this tile.
				e.currentTarget.setPointerCapture?.(e.pointerId);
			},
			onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
				const drag = dragRef.current;
				if (!drag || drag.cancelled) return;
				if (!drag.dragging) {
					const dx = e.clientX - drag.startX;
					const dy = e.clientY - drag.startY;
					if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
					drag.dragging = true;
					setDragSource(drag.source);
				}
				setDropTarget(sourceAtX(e.currentTarget, e.clientX));
			},
			onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
				const drag = dragRef.current;
				if (!drag) return;
				if (drag.dragging && !drag.cancelled) {
					const target = sourceAtX(e.currentTarget, e.clientX);
					if (target && target !== drag.source) onReorder(drag.source, target);
					// Suppress even a no-op drop: the gesture was a drag, not a click.
					suppressClickRef.current = true;
				}
				e.currentTarget.releasePointerCapture?.(e.pointerId);
				reset();
			},
			onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
				e.currentTarget.releasePointerCapture?.(e.pointerId);
				reset();
			},
			onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
				if (e.key === "Escape" && dragRef.current?.dragging) {
					dragRef.current.cancelled = true;
					setDragSource(null);
					setDropTarget(null);
				}
			},
		}),
		[onReorder, reset],
	);

	return { dragSource, dropTarget, consumeSuppressedClick, handlers };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/useThumbnailReorder.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/useThumbnailReorder.ts packages/frontend/src/Applications/TV/useThumbnailReorder.test.ts
git commit --no-verify -m "feat(tv): pointer-drag reorder hook with click suppression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Persistence — `ClassicyAppTVSetChannelOrder`

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TVContext.ts` (add action creator near `tvSetCurrentChannel` ~line 106; add reducer case before `default:` ~line 203)
- Test: `packages/frontend/src/Applications/TV/TVContext.test.ts` (append)

**Interfaces:**
- Produces: `tvSetChannelOrder(channelOrder: string[]): ActionMessage` with `type: "ClassicyAppTVSetChannelOrder"`, writing `apps["TV.app"].data.channelOrder`.

- [ ] **Step 1: Write the failing tests** (append to `TVContext.test.ts`, matching the file's existing store-fixture style)

```ts
describe("ClassicyAppTVSetChannelOrder", () => {
	it("persists the channel order", () => {
		const ds = storeWith({ volumeLimit: 0.5 });
		const next = classicyTVEventHandler(ds, tvSetChannelOrder(["WCBS", "WABC"]));
		expect(next.System.Manager.Applications.apps["TV.app"].data.channelOrder).toEqual([
			"WCBS",
			"WABC",
		]);
	});

	it("preserves unrelated fields", () => {
		const ds = storeWith({ volumeLimit: 0.5, captionsOn: true });
		const next = classicyTVEventHandler(ds, tvSetChannelOrder(["WABC"]));
		const data = next.System.Manager.Applications.apps["TV.app"].data;
		expect(data.volumeLimit).toBe(0.5);
		expect(data.captionsOn).toBe(true);
	});

	it("accepts an empty order (reset to default ordering)", () => {
		const ds = storeWith({ channelOrder: ["WABC"] });
		const next = classicyTVEventHandler(ds, tvSetChannelOrder([]));
		expect(next.System.Manager.Applications.apps["TV.app"].data.channelOrder).toEqual([]);
	});
});
```

Note: reuse the existing fixture helper in this file for building a store. If it is named differently from `storeWith`, use the existing name rather than adding a second helper — read the top of `TVContext.test.ts` first and match it, and import `tvSetChannelOrder` alongside the file's existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts`
Expected: FAIL — `tvSetChannelOrder` is not exported.

- [ ] **Step 3: Implement** — add the action creator after `tvSetCurrentChannel` in `TVContext.ts`:

```ts
/**
 * The user's drag-ordered channel slugs for the thumbnail strip. Stored as
 * `item.source` values, not ids: ids change on every program rollover.
 * Classicy snapshots app data to localStorage, so this persists per-user with
 * no storage code here.
 */
export const tvSetChannelOrder = (channelOrder: string[]): ActionMessage => ({
	type: "ClassicyAppTVSetChannelOrder",
	channelOrder,
});
```

and the reducer case immediately before `default:`:

```ts
		case "ClassicyAppTVSetChannelOrder":
			apps[appId].data = {
				...appData,
				channelOrder: action.channelOrder as string[],
			};
			return ds;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TVContext.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TVContext.ts packages/frontend/src/Applications/TV/TVContext.test.ts
git commit --no-verify -m "feat(tv): persist channelOrder via ClassicyAppTVSetChannelOrder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the strip in `TV.tsx` + styles

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TV.tsx` (imports; ordering near the `items` read ~line 149; strip JSX ~lines 1041-1093)
- Modify: `packages/frontend/src/Applications/TV/TV.module.scss` (`.tvPlayer` ~line 189)

**Interfaces:**
- Consumes: `orderChannels`, `moveChannel` (Task 1); `useThumbnailReorder` (Task 2); `tvSetChannelOrder` (Task 3).

- [ ] **Step 1: Add imports and ordering state to `TV.tsx`**

Add to the existing import block:

```ts
import { moveChannel, orderChannels } from "./channelOrder";
import { useThumbnailReorder } from "./useThumbnailReorder";
```

and add `tvSetChannelOrder` to the existing `./TVContext` import.

After the `const { items } = useMediaStream(tvFilter);` line (~149), add:

```ts
	// User's drag-ordered channel slugs; empty until the first reorder.
	const channelOrder = (appState?.data?.channelOrder as string[] | undefined) ?? [];
	// The strip's order: user's arrangement first, everything else in the order
	// the stream (or, later, the server) supplies.
	const orderedItems = useMemo(
		() => orderChannels(items, channelOrder),
		[items, channelOrder],
	);
	const handleReorder = useCallback(
		(from: string, to: string) => {
			const visible = orderedItems
				.map((i) => i.source)
				.filter((s): s is string => Boolean(s));
			desktopEventDispatch(tvSetChannelOrder(moveChannel(channelOrder, visible, from, to)));
		},
		[orderedItems, channelOrder, desktopEventDispatch],
	);
	const reorder = useThumbnailReorder(handleReorder);
```

- [ ] **Step 2: Rewrite the strip JSX** — replace the `items.map(...)` block (~1042) with `orderedItems.map(...)`, add `data-source`, the drag handlers, drag/drop classes, and the click guard. The full replacement `<button>` element:

```tsx
								<button
									key={item.id}
									data-source={item.source}
									className={[
										styles.tvPlayer,
										isActive || isSelected ? styles.tvPlayerSelected : "",
										reorder.dragSource === item.source ? styles.tvPlayerDragging : "",
										reorder.dropTarget === item.source &&
										reorder.dragSource !== item.source
											? styles.tvPlayerDropTarget
											: "",
									]
										.filter(Boolean)
										.join(" ")}
									{...(item.source ? reorder.handlers(item.source) : {})}
									onClick={() => {
										// A drag just ended — it must not focus or select.
										if (reorder.consumeSuppressedClick()) return;
										if (multiSelectMode) {
											togglePlayerSelection(item.id);
										} else {
											setActivePlayer(item.id);
										}
										setHasInteracted(true);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											if (multiSelectMode) {
												togglePlayerSelection(item.id);
											} else {
												setActivePlayer(item.id);
											}
											setHasInteracted(true);
										}
									}}
									type="button"
								>
```

The tile's inner content (`tvChannelTitleHolder` div and `img`) is unchanged.

**Note on handler composition:** `reorder.handlers(source)` supplies `onKeyDown` (Escape-to-cancel) and the spread sits **before** the explicit `onKeyDown`, so the explicit Enter/Space handler wins — the existing keyboard path stays behaviorally identical, which is required. Escape-cancel during a pointer drag therefore only takes effect via the hook's internal state on pointer-up; this is acceptable and matches the spec's pointer-only scope.

- [ ] **Step 3: Add styles** to `TV.module.scss` inside the `.tvPlayer` rule (after `aspect-ratio: 4/3;`):

```scss
  // Pointer drags reorder the strip; without this, touch devices scroll the
  // overflow-x container instead of dragging.
  touch-action: none;

  &.tvPlayerDragging {
    opacity: 0.5;
  }

  &.tvPlayerDropTarget {
    box-shadow: inset 2px 0 0 0 var(--color-system-07);
  }
```

- [ ] **Step 4: Verify build and existing tests**

Run: `pnpm --filter @rt911/frontend exec tsc -b`
Expected: no errors.
Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/`
Expected: PASS — all existing TV tests (`TV.embed.test.tsx`, `TVContext.test.ts`, `abr`, `clockDrift`, `volume`) plus the new ones.
Run: `pnpm --filter @rt911/frontend exec eslint .`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TV.tsx packages/frontend/src/Applications/TV/TV.module.scss
git commit --no-verify -m "feat(tv): drag-to-reorder thumbnails in the channel strip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Integration test — click still focuses, drag does not

**Files:**
- Create: `packages/frontend/src/Applications/TV/TV.reorder.test.tsx`

**Interfaces:**
- Consumes: the wired `TV.tsx` from Task 4.

- [ ] **Step 1: Write the failing test.** Copy the mock scaffold from `TV.embed.test.tsx` (the `vi.hoisted` `mockAppData`/`mockItems`, the `vi.mock("classicy", …)` block, and the `useMediaStream` mock) verbatim — it is the only harness that renders `<TV />` — then add:

```tsx
afterEach(() => {
	cleanup();
	mockAppData.value = {};
	mockItems.value = null;
});

// jsdom has no layout: give each tile a box so drop-target resolution works.
function stubTileBoxes() {
	const tiles = document.querySelectorAll<HTMLElement>("[data-source]");
	tiles.forEach((tile, i) => {
		tile.getBoundingClientRect = () =>
			({ left: i * 100, right: (i + 1) * 100, top: 0, bottom: 90 }) as DOMRect;
	});
}

describe("TV thumbnail reorder", () => {
	it("a plain click still focuses the channel", () => {
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		const tile = document.querySelector('[data-source="WNBC"]') as HTMLElement;
		fireEvent.pointerDown(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(tile);
		// Focusing dispatches the active-player action for the clicked channel.
		expect(
			dispatched.some((a) => a.type === "ClassicyAppTVSetActivePlayer" && a.activePlayer === 8),
		).toBe(true);
	});

	it("a drag reorders and does not focus", () => {
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		stubTileBoxes();
		const tile = document.querySelector('[data-source="WABC"]') as HTMLElement;
		dispatched.length = 0;
		fireEvent.pointerDown(tile, { clientX: 10, clientY: 10, pointerId: 1 });
		fireEvent.pointerMove(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(tile);
		expect(
			dispatched.some(
				(a) =>
					a.type === "ClassicyAppTVSetChannelOrder" &&
					JSON.stringify(a.channelOrder) === JSON.stringify(["WNBC", "WABC"]),
			),
		).toBe(true);
		expect(dispatched.some((a) => a.type === "ClassicyAppTVSetActivePlayer")).toBe(false);
	});

	it("a plain click in multiview mode still toggles selection", () => {
		mockAppData.value = { multiSelectMode: true };
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		const tile = document.querySelector('[data-source="WNBC"]') as HTMLElement;
		dispatched.length = 0;
		fireEvent.pointerDown(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.pointerUp(tile, { clientX: 150, clientY: 10, pointerId: 1 });
		fireEvent.click(tile);
		expect(
			dispatched.some(
				(a) => a.type === "ClassicyAppTVSetGridState" && a.selectedPlayers?.includes(8),
			),
		).toBe(true);
	});

	it("renders channels in the saved order", () => {
		mockAppData.value = { channelOrder: ["WNBC", "WABC"] };
		mockItems.value = [FAKE_ITEM, FAKE_ITEM_2];
		render(<TV />);
		const sources = Array.from(document.querySelectorAll("[data-source]")).map((el) =>
			el.getAttribute("data-source"),
		);
		expect(sources).toEqual(["WNBC", "WABC"]);
	});
});
```

The scaffold needs a `dispatched` array capturing dispatches: in the `vi.mock("classicy", …)` block, make `useAppManagerDispatch` return `(a: Record<string, unknown>) => { dispatched.push(a); }` with `const dispatched = vi.hoisted(() => [] as Record<string, unknown>[])`. If `TV.embed.test.tsx` already captures dispatches, reuse its mechanism rather than adding a second one.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV/TV.reorder.test.tsx`
Expected: FAIL before Task 4's wiring exists; after Task 4, iterate on scaffold details until green.

- [ ] **Step 3: Make it pass.** No production code should be needed — if a test fails, first confirm whether it's a harness detail (missing `pointerId`, jsdom `setPointerCapture` absent) or a genuine defect in Tasks 1-4. jsdom does not implement `setPointerCapture`; the hook uses optional-call (`?.`) so this is safe, but if the mock element lacks it entirely, add a no-op in the scaffold rather than changing production code.

- [ ] **Step 4: Full verification**

Run: `pnpm --filter @rt911/frontend exec vitest run`
Expected: full frontend suite PASS.
Run: `pnpm --filter @rt911/frontend exec tsc -b && pnpm --filter @rt911/frontend exec eslint .`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/TV/TV.reorder.test.tsx
git commit --no-verify -m "test(tv): click focuses, drag reorders without focusing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: ordering + precedence (Task 1), drag/threshold/suppression (Task 2), persistence (Task 3), wiring + `touch-action` + visual feedback (Task 4), regression guard (Task 5). Non-goals (keyboard reorder, server ordering, cross-device sync) intentionally have no task.
- Naming is consistent across tasks: `orderChannels`, `moveChannel`, `useThumbnailReorder`, `consumeSuppressedClick`, `tvSetChannelOrder`, `channelOrder`, `DRAG_THRESHOLD_PX`.
- `moveChannel` takes `visibleOrder` as its second parameter in every task that references it.
