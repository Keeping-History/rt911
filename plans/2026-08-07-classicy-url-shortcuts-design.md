# Web URL shortcuts in Classicy, and two of them in rt911

**Date:** 2026-08-07
**Status:** Approved, not implemented
**Repos:** `classicy` (~/classicy, published to npm) and `rt911` (this repo)

## Problem

Classicy has no way to express "this icon points at a web address." A desktop
icon can only launch a registered app, and the file system can only describe
content that one of the bundled viewers renders. There is no primitive for a
link.

rt911 needs one. Two published CMS pages — `/press` ("Press Room") and
`/teachers` ("For Teachers") — have no presence on the desktop at all today.
They are reachable only by typing the URL.

## What already exists

Classicy declares the concept and never implements it. All of the following is
present today and currently dead:

- `ClassicyFileSystemEntryFileType.Shortcut = "shortcut"` in the file system model.
- `_url` on entry metadata, documented as *"also used for shortcut targets."*
- `shortcut: 3` in `kindPriority`, so shortcut icons already sort after apps.
- `isAliasKind` already returns true for `"shortcut"`, so such an icon already
  renders with the Mac OS 8 alias badge and italic label.

Nothing anywhere opens one. This design fills that hole rather than inventing a
parallel concept.

Two adjacent pieces are also reused rather than rebuilt:

- `isValidHttpUrl` (`SystemResources/Utils/urlValidation.ts`) already accepts
  http/https and relative paths and rejects `javascript:`, `data:`, and `file:`.
- `driveSetupRequest` + `driveSetupRequestId` in the desktop store is an
  established request/controller rail for performing a side effect that a pure
  reducer cannot.

## Decisions

| Question | Decision |
|---|---|
| What "open in a Classicy app" renders | A new bundled `WebViewer` app: a `ClassicyWindow` containing an `<iframe>` |
| How disposition is chosen | Stored on the entry only. No contextual-menu overrides, no modifier keys |
| URL safety | `isValidHttpUrl`, plus `sandbox` on cross-origin iframes only, plus `noopener,noreferrer` on every `window.open` |
| Where rt911's two shortcuts live | Both the drive root file system *and* the desktop |
| What disposition rt911's two shortcuts use | `browser-new` (a real new browser tab) |

### Why sandbox only cross-origin

A same-origin iframe with `allow-scripts allow-same-origin` can reach its own
frame element and remove the `sandbox` attribute. Sandboxing same-origin content
is theater. It buys something only against a cross-origin target, where
`allow-scripts` can be granted *without* `allow-same-origin`.

### Why disposition is stored, not chosen

Smallest surface that satisfies the requirement. A contextual menu offering all
three dispositions was considered and rejected as unneeded — the author of a
shortcut knows how it should open.

## Design

### 1. The shortcut primitive

New module `src/SystemFolder/SystemResources/Shortcut/ClassicyShortcut.ts`:

```ts
export type ClassicyShortcutDisposition = "classicy" | "browser" | "browser-new";

/** Validates an unknown value from persisted state; defaults to "classicy". */
export const readShortcutDisposition = (v: unknown): ClassicyShortcutDisposition;

/** True for relative paths and for absolute URLs on the current origin. */
export const isSameOriginUrl = (url: string): boolean;
```

`"classicy"` is the default because it cannot navigate the user away from the
desktop. An entry that omits `_openIn` gets the safe behavior.

### 2. File system model

`ClassicyFileSystemModel.ts` gains exactly one optional field. `_url` already
carries the target.

```ts
/** For _type: "shortcut" — how the target URL opens. Defaults to "classicy". */
_openIn?: ClassicyShortcutDisposition;
```

### 3. The open action, and why it splits

`classicyDesktopEventHandler` gains `ClassicyDesktopOpenUrl`. It first validates
with `isValidHttpUrl`; a rejected URL sets `errorDialog` and stops. It then
splits by disposition:

