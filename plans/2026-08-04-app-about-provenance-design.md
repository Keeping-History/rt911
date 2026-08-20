# Design: per-app About windows with data provenance

**Date:** 2026-08-04
**Scope:** nine desktop apps — Pager Decoder, Browser, Flight Tracker, MarketWatch,
News, Newsgroups, Radio Scanner, TV, Weather.

Each gets an **About &lt;App&gt;…** item in the **Help** menu opening a window that
credits every upstream source behind the data that app displays, and — where the
app presents a reconstruction as if it were live — discloses how it was built.

---

## Why this is more than a credits box

Two of Flight Tracker's 3D aircraft models are GPL-2.0 derivatives and thirteen
are CC-BY / CC-BY-SA, plus the WTC hero model is CC-BY 4.0. Their attributions
currently exist only in `maps/aircraft/models.json` on Wasabi (fetched by the app
but never displayed) and in `HERO_MODELS_CREDITS.md` inside the repo. Attribution
licenses are satisfied only where a recipient can *see* the credit, so these
windows are the first place those licenses are actually honored in the product.

---

## Constraints discovered in Classicy (these shape the whole design)

1. **The Apple menu steals About items.** `ClassicyDesktopMenuBar`'s
   `findAppAboutItem` depth-first searches the app's published menus for any id
   ending `_about` **or** a title of exactly `"About"`, hoists the match into the
   Apple menu, and `stripAboutItem` removes it from where the app put it —
   dropping the containing menu entirely if that leaves it empty. A Help menu
   whose only item was "About" would therefore vanish.
2. **`ClassicyAboutWindow` cannot hold this content.** It is a fixed five-element
   modal (icon, name, mock copyright, OK) with `initialSize={[0,0]}`,
   `modal={true}`, `scrollable={false}` and no children slot. Its window contract
   is built for a four-line credit box, not a reference document.
3. **`Desktop.helpMenu` is a reserved-but-dead slot.** `ClassicyDesktopMenuBar`
   already reads `System.Manager.Desktop.helpMenu` and appends it to the standard
   Help menu after *About Balloon Help* / *Hide Balloons*, but **no reducer case
   writes it**. Critically, `findAppAboutItem` only walks `Desktop.appMenu`, so
   entries in `helpMenu` are immune to the About-hoist.

Completing (3) is cheaper than working around (1) and yields the HIG-shaped
result: our item lands under Help *because the framework has a Help slot*, not
because we dodged the framework.

---

## Part 1 — Classicy: finish the Help-menu slot

One PR to `~/classicy`; push to main auto-publishes and the rt911 pre-commit hook
bumps the dependency.

### 1a. Store

`ClassicyStoreSystemDesktopManager.helpMenu?: ClassicyMenuItem[]` becomes
`helpMenu?: Record<string, ClassicyMenuItem[]>` — appId → that app's Help items.
Changing the shape is safe precisely because nothing writes it today.

### 1b. Reducer

Two cases in `classicyDesktopEventHandler`, mirroring the existing
`ClassicyDesktopAppMenuAdd` / `ClassicyDesktopAppMenuRemove` pair:

- `ClassicyDesktopHelpMenuAdd` — `{ app: { id }, menu: { items } }`
- `ClassicyDesktopHelpMenuRemove` — `{ app: { id } }`

### 1c. Menu bar

Lift the focused-app resolution out of the `appleMenuItem` `useMemo` into its own
memo (it already computes `focusedAppId` and `appName`), then have `helpMenuItem`
append `helpMenu?.[focusedAppId]`. The Help menu now follows focus like every
other app menu instead of being one global list nine apps fight over.

### 1d. Hook

`useClassicyHelpMenu(appId, items)` in `ClassicyAppMenuHooks.tsx`, beside
`useClassicyAboutMenu`: dispatches Add on mount, Remove on unmount. Its doc
comment must state that callers memoize `items` — unmemoized menu arrays would
re-fire the effect every render. Every rt911 app already `useMemo`s its `appMenu`
(e.g. `News.tsx:34`), so this matches existing practice.

Menu items keep the ordinary `onClickFunc` path rather than `event`/`eventData`;
`Desktop.appMenu` already stores closures successfully across every app.

### 1e. Classicy tests

- Reducer: Add stores under the app id; Remove deletes only that app's entry.
- Menu bar: renders the focused app's Help items; does **not** render a
  non-focused app's.
- **Regression guard:** an `About …` item registered via `helpMenu` is *not*
  hoisted into the Apple menu and *not* stripped. This behavior is the load-bearing
  assumption of the whole design and must fail loudly if `findAppAboutItem` is
  ever widened.

---

## Part 2 — rt911: one registry, one component, two-line app diffs

### 2a. `src/data/provenance.ts` — pure data, no React imports

