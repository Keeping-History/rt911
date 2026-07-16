# README App — Design

**Date:** 2026-07-16
**Status:** Approved

## Summary

A new Classicy desktop app, **README**, that presents site news/announcements as a
blog: a left-hand list of articles (headline, author, date created) and a main pane
that renders the selected article's rich-text body. Content is authored in Directus
and refreshes in the browser within one minute of an edit. Unlike every other app on
the desktop, README is **not time-gated** — it shows present-day content regardless
of the virtual clock.

## Decisions made

| Question | Decision |
|---|---|
| Content format | Directus **WYSIWYG rich-text field** (stores HTML). No markdown parser; zero new frontend dependencies (DOMPurify already present). |
| Data source | **Direct Directus REST** from the frontend (`useBookmarks.ts` / Feedback precedent for non-time-gated reference data). No streamer channel, no backend changes. |
| Refresh | **Cheap probe, then fetch**: every 60 s, one aggregate query (`count` + `max(date_updated)`); full refetch only when that signature changes. |
| Launch UX | **Regular app only** — no auto-open at boot. |

## Directus collection: `readme_articles`

New collection with Directus's standard optional fields enabled:

- `status` — published / draft / archived (default draft)
- `sort` — integer (unused by the app for ordering, but harmless to have)
- `date_created` — auto-stamped on create
- `date_updated` — auto-stamped on every save (drives the change probe)

Custom fields:

- `headline` — string, required
- `author` — string (plain text, **not** a user relation)
- `body` — WYSIWYG rich-text field (stores HTML)

**Permissions:** the Public role gets read access with a permission **filter** of
`status = published`. (Permission filters are OSS Directus; per-field limits are the
license-gated feature we hit on `flight_positions` and are not needed here — every
field in this collection is public-safe.)

**Provisioning:** collection + permission created via the Directus API where an admin
token is available; otherwise the schema above is hand-created in the admin UI. Seed
one welcome article so the app never ships pointing at an empty collection.

## Frontend app: `src/Applications/README/`

Standard app shape per `packages/frontend/CLAUDE.md`:

- `README.tsx` — `ClassicyApp` (id `"Readme.app"`, name `"README"`, icon, `defaultWindow`)
  wrapping one `ClassicyWindow`; `quitMenuItemHelper` for the Quit item; registered in
  `src/app.tsx` as a child of `ClassicyDesktop`. No seeded `defaultState` entry needed.
- **Layout:** flex row inside the window.
  - **Left pane:** scrollable article list, one row per article showing headline,
    author, and formatted `date_created`. Sorted newest-first. Newest article
    selected by default; selection is local `useState`.
  - **Main pane:** the selected article's `body`, rendered via
    `DOMPurify.sanitize(...)` + `dangerouslySetInnerHTML` (same pattern as
    `Browser.tsx`).
- **Not time-gated:** the app never touches `MediaStreamContext`, the virtual clock
  (`useClassicyDateTime`), or seek/buffer machinery. Dates shown are real-world dates.

## Data hook: `useReadmeArticles.ts`

Colocated in the app folder, mirroring `useBookmarks.ts`:

- Base URL: `VITE_DIRECTUS_URL` env var, defaulting to `https://api-beta.911realtime.org`.
- **On mount:** fetch the full published list
  (`fields=id,headline,author,date_created,date_updated,body`,
  `filter[status][_eq]=published`, `sort=-date_created`, `limit=-1`) and record the
  change signature.
- **Every 60 s:** one aggregate probe —
  `aggregate[count]=*&aggregate[max]=date_updated&filter[status][_eq]=published`.
  If `(count, max date_updated)` differs from the last-seen signature, refetch the
  full list and update the signature.
- **Sequential fetches only:** probe → refetch is strictly ordered and a new cycle
  never starts while one is in flight (api-beta returns mixed bodies under
  concurrent requests — established constraint).
- **Error handling:** on probe or fetch failure, keep the last-good article list and
  retry on the next tick; expose an error state only when nothing has ever loaded.
  In-flight fetches aborted on unmount via `AbortController`.

Known probe blind spot (accepted): deleting the most-recently-edited article while
simultaneously creating another keeps both `count` and `max(date_updated)` unchanged
only if the new article's `date_updated` is not newer — in practice creates always
bump `max(date_updated)`, so the realistic blind spot is a delete+create in the same
minute where the created article predates the deleted one's timestamp. Self-heals on
the next real edit.

## Testing

Co-located, per repo conventions (`afterEach(cleanup)` required — no RTL auto-cleanup):

- `useReadmeArticles.test.ts` — mocked `fetch` + `vi.useFakeTimers`:
  initial load; probe-unchanged → no refetch; probe-changed → refetch; fetch error
  keeps stale data; no overlapping requests; abort on unmount.
- `README.test.tsx` — renders list rows (headline/author/date); newest selected by
  default; clicking a row swaps the main pane; sanitizer strips `<script>` from body.

## Out of scope

- Streamer involvement of any kind.
- Auto-open / unread-tracking behavior.
- Markdown authoring (WYSIWYG HTML only).
- Mobile (iPod shell) surface for README.