| Disposition | Path | Rationale |
|---|---|---|
| `classicy` | Handled in the reducer: `classicyAppEventHandler(ds, { type: "ClassicyAppWebViewerOpenUrl", url, title })`, which loads/opens `WebViewer.app` and appends the URL to its `openUrls` | Pure store mutation. No side effect, so no rail needed |
| `browser`, `browser-new` | Sets `openUrlRequest` and bumps `openUrlRequestId` | `window.open` and `location.assign` are side effects and must not run inside a reducer |

Keeping the pure case pure is deliberate. Routing everything through the
controller would put a store-only operation behind an effect for no reason. The
in-reducer dispatch follows the pattern Finder already uses to hand a file to
its owning app.

`ClassicyStoreSystemDesktopManager` gains:

```ts
openUrlRequest?: { url: string; disposition: "browser" | "browser-new" } | null;
openUrlRequestId?: number;
```

The request carries no title: only the `classicy` path has anywhere to show one,
and that path never touches the request.

Plus a `ClassicyDesktopClearOpenUrlRequest` action, mirroring
`ClassicyDesktopDriveSetupClearRequest`.

### 4. The side-effect controller

New `ClassicyOpenUrlController`, mounted by `ClassicyDesktop` beside
`DriveSetupController` and modelled on it: an effect keyed on the monotonic
`openUrlRequestId`, reading the request fresh via `getState`, dispatching the
clear before acting.

```
browser-new → window.open(url, "_blank", "noopener,noreferrer")
browser     → window.location.assign(url)
```

`noopener` matters: without it the opened tab gets a live `window.opener`
handle back into the desktop.

### 5. The WebViewer app

New bundled system app at `src/SystemFolder/WebViewer/`, following the PDFViewer
shape exactly:

- `WebViewerUtils.tsx` — `WebViewerAppInfo` (`{ name: "Web Viewer", id: "WebViewer.app", icon }`), the `WebViewerData` type (`{ openUrls: OpenUrl[] }`) and its type guard.
- `WebViewerContext.tsx` — the event handler for `ClassicyAppWebViewerOpenUrl` / `ClassicyAppWebViewerCloseUrl`, self-registered via `registerAppEventHandler("ClassicyAppWebViewer", …)` so the kernel router needs no hard-wired import.
- `WebViewer.tsx` — one `ClassicyWindow` per open URL, titled from the shortcut's label, each containing the iframe.

Mounted in `ClassicyDesktop` behind a new `disableWebViewer` flag added to
`ClassicyDefaultAppsContext`, consistent with the five bundled apps that already
have one.

The iframe applies the safety boundary:

```tsx
isSameOriginUrl(url)
  ? <iframe src={url} title={title} />
  : <iframe src={url} title={title}
      sandbox="allow-scripts allow-popups"
      referrerPolicy="no-referrer" />
```

`openUrls` entries are `{ url, title }` — the URL is the identity used for
dedupe and close, as PDFViewer uses `path`.

### 6. Finder routing

`classicyFinderEventHandler`'s `ClassicyAppFinderOpenFile` gains a
`_type === Shortcut` branch beside the existing `AppShortcut` branch. It
dispatches `ClassicyDesktopOpenUrl` with the entry's `_url` and `_openIn`, and
uses `_label` or the entry name as the title. An entry with no `_url` gets the
standard "could not be opened" error dialog.

### 7. Desktop icon: two existing defects this exposes

Both are bugs in current code that a shortcut icon would trip over, not new
surface.

**`noLaunch` is hardcoded.** `ClassicyDesktop.tsx:516` passes
`noLaunch={i.appId === "Trash"}`. Without `noLaunch`, a shortcut icon's
double-click fires its `event` *and then* `ClassicyDesktopIconOpen`, which calls
`openApp()` on an appId that is not a registered app — conjuring a phantom app
entry in the store. `noLaunch` becomes a stored, refreshed field on
`ClassicyStoreSystemDesktopManagerIcon`, and the desktop passes
`i.noLaunch ?? i.appId === "Trash"`.