```ts
export type ProvenanceSource = {
  name: string;    // "NOAA NCEI global-hourly"
  url: string;     // absolute https
  feeds: string;   // "METAR/SPECI observations for 188 stations"
  note?: string;   // license, caveat, or retrieval date
};

export type AppProvenance = {
  appName: string;
  blurb: string;              // one or two sentences: what this app shows you
  sources: ProvenanceSource[];
  method?: string[];          // "How this was built" — derivation disclosure
  credits?: ModelCredit[];    // Flight Tracker only (see 2b)
};

export const APP_PROVENANCE: Record<string, AppProvenance>;
```

### 2b. `src/data/aircraftCredits.ts` — committed copy of the hosted manifest

A vendored transcription of `https://files.911realtime.org/maps/aircraft/models.json`
(15 entries: family, model, author, license, source URL) plus the WTC hero entry
from `HERO_MODELS_CREDITS.md`. Static — no network dependency, so the window works
fully offline.

```ts
export type ModelCredit = {
  model: string;    // "Boeing 767-300ER"
  author: string;   // "RTicknor (Thingiverse)"
  license: string;  // "CC-BY-SA 3.0"
  url: string;
};
```

**Accepted tradeoff:** this copy can drift from the hosted manifest when a model
is added or replaced. Mitigation is a file-header comment recording the source URL,
the date copied, and the one-line refresh command — not automation.

GPL-derived entries (`b757`, `b727`) carry author + license like the rest; no
source-availability offer in the UI.

### 2c. `src/Components/AboutApp/` — new shared-component directory

There is no shared-components directory yet (`src/lib` is logic-only). Exports one
hook:

```ts
const aboutWindow = useAboutApp(appId);   // registers the Help item internally
```

The hook owns the `showAbout` state, builds the `About <App>…` menu item, and calls
`useClassicyHelpMenu` itself, so no app can wire half the feature. Each app's diff
is **two lines**: the hook call, and `{aboutWindow}` inside `ClassicyApp`.

The menu item is `{ id: `${appId}_about_data`, title: `About ${appName}…` }`.
Both halves are deliberate defense-in-depth against the hoist heuristic: the id
does **not** end in `_about`, and the title is not exactly `"About"` — so even if
`findAppAboutItem` were later widened to search `helpMenu`, neither of its looser
fallbacks would match this item.

The window is a `ClassicyWindow` (`${appId}_about_data`) — closable, resizable,
**scrollable**, **non-modal**, ~440×420, styled with existing `var(--color-system-*)`
tokens. No new design language.

Layout: app icon + name, blurb, `SOURCES` list (name as link, then `feeds`, then
`note`), `HOW THIS WAS BUILT` if `method` is present, `3D MODELS` if `credits` is.

Source names are real links with `target="_blank" rel="noreferrer noopener"`. They
must **not** route through the in-app Browser, which is a 2001 Wayback proxy and
would fail on a modern URL.

---

## Part 3 — provenance content

App ids: `PagerDecoder.app`, `Browser.app`, `FlightTracker.app`, `MarketWatch.app`,
`News.app`, `Newsgroups.app`, `RadioScanner.app`, `TV.app`, `Weather.app`.

### Pager Decoder
- **WikiLeaks — 9/11 Pager Intercepts** (2009 release). 448,358 messages across
  Metrocall, Skytel and Arch networks, with `channel` and `mode` as released.

### Browser
- **Internet Archive Wayback Machine** — pages captured on 2001-09-11 or the
  nearest available capture, served through the Time Machine proxy.
- *Method:* pages are rewritten to route subresources and links back through the
  proxy; a capture may predate or postdate the virtual clock by hours or days.

### Radio Scanner
- **Rutgers Law Review, _A New Type of War_** — the `Rutgers` channel (48 clips).
- **Audacy** — 1010 WINS (`WINS`, 24 clips).
- **WCBS Audio Archives** — `WCBS` (1 clip).
- **Internet Archive** (NIST release or direct upload) — the remaining 512 clips:
  the ATC/NORAD channels (`atc`, `NEADS/NORAD`, `Langley`, `FAA`, `ATCSCC`, `ZNY`,
  `ZBW`, `ZOB`, `ZDC`) and the per-flight channels (`AA11`, `UA175`, `AA77`,
  `UA93`, `DL1989`, `GOFER06`).
- *Method:* captions are machine transcriptions (whisper.cpp), not official
  transcripts; audio is loudness-normalized in place from archived originals.

### TV
- **Internet Archive — "Understanding 9/11: A Television News Archive"**
  (collection `sept_11_tv_archive`) and the **`911`** collection, via the IA HTTP
  API.
- *Method:* broadcasts re-encoded to HLS and stitched into continuous 9-day
  channels with gap filler; captions are whisper.cpp machine transcriptions.

### Newsgroups
- **Internet Archive Usenet archives** — per-group mbox archives
  (`archive.org/download/usenet-<group>/`), converted by `mbox_parser`.

