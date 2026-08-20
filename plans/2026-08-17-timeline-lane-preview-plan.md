# Timeline Sticky Labels and Lane Previews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a timeline item's label visible at the left of the viewport while scrolling or zooming, and expand a clicked lane to preview the item — thumbnails for TV, waveform for radio.

**Architecture:** Both features pin content to the visible left edge of a track that is `zoom * 100%` wide inside a scrolling container, using `position: sticky; left: 0`. Preview type dispatches on the existing `MEDIA_SECTIONS` predicates. TV thumbnails come from an existing URL convention; radio waveforms come from peaks precomputed by a new video-grabber flow.

**Tech Stack:** React + TypeScript + Vite, vitest, Playwright, SCSS modules; Python + Prefect + ffmpeg (video-grabber); Directus schema via the infra repo's PreSync hook.

**Spec:** `plans/2026-08-17-timeline-lane-preview-design.md`

## Global Constraints

- Repo conventions live in `packages/frontend/CLAUDE.md`; read it before touching the frontend.
- Co-locate tests: `Foo.test.tsx` beside `Foo.tsx`; pure logic gets its own `*.test.ts`.
- New test files need `afterEach(cleanup)` — this repo has no RTL auto-cleanup.
- `classicy` is external and pinned to `"latest"`; never hand-edit its version.
- Frontend gates: `pnpm exec tsc -b`, `pnpm exec eslint .`, `pnpm exec vitest run` must all pass.
- video-grabber gates: `pytest tests/ -v` and `ruff check video_grabber/ tests/`.
- Directus schema changes go through `Keeping-History/infra`, never by hand. Regenerate `snapshot.json` with `GET /schema/snapshot` (the CLI's format is rejected by `POST /schema/diff`), against a database that already has the raw indexes.
- Every commit carries `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Three PRs, in order.** Phase 1 and 2 are frontend-only and independently shippable. Phase 3 spans video-grabber + infra + frontend; start it only after 1 and 2 are merged.

---

## Phase 1 — Sticky lane labels (PR 1)

### Task 1: Move the label out of the bar so it can stick

**Files:**
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistTimeline.tsx` (the `bars.map` block, ~line 319-340)
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.scss` (`.playlistTimelineBar`, ~line 129)
- Test: `packages/frontend/e2e/tests/playlist-editor.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: CSS classes `.playlistTimelineLabelTrack` and `.playlistTimelineLabel`, used by Task 4's preview wrapper for the same sticky treatment.

**The trap this task exists to avoid.** `.playlistTimelineBar` currently sets
`overflow: hidden`, and the label is rendered inside it. `position: sticky`
resolves against the nearest ancestor with a scrolling box — and `overflow:
hidden` *is* a scrolling box, just one the user cannot scroll. A sticky label
inside the bar therefore sticks to the bar, which never scrolls, and nothing
appears to happen. The label must live outside any `overflow: hidden` ancestor,
and the wrapper that clips it must clip with `clip-path` (which creates no
scroll container) rather than `overflow`.

- [ ] **Step 1: Write the failing e2e test**

Append to `packages/frontend/e2e/tests/playlist-editor.spec.ts`:

```ts
test("lane label stays visible when the timeline is scrolled", async ({ page }) => {
	await openPlaylistWithEntries(page);          // existing helper in this spec
	await page.getByRole("button", { name: "Zoom in" }).click();
	await page.getByRole("button", { name: "Zoom in" }).click();

	const label = page.locator(".playlistTimelineLabel").first();
	const timeline = page.locator(".playlistTimeline");
	await expect(label).toBeVisible();

	await timeline.evaluate((el) => { el.scrollLeft = el.scrollWidth / 3; });

	// The label must still be inside the viewport, not scrolled off to the left.
	const box = await label.boundingBox();
	const view = await timeline.boundingBox();
	expect(box).not.toBeNull();
	expect(view).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(view!.x - 1);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rt911/frontend exec playwright test e2e/tests/playlist-editor.spec.ts -g "stays visible"`
Expected: FAIL — `.playlistTimelineLabel` does not exist yet.

- [ ] **Step 3: Render the label as a sibling of the bar**

In `PlaylistTimeline.tsx`, inside `bars.map`, remove the bare `{b.label}` from
the `<button>` children and add a sibling *after* the button, still inside the
lane:

```tsx
<div
	className="playlistTimelineLabelTrack"
	style={{
		left: `${startFrac * 100}%`,
		width: `${(endFrac - startFrac) * 100}%`,
	}}
	aria-hidden
>
	<span className="playlistTimelineLabel">{b.label}</span>
</div>
```

`aria-hidden` because the bar's `title` and its accessible name already carry
the label; a second copy would double-announce it.

- [ ] **Step 4: Add the CSS**

In `PlaylistEditor.scss`, after `.playlistTimelineBar`:

```scss
/* The label rides above the bar rather than inside it. `position: sticky`
 * resolves against the nearest ancestor with a scrolling box, and
 * `overflow: hidden` counts as one — so a label inside .playlistTimelineBar
 * would stick to the bar, which never scrolls, and nothing would happen.
 *
 * Clipping is therefore done with clip-path, which bounds the label to its
 * item's span without creating a scroll container the way overflow would. */
.playlistTimelineLabelTrack {
	position: absolute;
	top: 0;
	height: 100%;
	clip-path: inset(0);
	pointer-events: none;
	display: flex;
	align-items: center;
}

.playlistTimelineLabel {
	position: sticky;
	left: 0;
	white-space: nowrap;
	padding-inline: 2px;
}
```

- [ ] **Step 5: Run the e2e test**

Run: `pnpm --filter @rt911/frontend exec playwright test e2e/tests/playlist-editor.spec.ts -g "stays visible"`
Expected: PASS

- [ ] **Step 6: Run the full frontend gates**

Run: `pnpm exec tsc -b && pnpm exec eslint . && pnpm exec vitest run`
Expected: all pass. Existing `PlaylistTimeline` tests that asserted label text
inside the bar may need their selector updated to `.playlistTimelineLabel`;
update them rather than reverting the structure.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/PlaylistTimeline.tsx \
        packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.scss \
        packages/frontend/e2e/tests/playlist-editor.spec.ts
git commit -m "$(cat <<'EOF'
feat(playlist): pin timeline lane labels to the visible left edge

A lane spans a track that is zoom*100% wide inside a scrolling container, so a
label positioned by the bar's left edge scrolls out of view — worse the further
you zoom, which is exactly when labels matter most.

The label moves out of .playlistTimelineBar because that element sets
overflow: hidden, and position: sticky resolves against the nearest ancestor
with a scrolling box. overflow: hidden is one, so a sticky label inside the bar
sticks to the bar, which never scrolls, and nothing happens. The new wrapper
clips with clip-path instead, which bounds the label to its item's span without
creating a scroll container.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — TV thumbnail strips (PR 2)

### Task 2: Extract the media-type predicates

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/mediaSections.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/mediaSections.test.ts`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.tsx` (remove the local `MEDIA_SECTIONS`, import instead)

**Interfaces:**
- Consumes: `MediaEntry`, `EditorEntry` from `./editorState`; `BROADCAST_STATIONS` from the RadioTuner split.
- Produces: `previewKindOf(entry: MediaEntry): "tv" | "radio" | null` — Task 4 dispatches on this. Also re-exports `MEDIA_SECTIONS` unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { previewKindOf } from "./mediaSections";

describe("previewKindOf", () => {
	it("classifies TV entries", () => {
		expect(previewKindOf({ app: "tv", itemId: "cnn" } as never)).toBe("tv");
	});

	it("classifies both broadcast stations and comm traffic as radio", () => {
		// The palette splits these into two sections; previewing does not —
		// both render a waveform.
		expect(previewKindOf({ app: "radio", itemId: "WCBS" } as never)).toBe("radio");
		expect(previewKindOf({ app: "radio", itemId: "ZOB" } as never)).toBe("radio");
	});

	it("returns null for kinds with no preview", () => {
		expect(previewKindOf({ app: "news", itemId: "x" } as never)).toBeNull();
		expect(previewKindOf({ app: "flights", itemId: "AA11" } as never)).toBeNull();
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/mediaSections.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the module**

Move the `MediaSection` type, `isBroadcastStation`, and `MEDIA_SECTIONS` verbatim
out of `PlaylistEditorMain.tsx` into `mediaSections.ts`, export them, and add:

```ts
/**
 * Which preview a media entry gets, or null for none.
 *
 * Both radio sections collapse to "radio": the palette splits broadcast
 * stations from comm traffic because they are browsed differently, but a
 * waveform is a waveform.
 */
export function previewKindOf(entry: MediaEntry): "tv" | "radio" | null {
	if (entry.app === "tv") return "tv";
	if (entry.app === "radio") return "radio";
	return null;
}
```

- [ ] **Step 4: Update the import in PlaylistEditorMain.tsx**

Replace the deleted definitions with:

```ts
import { MEDIA_SECTIONS } from "./mediaSections";
```

- [ ] **Step 5: Run the gates**

Run: `pnpm exec tsc -b && pnpm exec vitest run src/Applications/PlaylistEditor/`
Expected: PASS, including the existing `PlaylistEditorMain` tests unchanged —
the predicates moved, their behaviour did not.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/mediaSections.ts \
        packages/frontend/src/Applications/PlaylistEditor/mediaSections.test.ts \
        packages/frontend/src/Applications/PlaylistEditor/PlaylistEditorMain.tsx
git commit -m "$(cat <<'EOF'
refactor(playlist): lift MEDIA_SECTIONS into its own module

The timeline preview needs to classify an entry the same way the media palette
does. Sharing the predicates keeps the two surfaces from drifting into
disagreeing about what a TV entry is; duplicating them guarantees they
eventually will.

Adds previewKindOf, which collapses both radio sections to one preview kind —
the palette splits broadcast stations from comm traffic because they are
browsed differently, but a waveform is a waveform.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: Thumbnail bucket arithmetic

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/thumbnailBuckets.ts`
- Create: `packages/frontend/src/Applications/PlaylistEditor/thumbnailBuckets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `thumbnailBuckets(args: {startMs: number; endMs: number; viewportPx: number; tilePx?: number}): number[]` — returns 30s-bucket epoch-second timestamps. Task 4 maps these to URLs.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { BUCKET_SECONDS, thumbnailBuckets } from "./thumbnailBuckets";

const at = (h: number, m: number, s = 0) => Date.UTC(2001, 8, 11, h, m, s);

describe("thumbnailBuckets", () => {
	it("fills the available width when enough buckets exist", () => {
		// One hour of span, 800px of viewport, 100px tiles => 8 tiles.
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(13, 0), viewportPx: 800, tilePx: 100,
		});
		expect(out).toHaveLength(8);
	});

	it("caps at the buckets a short span actually contains", () => {
		// Thumbnails exist every 30s, so two minutes holds four of them however
		// much room there is. Asking for more would return duplicates or 404s.
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(12, 2), viewportPx: 2000, tilePx: 100,
		});
		expect(out).toHaveLength(4);
	});

	it("returns one thumbnail for a span shorter than a bucket", () => {
		const out = thumbnailBuckets({
			startMs: at(12, 0), endMs: at(12, 0, 10), viewportPx: 800, tilePx: 100,
		});
		expect(out).toHaveLength(1);
	});

	it("snaps every timestamp to the 30s grid the images exist at", () => {
		const out = thumbnailBuckets({
			startMs: at(12, 0, 17), endMs: at(12, 5), viewportPx: 400, tilePx: 100,
		});
		for (const ts of out) expect(ts % BUCKET_SECONDS).toBe(0);
	});

	it("returns nothing when there is no room to draw", () => {
		expect(thumbnailBuckets({
			startMs: at(12, 0), endMs: at(13, 0), viewportPx: 0, tilePx: 100,
		})).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/thumbnailBuckets.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Which thumbnails to show for an entry's visible span.
 *
 * Thumbnails exist only on a 30-second grid (see TV/ThumbnailTile.tsx), so the
 * count is bounded twice: by how many tiles fit, and by how many distinct
 * images the span actually contains. The second bound is the important one — a
 * two-minute entry has four thumbnails no matter how wide the window is, and
 * requesting more would render duplicates or fall back to offline.jpg, which
 * reads as broken rather than as "this is all there is".
 */
export const BUCKET_SECONDS = 30;

const DEFAULT_TILE_PX = 96;

export function thumbnailBuckets({
	startMs,
	endMs,
	viewportPx,
	tilePx = DEFAULT_TILE_PX,
}: {
	startMs: number;
	endMs: number;
	viewportPx: number;
	tilePx?: number;
}): number[] {
	const fit = Math.floor(viewportPx / tilePx);
	if (fit < 1 || endMs <= startMs) return [];

	const startBucket = Math.floor(startMs / 1000 / BUCKET_SECONDS);
	const endBucket = Math.floor((endMs - 1) / 1000 / BUCKET_SECONDS);
	const available = endBucket - startBucket + 1;

	const count = Math.min(fit, available);
	const stride = available / count;

	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const bucket = startBucket + Math.floor(i * stride);
		out.push(bucket * BUCKET_SECONDS);
	}
	return out;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/thumbnailBuckets.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/thumbnailBuckets.ts \
        packages/frontend/src/Applications/PlaylistEditor/thumbnailBuckets.test.ts
git commit -m "$(cat <<'EOF'
feat(playlist): derive the thumbnail strip for a visible span

Pure arithmetic, kept out of the render path so the "how many fit, at what
interval" rule is testable without mounting anything — the same split
timelineLayout.ts already uses for zoom.

The cap is the load-bearing part. Thumbnails exist only every 30 seconds, so a
two-minute entry holds four of them however wide the window is. Filling the
available width instead would request duplicates or 404s, and a row of
offline.jpg placeholders reads as broken rather than as "this is all there is".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: The lane preview, TV half

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/LanePreview.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/LanePreview.test.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistTimeline.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/PlaylistEditor.scss`

**Interfaces:**
- Consumes: `previewKindOf` (Task 2), `thumbnailBuckets` + `BUCKET_SECONDS` (Task 3), `.playlistTimelineLabel` sticky pattern (Task 1).
- Produces: `<LanePreview entry={MediaEntry} startMs={number} endMs={number} viewportPx={number} />`. Task 7 adds the radio branch to this same component.

- [ ] **Step 1: Write the failing test**

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanePreview } from "./LanePreview";

afterEach(cleanup);

const tvEntry = { app: "tv", itemId: "cnn" } as never;
const span = { startMs: Date.UTC(2001, 8, 11, 12, 0), endMs: Date.UTC(2001, 8, 11, 12, 30) };

describe("LanePreview", () => {
	it("renders a thumbnail strip for TV entries", () => {
		render(<LanePreview entry={tvEntry} {...span} viewportPx={400} />);
		const imgs = screen.getAllByRole("img");
		expect(imgs.length).toBeGreaterThan(0);
		expect(imgs[0]).toHaveProperty(
			"src",
			expect.stringContaining("files.911realtime.org/thumbnails/cnn/"),
		);
	});

	it("renders nothing for an entry kind with no preview", () => {
		const { container } = render(
			<LanePreview entry={{ app: "news", itemId: "x" } as never} {...span} viewportPx={400} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when there is no room", () => {
		const { container } = render(<LanePreview entry={tvEntry} {...span} viewportPx={0} />);
		expect(container).toBeEmptyDOMElement();
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/LanePreview.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

```tsx
import type { MediaEntry } from "./editorState";
import { previewKindOf } from "./mediaSections";
import { thumbnailBuckets } from "./thumbnailBuckets";

const THUMB_BASE = "https://files.911realtime.org/thumbnails";
const OFFLINE = `${THUMB_BASE}/offline.jpg`;

export function LanePreview({
	entry,
	startMs,
	endMs,
	viewportPx,
}: {
	entry: MediaEntry;
	startMs: number;
	endMs: number;
	viewportPx: number;
}) {
	const kind = previewKindOf(entry);
	if (kind !== "tv") return null;

	const buckets = thumbnailBuckets({ startMs, endMs, viewportPx });
	if (buckets.length === 0) return null;

	const channel = entry.itemId.toLowerCase();
	return (
		// Sticky for the same reason the label is: the lane is far wider than
		// the viewport once zoomed, so content anchored to the lane's left edge
		// would sit off-screen.
		<div className="playlistTimelinePreview">
			{buckets.map((ts) => (
				<img
					key={ts}
					className="playlistTimelinePreviewThumb"
					src={`${THUMB_BASE}/${channel}/${ts}.jpg`}
					onError={(e) => {
						e.currentTarget.src = OFFLINE;
					}}
					alt=""
				/>
			))}
		</div>
	);
}
```

- [ ] **Step 4: Add the CSS**

```scss
/* Sticky for the same reason .playlistTimelineLabel is — see the note there.
 * The lane is zoom*100% wide, so anything anchored to its left edge sits
 * off-screen the moment the user scrolls. */
.playlistTimelinePreview {
	position: sticky;
	left: 0;
	display: flex;
	gap: 2px;
	padding: 2px 0;
}

.playlistTimelinePreviewThumb {
	height: 54px;
	width: auto;
}
```

- [ ] **Step 5: Wire it into the timeline**

In `PlaylistTimeline.tsx`, add a ref and width measurement on the scroll
container (there is already an `anchorRef` pattern on it to copy), then inside
`bars.map`, after the `.playlistTimelineLabelTrack` div:

```tsx
{b.uid === selectedUid && b.entry && (
	<LanePreview
		entry={b.entry}
		startMs={fractionToMs(startFrac, bounds)}
		endMs={fractionToMs(endFrac, bounds)}
		viewportPx={viewportPx}
	/>
)}
```

The lane grows to fit because `.playlistTimelineLane` has a fixed `height: 20px`
— change it to `min-height: 20px` so an expanded lane can take the space.

- [ ] **Step 6: Run the gates**

Run: `pnpm exec tsc -b && pnpm exec eslint . && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "$(cat <<'EOF'
feat(playlist): preview TV entries as a thumbnail strip

Clicking a lane expands it to show thumbnails across the entry's visible span.
The strip is sticky for the same reason the label is: the lane is zoom*100%
wide, so content anchored to its left edge sits off-screen once scrolled.

"More images as you zoom" is emergent rather than a code path — zooming widens
the visible span, so more distinct 30s buckets become addressable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Peaks pipeline and waveforms (PR 3)

### Task 5: Peak extraction (pure)

**Files:**
- Create: `packages/tools/video-grabber/video_grabber/peaks/__init__.py` (empty)
- Create: `packages/tools/video-grabber/video_grabber/peaks/extract.py`
- Create: `packages/tools/video-grabber/tests/test_peaks_extract.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `PEAK_BUCKETS: int = 480`; `peaks_from_pcm(samples: bytes, buckets: int = PEAK_BUCKETS) -> list[list[int]]` returning `buckets` pairs of `[min, max]` scaled to -128..127. Task 6 calls it after running ffmpeg.

- [ ] **Step 1: Write the failing test**

```python
import struct

from video_grabber.peaks.extract import PEAK_BUCKETS, peaks_from_pcm


def pcm(values):
    """Signed 16-bit little-endian mono, the format ffmpeg is asked for."""
    return b"".join(struct.pack("<h", v) for v in values)


def test_silence_yields_flat_peaks_rather_than_raising():
    out = peaks_from_pcm(pcm([0] * 4800), buckets=10)
    assert len(out) == 10
    assert all(lo == 0 and hi == 0 for lo, hi in out)


def test_full_scale_reaches_the_extremes():
    out = peaks_from_pcm(pcm([32767, -32768] * 2400), buckets=10)
    assert max(hi for _, hi in out) == 127
    assert min(lo for lo, _ in out) == -128


def test_bucket_count_is_fixed_regardless_of_length():
    short = peaks_from_pcm(pcm([1000] * 1000))
    long = peaks_from_pcm(pcm([1000] * 1_000_000))
    assert len(short) == len(long) == PEAK_BUCKETS


def test_a_file_shorter_than_the_bucket_count_still_fills_every_bucket():
    out = peaks_from_pcm(pcm([500] * 10), buckets=100)
    assert len(out) == 100


def test_empty_input_yields_flat_peaks():
    assert peaks_from_pcm(b"", buckets=5) == [[0, 0]] * 5
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd packages/tools/video-grabber && pytest tests/test_peaks_extract.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```python
"""Reduce an audio file to a fixed-size amplitude envelope.

A fixed bucket count is the point. The corpus runs from 40-second clips to
6.75-hour position tapes, and storing per-file resolution would make the blob
size and the renderer both variable for no benefit at preview size. 480 pairs
is ~2 KB whatever the duration, and the component always draws 480 values
across whatever width it has.
"""
from __future__ import annotations

import struct

PEAK_BUCKETS = 480


def peaks_from_pcm(samples: bytes, buckets: int = PEAK_BUCKETS) -> list[list[int]]:
    """Signed 16-bit mono PCM -> `buckets` [min, max] pairs scaled to -128..127.

    Scaling to a byte range keeps the stored JSON small; a waveform drawn at
    preview height cannot show more precision than that anyway.
    """
    count = len(samples) // 2
    if count == 0:
        return [[0, 0] for _ in range(buckets)]

    values = struct.unpack(f"<{count}h", samples[: count * 2])
    out: list[list[int]] = []
    for i in range(buckets):
        lo_idx = (i * count) // buckets
        hi_idx = max(((i + 1) * count) // buckets, lo_idx + 1)
        window = values[lo_idx:hi_idx]
        if not window:
            out.append([0, 0])
            continue
        out.append([min(window) >> 8, max(window) >> 8])
    return out
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/tools/video-grabber && pytest tests/test_peaks_extract.py -v && ruff check video_grabber/ tests/`
Expected: PASS (5 tests), ruff clean

- [ ] **Step 5: Commit**

```bash
git add packages/tools/video-grabber/video_grabber/peaks/ \
        packages/tools/video-grabber/tests/test_peaks_extract.py
git commit -m "$(cat <<'EOF'
feat(peaks): reduce audio to a fixed-size amplitude envelope

A fixed 480-bucket count regardless of duration: the corpus runs from
40-second clips to 6.75-hour tapes, and per-file resolution would make both the
stored blob and the renderer variable for no benefit at preview size. 480 pairs
is ~2 KB whatever the file, and the component always draws 480 values.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

### Task 6: The compute-peaks flow

**Files:**
- Create: `packages/tools/video-grabber/video_grabber/peaks/flows.py`
- Create: `packages/tools/video-grabber/tests/test_peaks_flows.py`
- Modify: `packages/tools/video-grabber/video_grabber/serve.py` (register the deployment)
- Modify: `Keeping-History/infra` → `apps/rt911/schema/snapshot.json` (add `mp3_items.peaks`)

**Interfaces:**
- Consumes: `peaks_from_pcm`, `PEAK_BUCKETS` (Task 5); `_page_mp3_items`, `key_from_url` from `video_grabber.catalogue.flows`.
- Produces: `compute_peaks_flow(limit: int | None = None, force: bool = False, dry_run: bool = True)`, and the populated `mp3_items.peaks` field Task 7 reads.

- [ ] **Step 1: Add the schema field in the infra repo**

Regenerate the snapshot from the live database (the CLI's format is rejected by
`POST /schema/diff`, and the snapshot must agree with the raw indexes already
present):

```bash
kubectl -n video-grabber exec deploy/video-grabber-worker -- python -c "
import httpx, json
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
cfg = Config(); H = _auth_headers(cfg)
snap = httpx.get(f'{cfg.directus_url}/schema/snapshot', headers=H, timeout=180).json()['data']
tags = next(f for f in snap['fields'] if f['collection']=='mp3_items' and f['field']=='tags_curated')
peaks = json.loads(json.dumps(tags))
peaks['field'] = 'peaks'
peaks['meta'] = {**peaks['meta'], 'field': 'peaks', 'readonly': True, 'interface': 'input-code',
                 'note': 'Amplitude envelope: 480 [min,max] pairs. DERIVED by compute-peaks.'}
peaks['schema'] = {**peaks['schema'], 'name': 'peaks'}
snap['fields'].append(peaks)
open('/tmp/peaks_snapshot.json','w').write(json.dumps(snap, indent=1, sort_keys=True))
print('written')
"
kubectl -n video-grabber cp <worker-pod>:/tmp/peaks_snapshot.json \
  /home/robbiebyrd/infra/apps/rt911/schema/snapshot.json
```

Commit and push to infra; the PreSync hook applies it. Verify with:

```bash
kubectl -n rt911 exec deploy/rt911-db -- psql -U directus -d directus -tAc \
  "SELECT count(*) FROM information_schema.columns WHERE table_name='mp3_items' AND column_name='peaks';"
```
Expected: `1`

- [ ] **Step 2: Write the failing flow test**

```python
from video_grabber.peaks.flows import should_compute


def test_skips_rows_that_already_have_peaks():
    assert should_compute({"peaks": [[0, 0]]}, force=False) is False


def test_computes_rows_with_no_peaks():
    assert should_compute({"peaks": None}, force=False) is True


def test_force_recomputes_everything():
    assert should_compute({"peaks": [[0, 0]]}, force=True) is True
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd packages/tools/video-grabber && pytest tests/test_peaks_flows.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the flow**

```python
"""Compute an amplitude envelope for every audio recording.

Manual-only and dry_run=True by default, like identify-parties: it writes to
the live catalogue, so nothing should schedule it.
"""
import json
import subprocess
import tempfile
from pathlib import Path

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.flows import _page_mp3_items, key_from_url
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
from video_grabber.peaks.extract import PEAK_BUCKETS, peaks_from_pcm
from video_grabber.storage import wasabi


def should_compute(row: dict, *, force: bool) -> bool:
    """Idempotency marker is `peaks IS NOT NULL`, so a run is resumable."""
    return force or not row.get("peaks")


def pcm_for(path: Path) -> bytes:
    """Decode to 8 kHz signed 16-bit mono — plenty for an envelope, and it
    keeps a 6.75-hour tape's intermediate buffer under 200 MB."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True, check=True,
    )
    return r.stdout


@flow(name="compute-peaks")
def compute_peaks_flow(limit: int | None = None, force: bool = False,
                       dry_run: bool = True) -> None:
    logger = get_run_logger()
    cfg = Config()
    done = skipped = failed = 0

    for row in _page_mp3_items(cfg, "id,url,peaks"):
        if limit is not None and done >= limit:
            break
        if not should_compute(row, force=force):
            skipped += 1
            continue
        key = key_from_url(row["url"])
        try:
            with tempfile.TemporaryDirectory() as tmp:
                local = Path(tmp) / "audio.mp3"
                wasabi.download_file(key, local, cfg)
                peaks = peaks_from_pcm(pcm_for(local), PEAK_BUCKETS)
        except Exception as exc:
            logger.warning("compute-peaks: %s failed: %s: %s", key, type(exc).__name__, exc)
            failed += 1
            continue

        if dry_run:
            logger.info("DRY RUN %s -> %d buckets", key, len(peaks))
        else:
            r = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                            json={"peaks": peaks}, headers=_auth_headers(cfg))
            r.raise_for_status()
        done += 1

    logger.info("compute-peaks: %d computed, %d skipped, %d failed", done, skipped, failed)
```

- [ ] **Step 5: Register the deployment**

In `video_grabber/serve.py`, beside `identify_parties_flow.to_deployment(...)`:

```python
compute_peaks_flow.to_deployment(name="compute-peaks"),
```
and add the import. Registering it is what made `enrich-parties-from-commission`
unreachable when it was skipped once before.

- [ ] **Step 6: Run the gates**

Run: `cd packages/tools/video-grabber && pytest tests/ -v --ignore=tests/test_migrations.py && ruff check video_grabber/ tests/`
Expected: PASS, ruff clean

- [ ] **Step 7: Commit, then run for real**

```bash
git add packages/tools/video-grabber/
git commit -m "$(cat <<'EOF'
feat(peaks): compute-peaks flow over the audio corpus

Manual-only and dry_run=True by default, like identify-parties: it writes to the
live catalogue, so nothing should schedule it. Idempotent on `peaks IS NOT
NULL`.

Decodes at 8 kHz mono, which is ample for an envelope and keeps a 6.75-hour
tape's intermediate buffer under 200 MB rather than several GB at source rate.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

After the image rolls: `compute-peaks limit=5 dry_run=true`, inspect, then
`compute-peaks dry_run=false`.

### Task 7: The waveform component

**Files:**
- Create: `packages/frontend/src/Applications/PlaylistEditor/PeaksWaveform.tsx`
- Create: `packages/frontend/src/Applications/PlaylistEditor/PeaksWaveform.test.tsx`
- Modify: `packages/frontend/src/Applications/PlaylistEditor/LanePreview.tsx` (add the radio branch)

**Interfaces:**
- Consumes: `previewKindOf` (Task 2); `peaks` from the Directus row (Task 6).
- Produces: `<PeaksWaveform peaks={number[][]} height={number} />`.

**Why not reuse `RadioScanner/WaveformVisualizer`.** That component's substance
is Web Audio capture from an `HTMLAudioElement` plus animation-frame
scheduling — it renders what is *playing*. A timeline entry is not playing, and
sharing it would drag an `AudioContext` into a component that needs none.

- [ ] **Step 1: Write the failing test**

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeaksWaveform } from "./PeaksWaveform";

afterEach(cleanup);

describe("PeaksWaveform", () => {
	it("renders a canvas sized to the requested height", () => {
		const peaks = Array.from({ length: 480 }, (_, i) => [-i % 128, i % 128]);
		const { container } = render(<PeaksWaveform peaks={peaks} height={40} />);
		const canvas = container.querySelector("canvas");
		expect(canvas).not.toBeNull();
		expect(canvas!.height).toBe(40);
	});

	it("renders nothing when there are no peaks", () => {
		const { container } = render(<PeaksWaveform peaks={[]} height={40} />);
		expect(container).toBeEmptyDOMElement();
	});
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/PeaksWaveform.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useRef } from "react";

/**
 * A static amplitude envelope drawn from precomputed peaks.
 *
 * Deliberately not an extension of RadioScanner's WaveformVisualizer: that one
 * captures live audio from an HTMLAudioElement and renders what is playing. A
 * timeline entry is not playing, and there is no shared logic between reading
 * an AnalyserNode and drawing a fixed array.
 */
export function PeaksWaveform({
	peaks,
	height,
}: {
	peaks: number[][];
	height: number;
}) {
	const ref = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const { width } = canvas;
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "currentColor";
		const mid = height / 2;
		const step = width / peaks.length;
		peaks.forEach(([lo, hi], i) => {
			const top = mid - (hi / 128) * mid;
			const bottom = mid - (lo / 128) * mid;
			ctx.fillRect(i * step, top, Math.max(step, 1), Math.max(bottom - top, 1));
		});
	}, [peaks, height]);

	if (peaks.length === 0) return null;
	return <canvas ref={ref} height={height} className="playlistTimelineWaveform" />;
}
```

- [ ] **Step 4: Fetch the peaks for the entry's span**

A radio `MediaEntry` carries a **station slug**, not a recording id
(`playlistTypes.ts`: `itemId` is "station slug"), and a window on that station
can cover several `mp3_items` rows or none. So the waveform is assembled from
whatever aired in the window, positioned by time — the same shape as the
thumbnail strip, which is also time-positioned rather than item-positioned.

Create `packages/frontend/src/Applications/PlaylistEditor/usePeaksForSpan.ts`:

```ts
import { useEffect, useState } from "react";
import { directusUrl } from "../../Providers/Auth/directus"; // existing base-URL helper

export type SpanPeaks = { startMs: number; endMs: number; peaks: number[][] };

/**
 * Recordings that aired on `station` during the span, with their envelopes.
 *
 * A radio entry names a station and a window, not a file, so the preview is
 * whatever aired in that window — zero, one, or several recordings drawn at
 * their own time positions.
 */
export function usePeaksForSpan(
	station: string,
	startMs: number,
	endMs: number,
): SpanPeaks[] {
	const [rows, setRows] = useState<SpanPeaks[]>([]);
	useEffect(() => {
		const ctrl = new AbortController();
		const qs = new URLSearchParams({
			"filter[_and][0][source][_eq]": station,
			"filter[_and][1][start_date][_between]":
				`${new Date(startMs).toISOString()},${new Date(endMs).toISOString()}`,
			fields: "start_date,calc_duration,peaks",
			limit: "20",
			sort: "start_date",
		});
		fetch(`${directusUrl()}/items/mp3_items?${qs}`, { signal: ctrl.signal })
			.then((r) => (r.ok ? r.json() : { data: [] }))
			.then((body) => {
				setRows(
					(body.data ?? [])
						.filter((d: { peaks?: number[][] }) => d.peaks?.length)
						.map((d: { start_date: string; calc_duration: number; peaks: number[][] }) => ({
							startMs: Date.parse(`${d.start_date}Z`),
							endMs: Date.parse(`${d.start_date}Z`) + d.calc_duration * 1000,
							peaks: d.peaks,
						})),
				);
			})
			.catch(() => setRows([]));   // a failed preview stays quiet
		return () => ctrl.abort();
	}, [station, startMs, endMs]);
	return rows;
}
```

**`peaks` must be added to the public read field list**, the same way `tags` was:
the anonymous policy on `mp3_items` enumerates its fields rather than granting
`*`, so a new field is invisible until it is listed.

- [ ] **Step 5: Add the radio branch to LanePreview**

Replace the early `if (kind !== "tv") return null;` with:

```tsx
	if (kind === "radio") {
		return <RadioLanePreview station={entry.itemId} startMs={startMs} endMs={endMs} />;
	}
	if (kind !== "tv") return null;
```

and add, in the same file:

```tsx
function RadioLanePreview({
	station, startMs, endMs,
}: { station: string; startMs: number; endMs: number }) {
	const spans = usePeaksForSpan(station, startMs, endMs);
	// Nothing aired, or compute-peaks has not reached these recordings yet:
	// show nothing rather than an empty box, so a missing preview stays quiet.
	if (spans.length === 0) return null;
	const total = endMs - startMs;
	return (
		<div className="playlistTimelinePreview playlistTimelinePreviewRadio">
			{spans.map((s) => (
				<div
					key={s.startMs}
					className="playlistTimelineWaveformSlot"
					style={{
						left: `${((s.startMs - startMs) / total) * 100}%`,
						width: `${((s.endMs - s.startMs) / total) * 100}%`,
					}}
				>
					<PeaksWaveform peaks={s.peaks} height={40} />
				</div>
			))}
		</div>
	);
}
```

Note `.playlistTimelinePreviewRadio` is `position: relative` and the slots are
absolute, so each recording sits at its own moment in the entry's window — which
also means this one is **not** sticky: it must stay aligned with the timeline it
describes, unlike the thumbnail strip, which is a summary rather than a
positioned overlay.

- [ ] **Step 5: Run the gates**

Run: `pnpm exec tsc -b && pnpm exec eslint . && pnpm exec vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/PlaylistEditor/
git commit -m "$(cat <<'EOF'
feat(playlist): preview radio entries as a waveform

Draws the precomputed envelope from mp3_items.peaks. Deliberately not an
extension of RadioScanner's WaveformVisualizer: that component captures live
audio from an HTMLAudioElement and renders what is playing, which shares no
logic with drawing a fixed array and would drag an AudioContext into a
component that needs none.

A recording compute-peaks has not reached yet shows no waveform rather than an
empty box — a missing preview should be quiet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage.** Sticky labels → Task 1. Thumbnail strips with zoom-derived
count → Tasks 3, 4. Waveforms → Tasks 5, 6, 7. Type discrimination → Task 2.
Error handling table → Task 4 Step 3 (no room, wrong kind), Task 7 Step 4
(missing peaks), existing `offline.jpg` fallback (Task 4). Out-of-scope items
(playback, scrubbing) appear in no task, as intended.

**Correction found during self-review.** The first draft of Task 7 read
`entry.peaks`, assuming a playlist entry carries its recording's envelope. It
does not: `MediaEntry` (`Providers/Playlist/playlistTypes.ts`) holds only
`itemId`, which for radio is a **station slug**. A radio entry therefore names a
station and a window, not a file, and that window may contain several
recordings or none.

Task 7 now fetches the recordings overlapping the span and draws each at its own
time position. This also changes a design detail the spec got wrong: the radio
preview is **not** sticky, because it is a positioned overlay that must stay
aligned with the timeline beneath it, unlike the thumbnail strip which is a
summary and should stay in view.

**Second consequence.** `peaks` must be added to the anonymous read field list
on `mp3_items`, which enumerates fields rather than granting `*` — a new field
is invisible to the frontend until listed, the same trap `tags` hit.

**Spec amendment needed.** `plans/2026-08-17-timeline-lane-preview-design.md`
describes radio previews as one waveform per entry. Update its "Radio waveforms"
and "Components" sections to match before executing Phase 3.