**`eventData` is never refreshed.** `ClassicyDesktopIconAdd`'s re-add branch
refreshes `contextMenu`, `hidden`, `inApplications`, and `balloonHelp`, but not
`event` or `eventData`. Desktop icons persist to localStorage, so a shortcut
whose target URL changed between releases would keep the stale URL forever for
returning visitors. Both fields join the refresh set. This is also a step toward
the standing TODO at `ClassicyDesktopIconContext.tsx:185`.

### 8. rt911

Both shortcuts store `_openIn: "browser-new"` and use
`ClassicyIcons.applications.internetExplorer.documentShortcut`, the
period-authentic Internet Shortcut document icon already in the icon set.

**`src/data/DefaultFileSystem.ts`** — two entries at the `Macintosh HD` root,
beside `Getting Started.stack`:

```ts
"Press Room": {
  _type: ClassicyFileSystemEntryFileType.Shortcut,
  _icon: ClassicyIcons.applications.internetExplorer.documentShortcut,
  _url: "/press",
  _openIn: "browser-new",
},
"For Teachers": { …same shape, _url: "/teachers" },
```

**`src/Desktop.tsx`** — a `useEffect` dispatching two `ClassicyDesktopIconAdd`
actions with `kind: "shortcut"`, `noLaunch: true`,
`event: "ClassicyDesktopOpenUrl"`, and
`eventData: { url, disposition: "browser-new", title }`.

Both surfaces are populated because rt911 runs
`defaultFileSystemMode="exclusive"` and syncs each signed-in user's tree to
Directus — a new entry in the default tree may never reach a user who already
has a synced filesystem, whereas desktop-icon registration re-runs on every
mount. Registering both also exercises both code paths end to end.

## Testing

**Classicy**

- `ClassicyShortcut.test.ts` — disposition validation and defaulting; `isSameOriginUrl` across relative, same-origin absolute, and cross-origin.
- Desktop reducer — `javascript:` and malformed URLs produce `errorDialog` and no request; `classicy` opens the app without setting a request; `browser`/`browser-new` set the request and bump the id.
- `ClassicyOpenUrlController.test.tsx` — stubbed `window.open`/`location.assign`; asserts one call per id bump, the `noopener,noreferrer` features string, and that a repeated identical request still fires (the id is what advances).
- `WebViewer.test.tsx` — same-origin renders no `sandbox` attribute; cross-origin renders `sandbox` and `referrerPolicy`. This is the assertion that would catch a well-meaning "add sandbox everywhere" regression.
- Finder handler — a Shortcut entry dispatches `ClassicyDesktopOpenUrl`; one with no `_url` errors.
- Desktop icon — a re-added icon with a changed `eventData` picks up the new value.
- A Storybook story for a shortcut desktop icon, alongside the existing `ClassicyDesktopIcon.stories.tsx` entries.

**rt911**

- The two file system entries exist at the drive root with the right `_type`, `_url`, and `_openIn`.
- `Desktop.tsx` registers both icons with the expected `event`/`eventData`.

## Shipping order

`classicy` is an external npm dependency pinned to `"latest"`, auto-bumped by
`.husky/pre-commit`. The Classicy work therefore lands and publishes first; rt911
picks it up on its next commit. Two commits in two repos, not one PR.

## Known limitation, accepted

rt911 uses `browser-new` for both shortcuts, so the `classicy` disposition and
the entire `WebViewer` app ship covered only by Classicy's own tests and
Storybook — no rt911 surface opens one on day one. This was raised and accepted:
Classicy is a general-purpose library and the viewer is the safer default for
other consumers.

## Rejected alternatives

- **Delegating to a consumer-registered app instead of shipping a viewer.** rt911's `Browser.app` fetches through the TimeMachine proxy and sanitizes to period HTML — wrong for a modern page — so rt911 would have had to build a second viewer anyway.
- **Contextual-menu or modifier-key disposition overrides.** Unneeded surface; the shortcut's author decides.
- **Same-origin-only shortcuts.** Safest, but makes the primitive useless for linking off-site, which is most of what a web shortcut is for.