### News
- **History Commons** — the 9/11 investigative timeline. Article images mirrored
  from `cdn.historycommons.org`.
- *Method:* an investigative timeline written with hindsight — accurate about what
  happened, but containing detail that was not public in 2001. Entry times are
  when the event occurred, not when it was reported.

### MarketWatch
- **Yahoo chart API** — listed lineages reaching back to 2001.
- **FRED `DGS10`** — 10-year Treasury yield.
- **Archival newspaper stock tables / contemporaneous reporting** — delisted paper
  (AMR, UAL, DAL, CAL, NWAC, U, MER, LEH, BSC, EK, GM, RTN, HLT, old AT&T `T`);
  every override in `market_data/overrides.json` carries its own citation,
  chiefly Wayback captures of `ichart.finance.yahoo.com` /
  `table.finance.yahoo.com` and CNNfn.
- *Method:* Yahoo closes are split-adjusted and are multiplied back by post-2001
  split ratios to recover as-printed prices; intraday paths are deterministically
  synthesized from daily OHLC, not real tick data.

### Weather
- **NOAA NCEI global-hourly** data service + `isd-history.csv` — METAR/SPECI
  observations.
- **Iowa Environmental Mesonet** — archived NEXRAD CONUS composites (5-minute PNGs).
- **AFOS text products** — forecasts.

### Flight Tracker
Sources:
- **BTS TranStats On-Time Performance** (2001-09 PREZIP) — scheduled flights.
- **84 RADES FOIA radar files** (`All-4-Events.xls`) — per-sweep positions for
  AA11, UA175, AA77, UA93 and the C-130 (GOFER06).
- **NTSB Flight Path Studies** + the **9/11 Commission Report** — anchors across
  radar coverage gaps.
- **FAA aircraft registry** via Wayback (2001-09-29 snapshot) — tail numbers.
- **OpenFlights** (+ IANA tz) and **OurAirports** — airport reference and elevations.
- **NYC Open Data Building Footprints** (Socrata `5zhs-2jue`) and **Arlington
  County GIS** — 2001-era buildings; the WTC complex is curated (absent from both).
- **Protomaps / OpenStreetMap**, **OSM coastline** (`osmdata.openstreetmap.de`),
  **NASA Visible Earth** (Blue Marble day / City Lights night), **Mapterhorn**
  (terrain) — basemaps.

*Method:* positions are **reconstructed, not recorded** — interpolated from
scheduled departures with radar anchors where radar exists; transponder-off
stretches interpolate through documented NTSB anchors, and coverage gaps are
marked. Descents are anchored to real airport elevations.

3D models: the 15 aircraft credits from `models.json`, plus **"World Trade Center"
by NanoRay, CC-BY 4.0** — the original 1974–2001 complex, decimated to ~90k
triangles and rescaled; a derivative work with attribution retained per CC-BY.

### URL verification is an implementation step

Exact URLs are known from the repo for BTS, NCEI, IEM, NYC Open Data, Arlington
GIS, Sketchfab/NanoRay, Thingiverse, FlightGear FGAddon, FRED and the IA
collections. The remaining four — WikiLeaks pager intercepts, Audacy, the WCBS
Audio Archives, and the Rutgers Law Review monograph — must be **resolved and
link-checked (HTTP 200/3xx) before commit**. No URL is written from memory.

---

## Tests

`provenance.test.ts`
- All nine app ids present in `APP_PROVENANCE`.
- Every entry has a non-empty `blurb` and ≥1 source.
- Every `url` parses via `new URL()` and has protocol `https:`.
- No empty strings and no `TBD` / `TODO` / `FIXME` anywhere in the registry.
  *This is the guard that matters: a half-filled entry becomes a red test rather
  than a blank section shipped to users.*

`aircraftCredits.test.ts`
- 15 families plus the WTC hero; every credit has model, author, license, https url.

`AboutApp.test.tsx`
- Renders sources, method and credits from a fixture entry.
- Links carry `target="_blank"` and `rel="noreferrer noopener"`.
- Close dismisses the window.
- Uses `afterEach(cleanup)` — this vitest setup has no RTL auto-cleanup.

Per-app: assert each of the nine renders `{aboutWindow}` and registers a Help item
(one shared helper, not nine bespoke tests).

---

## Out of scope

- **The mobile shell** (`src/Mobile`) — it has no menu bar; Help is a desktop concept.
- **The other eight apps** — Alerts, HyperCard, README, Time Machine, Account,
  Feedback, Playlist Editor, IM Buddies.
- **GPL source-availability offer** — attribution only, per decision.
- The Apple menu's own standard `About <App>` behavior stays untouched.

## Sequencing

1. Classicy PR (Part 1) → merge → auto-publish.
2. rt911 work (Parts 2–3) developed in parallel against `pnpm use:local`, switched
   to `use:published` once the new version is out.
3. Land on `main`; CI → GHCR → ArgoCD deploys.
