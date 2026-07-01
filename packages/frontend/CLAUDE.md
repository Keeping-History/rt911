# CLAUDE.md — packages/frontend

Guidance for AI coding assistants working in this Vite + React + TypeScript app. Read the root [`README.md`](../../README.md) for the *what* (product description of each desktop app), this file for the *how*.

---

## What this package is

The Mac OS 8-style desktop shell for 911realtime.org. It is built on the [`classicy`](https://www.npmjs.com/package/classicy) npm package — an external, generically-reusable retro desktop/window-manager component library. Classicy ships its own bundled system apps (Finder, PDF Viewer, Picture Viewer, Movie Player, SimpleText, Control Panels) — **this repo never implements those**; it only supplies configuration and content for them. What this package *does* own:

- `src/app.tsx` — the root: wraps everything in `ClassicyAppManagerProvider` (default file system, seeded boot state) and `MediaStreamProvider`, then renders each Application inside `ClassicyDesktop`.
- `src/Applications/*` — one folder per product app (Browser, News, TV, RadioScanner, PagerDecoder, Newsgroups, Controls, Feedback), each a `ClassicyApp` + `ClassicyWindow(s)`.
- `src/Providers/MediaStream/` — the single WebSocket client to the `packages/backend` streamer.
- `src/data/DefaultFileSystem.ts` — the virtual desktop file tree (Documents → Newspapers/Photos, System Folder) that Classicy's Finder/viewers browse.

---

## Mental model — read before changing anything

- **One virtual clock, one writer.** The canonical time lives in Classicy's own state at `state.System.Manager.DateAndTime` (`{ dateTime, timeZoneOffset }`), seeded in `app.tsx` to `2001-09-11T12:40:00.000Z` / `-4`. **`Controls.tsx` is the only app that mutates it** (step/skip buttons, the H/M/S spinner). Every other app — `TV`, `RadioScanner`, `News`, `PagerDecoder`, `MediaStreamProvider` — reads it reactively via `useClassicyDateTime({ tick: true })` (when it needs play/pause/`localDate`) or `useAppManager((s) => s.System.Manager.DateAndTime.dateTime)` (when it just needs the value). Don't add a second place that calls `setDateTime`/`shiftTime`.
- **One WebSocket, ref-counted subscriptions.** `MediaStreamProvider` opens exactly one connection (`VITE_MEDIA_STREAM_URL`) in `app.tsx`, above `ClassicyDesktop`. Every app shares it through `MediaStreamContext` — either directly (`useContext(MediaStreamContext)`) or via the filtering hook `useMediaStream(filter)`. Opt-in side channels (pager/mp3/news/usenet) are tracked as a `Set<appId>` per channel so multiple apps can subscribe/unsubscribe independently without duplicating `{type:"subscribe"}` wire traffic — see the `subscribePager`/`unsubscribePager`-style pairs in `MediaStreamProvider.tsx`.
- **Incoming data is buffered, not applied immediately.** Frames land in per-channel `Map` buffers and a per-second effect promotes items whose `start_date` has arrived (`revealBuffer.ts`) and prunes expired ones (`retention.ts`) — this is what makes playback advance in lockstep with the virtual clock instead of dumping the whole dataset at once. A clock jump past `SEEK_THRESHOLD_MS` (90s) is treated as a manual seek: buffers clear and a `{type:"seek"}` message goes out.
- **`virtualUtcMs` strips the display timezone back off.** `useClassicyDateTime`'s `localDate` is a *display* value (shifted for the menu-bar clock); the streamer, item `start_date`s, and seek/heartbeat messages are all true UTC. `Providers/MediaStream/virtualClock.ts`'s `virtualUtcMs(localDate, tzOffsetHours)` recovers the real UTC instant. Comparing `localDate` directly against wire timestamps previously trapped short-lived items (radio clips, instant news) permanently in the reveal buffer for any non-zero offset — see `virtualClock.test.ts`.
- **The virtual file system is pure data.** `DefaultFileSystem.ts` is two flat tuple arrays (`[originalFilename, displayName, size]`) mapped into `ClassicyFileSystemTree` fragments. A leaf entry is `{ _type, _mimeType?, _icon, _url?, _size? }`; a folder/drive is just a nested object with `_type: Directory | Drive` plus its own children as sibling keys. Classicy's Finder/PDFViewer/PictureViewer walk this tree generically by `_type`/`_url` — new content is added here, never by writing new browsing/viewer code.

---

## Hard rules

1. **Apps never open a second WebSocket or call the streamer directly.** Always go through `MediaStreamContext` / `useMediaStream`.
2. **Only `Controls.tsx` mutates the clock.** A new app that needs to "jump to a time" should call into the existing `Controls` seek path conceptually, not add its own `setDateTime` call — every other app assumes the clock only moves from that one place.
3. **Use `virtualUtcMs(localDate, tzOffset)`, not `localDate`, whenever comparing against an item's `start_date` or building a wire timestamp.** Direct `localDate` comparisons reintroduce the tz-offset reveal-buffer bug described above.
4. **New subscription channels follow the ref-counted `Set<appId>` pattern** already used for pager/mp3/news/usenet in `MediaStreamProvider.tsx` — don't add a bare boolean "subscribed" flag that one app's unmount can rip out from under another.
5. **`classicy` is external and pinned to `"latest"`; don't hand-edit its version.** `.husky/pre-commit` auto-bumps it on every commit — see the root `CLAUDE.md`. Use `pnpm use:local` / `pnpm use:published` to develop against an unpublished local build.

---

## What good changes look like

- **New Application:** a new folder under `src/Applications/<Name>/`, a `<Name>.tsx` that renders `ClassicyApp` (with `id="<Name>.app"`, `name`, `icon`, `defaultWindow`) wrapping one or more `ClassicyWindow`s, app state read/written via `useAppManager`/`useAppManagerDispatch` with action-type strings namespaced to the app (e.g. `"ClassicyAppTVSetGridState"`), and `quitMenuItemHelper(appId, appName, appIcon)` for the Quit menu item. Register it by rendering it as a child of `ClassicyDesktop` in `app.tsx`, and add seeded per-app data to `defaultState.System.Manager.Applications.apps["<Name>.app"]` only if it needs a non-empty default.
- **Co-located tests.** `Foo.test.tsx` next to `Foo.tsx`; standalone logic gets its own `*.test.ts` (see `virtualClock.test.ts`, `revealBuffer.test.ts`, `retention.test.ts`, `wireCodec.test.ts`, `ackTracking.test.ts`).

## What bad changes look like

- A component that reaches past `MediaStreamContext` to construct its own `WebSocket`.
- Any code comparing `localDate` directly against a `start_date` or sending it as a wire timestamp without passing through `virtualUtcMs`.
- A new app independently tracking or seeking its own copy of "current time" instead of reading the shared clock.
- Adding new file-browsing/viewer UI in this repo for a new asset type Classicy already supports (PDF, image, movie) instead of just adding the right `_type`/`_mimeType`/`_icon`/`_url` entry to `DefaultFileSystem.ts`.

---

## Common tasks

### Add a new desktop app
1. Create `src/Applications/<Name>/<Name>.tsx` following the `ClassicyApp`/`ClassicyWindow` shape above — `Controls.tsx`, `Feedback/Feedback.tsx`, and `PagerDecoder/PagerDecoder.tsx` are good, small references.
2. Wire it into `src/app.tsx` (import + render inside `ClassicyDesktop`).
3. Add a co-located `<Name>.test.tsx`.

### Add new virtual-file-system content (a PDF, an image collection, etc.)
1. Upload the actual asset to Wasabi (`files.911realtime.org`) first — `_url` is a plain remote URL; nothing in this repo serves the bytes.
2. Append to the matching tuple array in `DefaultFileSystem.ts` (following the `NEWSPAPER_FRONT_PAGES` / `ICP_PHOTOS` pattern), or add a new folder plus an `Object.fromEntries` mapping in the same shape for a new content type.
3. Pick the `_type`/`_mimeType`/`_icon` that gets Classicy's bundled viewer to open it correctly (`Pdf` → PDF Viewer, `image/jpeg` → Picture Viewer).

### Subscribe an app to a new or existing side channel (pager/mp3/news/usenet-style)
1. Follow the existing ref-counted `subscribeX`/`unsubscribeX` pair in `MediaStreamProvider.tsx`.
2. Consume via `useContext(MediaStreamContext)` directly, or `useMediaStream(filter)` for TV-style format filtering.
3. This is a two-sided change — coordinate with the matching backend channel (see `packages/backend/CLAUDE.md`'s "Add a new subscription channel" task); update both in the same PR.

---

## Conventions

- **Env config:** `packages/frontend/.env` (copy from `.env.example`); only `VITE_`-prefixed vars are readable in browser code, and they're baked in at build time.
- **E2E:** Playwright specs under `e2e/tests/`; shared fixtures re-export from `e2e/fixtures/index.ts` (currently a thin passthrough — extend it there before duplicating setup across specs).

## When you're not sure

- Read `Providers/MediaStream/virtualClock.ts`'s own comments and `virtualClock.test.ts` — the tz-offset bug it fixes looks like a no-op cleanup and isn't.
- Read [`packages/backend/docs/websocket-protocol.md`](../backend/docs/websocket-protocol.md) before changing anything that touches the wire.
