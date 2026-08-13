# CLAUDE.md — packages/frontend

Guidance for AI coding assistants working in this Vite + React + TypeScript app. Read the root [`README.md`](../../README.md) for the *what* (product description of each desktop app), this file for the *how*.

---

## What this package is

The Mac OS 8-style desktop shell for 911realtime.org. It is built on the [`classicy`](https://www.npmjs.com/package/classicy) npm package — an external, generically-reusable retro desktop/window-manager component library. Classicy ships its own bundled system apps (Finder, PDF Viewer, Picture Viewer, Movie Player, SimpleText, Control Panels) — **this repo never implements those**; it only supplies configuration and content for them. What this package *does* own:

- `src/app.tsx` — the root: wraps everything in `ClassicyAppManagerProvider` (default file system, seeded boot state) and `MediaStreamProvider`, then renders each Application inside `ClassicyDesktop`.
- `src/Applications/*` — one folder per product app (Browser, News, TV, RadioScanner, PagerDecoder, Newsgroups, TimeMachine, Feedback, Account), each a `ClassicyApp` + `ClassicyWindow(s)`.
- `src/Providers/MediaStream/` — the single WebSocket client to the `packages/backend` streamer.
- `src/Providers/Playlist/` — the teacher-playlist engine (spec: `plans/2026-07-16-teacher-playlists-design.md`): loads `?playlist=<id>` from Directus and enforces availability windows / app disabling / focus / scheduled events. Its runtime state is deliberately non-persisted (no ClassicyStore, no localStorage, no ClassicyFileSystem). `RoomControlBridge.tsx` sits alongside it and applies a teacher's **live** commands (jump/focus/message/lock), which the streamer pushes over the WebSocket to everyone following the same `?playlist=` id — see "Room control" in the backend's `docs/websocket-protocol.md`. The teacher end is the Playlists app's Control window (`Applications/PlaylistEditor/ControlPanel.tsx`), which POSTs to the streamer's `/room` via `roomApi.ts`; the streamer authorises those per playlist, so only the playlist's creator can drive it.
- `src/Providers/Auth/` — Directus session auth (AuthProvider) + the playlistApi editor seam; auth state is never persisted client-side (httpOnly cookie only).
- `src/data/DefaultFileSystem.ts` — the virtual desktop file tree (Documents → Newspapers/Photos, System Folder) that Classicy's Finder/viewers browse.
- `src/Mobile/*` — the iPod-style mobile shell (phones/tablets get it instead of the desktop; chosen once at boot in `app.tsx` via `pointer: coarse` or the `?ipod` URL override (testing escape hatch)). Vendored `ipod_ui` chrome — see `src/Mobile/VENDORED.md`.

---

## Mental model — read before changing anything

- **One virtual clock, one writer seam.** The canonical time lives in Classicy's own state at `state.System.Manager.DateAndTime` (`{ dateTime, timeZoneOffset }`), seeded in `app.tsx` to `2001-09-11T12:40:00.000Z` / `-4`. **Every clock write goes through `setDateTimeFromUtc` in `TimeMachine/setVirtualClock.ts` — that's the invariant, not a fixed list of callers.** Three sanctioned writers use it today: `TimeMachine.tsx` (desktop) and the `src/Mobile/screens/` Time Travel screens (mobile) are the **user-driven** seams (the two are never mounted together); the Playlist engine drives **playlist jumps** — both the pre-authored kind (`src/Providers/Playlist/PlaylistProvider.tsx`, scheduled `jump` entries) and the **live teacher kind** (`src/Providers/Playlist/RoomControlBridge.tsx`, a `room_command` with action `jump` relayed by the streamer to everyone in the room); and `MediaStreamProvider` drives the clock **while the streamer's forced clock mode is active** (operator-forced broadcast time — see `docs/websocket-protocol.md`'s "Forced clock mode" section on the backend), snapping to the server's `clock`/`heartbeat_ack.master_time` frames and locking `DateAndTime` so other writers can't fight it. Every other app — `TV`, `RadioScanner`, `News`, `PagerDecoder` — reads the clock reactively via `useClassicyDateTime({ tick: true })` (when it needs play/pause/`localDate`) or `useAppManager((s) => s.System.Manager.DateAndTime.dateTime)` (when it just needs the value). Don't add a new place that calls `setDateTime`/`shiftTime` directly — route through the seam instead.
- **One WebSocket, ref-counted subscriptions.** `MediaStreamProvider` opens exactly one connection (`VITE_MEDIA_STREAM_URL`) in `app.tsx`, above `ClassicyDesktop`. Every app shares it through `MediaStreamContext` — either directly (`useContext(MediaStreamContext)`) or via the filtering hook `useMediaStream(filter)`. Opt-in side channels (pager/mp3/news/usenet) are tracked as a `Set<appId>` per channel so multiple apps can subscribe/unsubscribe independently without duplicating `{type:"subscribe"}` wire traffic — see the `subscribePager`/`unsubscribePager`-style pairs in `MediaStreamProvider.tsx`.
- **Incoming data is buffered, not applied immediately.** Frames land in per-channel `Map` buffers and a per-second effect promotes items whose `start_date` has arrived (`revealBuffer.ts`) and prunes expired ones (`retention.ts`) — this is what makes playback advance in lockstep with the virtual clock instead of dumping the whole dataset at once. A clock jump past `SEEK_THRESHOLD_MS` (90s) is treated as a manual seek: buffers clear and a `{type:"seek"}` message goes out.
- **`virtualUtcMs` strips the display timezone back off.** `useClassicyDateTime`'s `localDate` is a *display* value (shifted for the menu-bar clock); the streamer, item `start_date`s, and seek/heartbeat messages are all true UTC. `Providers/MediaStream/virtualClock.ts`'s `virtualUtcMs(localDate, tzOffsetHours)` recovers the real UTC instant. Comparing `localDate` directly against wire timestamps previously trapped short-lived items (radio clips, instant news) permanently in the reveal buffer for any non-zero offset — see `virtualClock.test.ts`.
- **The virtual file system is pure data.** `DefaultFileSystem.ts` is two flat tuple arrays (`[originalFilename, displayName, size]`) mapped into `ClassicyFileSystemTree` fragments. A leaf entry is `{ _type, _mimeType?, _icon, _url?, _size? }`; a folder/drive is just a nested object with `_type: Directory | Drive` plus its own children as sibling keys. Classicy's Finder/PDFViewer/PictureViewer walk this tree generically by `_type`/`_url` — new content is added here, never by writing new browsing/viewer code.

---

## Hard rules

1. **Apps never open a second WebSocket or call the streamer directly.** Always go through `MediaStreamContext` / `useMediaStream`.
2. **All clock writes go through `setDateTimeFromUtc` in `TimeMachine/setVirtualClock.ts` — no exceptions.** The sanctioned callers are `TimeMachine.tsx` (desktop) and the `src/Mobile/screens/` Time Travel screens (mobile — the two are never mounted together) for user-driven seeks; the Playlist engine for playlist jumps — `src/Providers/Playlist/PlaylistProvider.tsx` for scheduled `jump` entries and `src/Providers/Playlist/RoomControlBridge.tsx` for a live teacher's `room_command` jump (both check `dateTimeLocked` so forced mode wins); and `MediaStreamProvider` for the streamer's forced clock mode (server-pushed `clock`/`heartbeat_ack.master_time` frames — see the backend's `docs/websocket-protocol.md`). A new app that needs to "jump to a time" should call into that same helper, not add its own `setDateTime` call — every other app assumes the clock only moves from those places, and while forced mode is active `DateAndTime.dateTimeLocked` is set so both the user-driven writers (TimeMachine, mobile Time Travel) and the Playlist engine (which checks the same flag and suppresses `jump` crossings) can't fight the master.
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
1. Create `src/Applications/<Name>/<Name>.tsx` following the `ClassicyApp`/`ClassicyWindow` shape above — `TimeMachine/TimeMachine.tsx`, `Feedback/Feedback.tsx`, and `PagerDecoder/PagerDecoder.tsx` are good, small references.
2. If the app has a custom reducer, register it **with a manifest** via `registerApp` (next section) from a context/settings module that loads at import time.
3. Wire it into `src/app.tsx` (import + render inside `ClassicyDesktop`).
4. Add a co-located `<Name>.test.tsx`, and a row to `src/appManifests.test.ts` if you registered a manifest.

### Register an app's reducer + manifest (`registerApp`)

Every app with a custom reducer registers it at module load from its context file via classicy's `registerApp({ id, description, prefix, handler, actions, state })` — **never** the deprecated `registerAppEventHandler`. The manifest's text is a product surface: it powers balloon help, HyperCard script discovery, and dev-mode state validation. `TV/TVContext.ts` is the fullest example; `Feedback/FeedbackContext.ts` the smallest.

Rules (all enforced or pinned by `src/appManifests.test.ts`):

- **`state` MUST be `z.looseObject`, never `z.object`**, with every top-level field `.optional()` and `.describe()`d. The kernel writes undeclared keys (e.g. `openFiles`) into `apps[id].data`, and data is legitimately `{}`/`undefined` before the app's first action. The `.describe()` text is the balloon-help copy — write it for end users. Derive the data type via `z.infer` so type and schema can't drift.
- **Declare every action the reducer's `switch` handles**, each with a `description`; `params` is a `z.object` matching *exactly* the fields that case reads off `action` (name them as the reducer reads them — e.g. TV's `SetCurrentChannel` takes `source`, not `currentChannel`). Actions the reducer reads nothing from (`Pause`, `ExitGrid`) take no `params`. For replace-whole-object settings actions, `z.record(z.string(), z.unknown())` with a "Full X object." describe is the house pattern — the detailed field shapes live on the *state* schema.
- **`scriptable: true` is a product/security decision, not a default** — it exposes the action to untrusted HyperCard stack scripts. Nothing is scriptable today and `appManifests.test.ts` pins `listScriptableActions()` to the exact expected list (`[]`); flipping any action on requires explicit sign-off and updating that assertion in the same PR.
- **Multi-module apps** (one id, several prefixes — see FlightTracker): the primary module registers the `state` schema, *covering the keys secondary modules write* (e.g. `command`/`focusedFlight`); secondaries register prefix + actions only; both repeat an identical `description` literal (first-wins) rather than importing each other. A store plugin that writes into *other* apps' data (see `Providers/Playlist/playlistStoreActions.ts`) registers no `state` at all.
- **Test-mock hazard:** a test whose import graph reaches a registered module and that `vi.mock("classicy", () => ({...}))` with a full factory needs `registerApp: () => {}` in the factory (and `describeAppState`/`ClassicyBalloonHelp` if the graph reaches `TimeMachine.tsx`). Prefer `importOriginal` spreads, which dodge the whole class of breakage. `src/appManifests.test.ts` itself must never mock classicy — it exercises the real registry.
- **Dev builds validate `apps[id].data` against the schema after every action** and `console.warn` on mismatch (prod skips this entirely). A warning means the schema or the reducer is wrong — fix the schema to match the reducer's reality, never mangle state to satisfy the schema. After touching a reducer or schema, run the app's flows once with the console open.
- **Balloon help from the manifest:** `describeAppState(appId, "path.to.field")` returns `{title, content}` or `undefined` (render the bare control on undefined). Supply your own human title — the returned one is the raw field name. The three TimeMachine settings sliders in `TimeMachine/TimeMachine.tsx` are the wired exemplar.
- Sub-schemas for objects the reducer always writes whole (`captionStyle`, `favorites` entries) are deliberately strict; if their interface ever grows a field, make the sub-schema `.partial()` in the same change or older persisted data will dev-warn on every related action.

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
- **Every browser call to Directus from `localhost` needs the proxy, not just sign-in.** `CORS_ORIGIN` gates *anonymous reads too* — `/items/tm_bookmarks` from a localhost origin returns `200` with no `Access-Control-Allow-Origin`, so the browser discards it. Flight tracks, README articles and bookmarks fail exactly like `/auth/login` does.
- **Signing in locally needs one extra step.** The deployed Directus refuses credentialed requests from `localhost` three ways over — `CORS_ORIGIN` lists only the product domains (so no `Access-Control-Allow-Origin` comes back and the browser discards the response), `SESSION_COOKIE_DOMAIN=.911realtime.org` can't be stored for localhost, and `SESSION_COOKIE_SAME_SITE=lax` isn't sent cross-site. Fixing any one alone changes nothing. Put `VITE_DIRECTUS_URL=/directus` in `packages/frontend/.env.development` to route Directus through the dev server's own origin, which sidesteps all three at once — see the `/directus` proxy in `vite.config.ts`. Two caveats: it forwards to **production**, so a local sign-in is a real account writing to the live database (override with the non-`VITE_` `DIRECTUS_PROXY_TARGET`), and OAuth still won't work locally because those redirects are validated server-side against `AUTH_*_REDIRECT_ALLOW_LIST` — use email+password.
- **`.env.development` is deliberately gitignored, per-developer.** Vite reads plain `.env` in *all* modes including `vite build`, where a relative Directus URL would silently target the page's own origin; `.env.development` is dev-mode only. It stays untracked because Playwright's `webServer` runs `vite -d`, so a committed copy would route the required CI E2E run through the dev proxy too — CI should keep exercising the absolute, production-shaped URLs.
- **`vite preview` needs `pnpm preview:auth`, not `pnpm preview`.** Preview serves a *built* bundle, and a default production-mode build bakes the absolute Directus URL that localhost can't call — so plain `pnpm preview` can't reach Directus at all. `preview:auth` builds with `--mode preview` (which loads the committed `.env.preview`, setting the relative base) and the same proxy is wired into `preview` as `server` in `vite.config.ts`. `.env.preview` is safe to commit precisely because only an explicit `--mode preview` reads it — the production image builds in production mode and never does.
- **E2E:** Playwright specs under `e2e/tests/`; shared fixtures re-export from `e2e/fixtures/index.ts` (currently a thin passthrough — extend it there before duplicating setup across specs).

## When you're not sure

- Read `Providers/MediaStream/virtualClock.ts`'s own comments and `virtualClock.test.ts` — the tz-offset bug it fixes looks like a no-op cleanup and isn't.
- Read [`packages/backend/docs/websocket-protocol.md`](../backend/docs/websocket-protocol.md) before changing anything that touches the wire.
