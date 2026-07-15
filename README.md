# 911realtime.org

> **An update to 911realtime.org is coming for the 25th anniversary of the September 11, 2001 attacks (September 11, 2026). Stay tuned for more details.**

A project to collect multimedia from the September 11 attacks and synchronize it into a common media player, so the day can be experienced as it unfolded — in real time, across television, radio, pagers, and the web.

> 🚧 **Try the beta:** A preview of the version 2 rewrite is live at **<https://beta.911realtime.org>**. Come explore it, and if you run into bugs or have ideas, please [file an issue](https://github.com/Keeping-History/rt911/issues/new) — your feedback helps shape the anniversary release.

- **Visit the site:** <https://911realtime.org>
- **Try the beta:** <https://beta.911realtime.org>
- **Report an issue:** <https://github.com/Keeping-History/rt911/issues/new>
- **Why did we build this?** <https://youtu.be/q1ukl6G_s_M>

## About

This repository is the **version 2** rewrite of 911realtime.org: a Mac OS 8-style desktop, built on the [Classicy](https://www.npmjs.com/package/classicy) component library, that presents synchronized period media inside a nostalgic, era-appropriate interface. It is a pnpm monorepo:

| Package | Description |
|---|---|
| `packages/frontend` | The Vite + React + TypeScript desktop app and its applications |
| `packages/backend` | Media/EPG data seeding and generation scripts |
| `packages/tools` | Supporting tooling (e.g. media ingestion) |

## Setup

### Prerequisites

The toolchain versions are pinned in `mise.toml`:

- Node 25, pnpm 10 (also Go 1.25 and Python 3.12 for the tools package)

If you use [mise](https://mise.jdx.dev), `mise install` will provision everything. Otherwise install Node and pnpm manually.

### Running the app

From the **repository root**:

```sh
pnpm install
pnpm dev          # starts the frontend dev server
```

Then open <http://localhost:5173> in your browser.

Other root scripts:

| Script | Purpose |
|---|---|
| `pnpm build` | Type-check and build the frontend for production |
| `pnpm test` | Run the frontend test suite (Vitest) |
| `pnpm lint` | Lint the frontend (ESLint) |
| `pnpm setup` | Seed the backend data store |
| `pnpm db:gen-epg` | Generate the Electronic Program Guide data |

### Local vs. published Classicy

The frontend depends on the published `classicy` package by default. If you are also developing Classicy itself, you can link a local build. From `packages/frontend`:

```sh
pnpm use:local       # link a locally built classicy
pnpm use:published   # remove the link and install from npm
```

## Applications

The desktop includes the following apps. Click any desktop icon or use the Apple menu to open them.

### Finder
The classic Mac OS file browser for the desktop's virtual file system. Double-click **Macintosh HD** to browse into **Documents**, which holds 49 archived newspaper front pages from September 11, 2001 and a photo archive from the International Center of Photography.

### PDF Viewer
Opens PDF documents in place — used to read the archived newspaper front pages under Documents → Newspapers.

### Picture Viewer
Opens image files in place — used to view the International Center of Photography archive under Documents → Photos.

### Movie Player
A QuickTime-style movie player for video files opened from the Finder.

### Browser
A retro web browser powered by the [TimeMachine Web Proxy](https://hub.docker.com/r/robbiebyrd/time-machine-proxy). Fetches archived snapshots of websites from the Wayback Machine and renders them in a Mac OS 8-style browser window with back/forward navigation, visited-link memory, and a favorites bar.

**Requires the TimeMachine proxy** — see [TimeMachine Proxy Setup](#timemachine-proxy-setup) below.

### News
A news reader that displays historical news entries. Supports thumbnail and full-article views with pagination.

### EPG
An Electronic Program Guide rendered as a scrollable channel/time grid, displaying show titles, descriptions, and icons in a classic TV guide layout.

### TV
A multi-channel streaming TV player. Displays a scrollable strip of video thumbnails at the bottom; clicking a channel expands it to fill the main area. All streams stay mounted to preserve playback state.

### Radio Scanner
A live audio scanner that tunes through period radio stations on a synchronized timeline, with a waveform visualizer. Audio rides its own opt-in stream and keeps playing across browser tab switches.

### Pager Decoder
A live POCSAG/FLEX pager message decoder. Connects to a pager index feed, streams decoded messages in real time, and supports filtering by address, source, and message content.

### Newsgroups
A Usenet newsgroup reader with a collapsible group tree, search, sorting, and on-demand message bodies — browse archived discussions as they appeared on the period internet.

### Controls
A remote-control panel for navigating the synchronized media timeline (stepping forward and back through the day) and adjusting playback settings.

### BlueBox (Infinite Mac)
Embeds [Infinite Mac](https://infinitemac.org) — a browser-based emulator running Mac OS 8.1 on a Quadra 650 — inside a Classicy window.

---

## TimeMachine Proxy Setup

The **Browser** app requires the TimeMachine Web Proxy to be running locally. It is managed via Docker Compose through the frontend package scripts.

**Prerequisites:** Docker with Compose support.

```sh
cp packages/frontend/.env.example packages/frontend/.env   # review and adjust settings if needed
pnpm --filter @rt911/frontend proxy:up                      # build and start the proxy
```

The proxy starts on `http://localhost:8765`. Once it is running, open the Browser app and enable the proxy under **File → Settings → Enable TimeMachine Proxy**.

To stop or restart it:

```sh
pnpm --filter @rt911/frontend proxy:down     # stop
pnpm --filter @rt911/frontend proxy:cycle    # restart
```

### Configuration

Configured via `packages/frontend/.env` (copied from `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `TIMEMACHINE_PORT` | `8765` | Host/container port the proxy listens on |
| `LISTENER` | `0.0.0.0` | Bind address inside the container (must stay `0.0.0.0`) |
| `ARCHIVE_TIME` | `20010911000000` | Wayback Machine timestamp to retrieve (YYYYMMDDHHmmss) |
| `URL_PREFIX` | `https://web.archive.org/web` | Archive source base URL |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed origin — must match your dev server address |
| `CACHE_ENABLED` | `true` | Cache fetched pages |
| `CACHE_DIR` | `/app/cache` | Cache directory inside the container |
| `HOST_CACHE_DIR` | *(unset)* | Host path to persist the cache; leave unset for a Docker volume |
| `CACHE_CLEAR_TOKEN` | `dev-token` | Token for the cache-clear endpoint — change for shared deployments |

Variables prefixed with `VITE_` (e.g. `VITE_PROXY_HOST`, `VITE_MEDIA_STREAM_URL`) configure the browser client and are read at build time. See `.env.example` for the full list.

---

## Current Media Status

Currently, we have the following data stored on our CDN for use in the app.

| Folder | Objects | Size |
|---|---|---|
| Videos | 6,632,596 | 4.03 TiB |
| Audio | 738 | 8.84 GiB |
| Thumbnails | 392,640 | 1.38 GiB |
| Playlists | 96 | 917 MB |
| Images | 2,142 | 52.3 MB |
| Subtitles | 1,030 | 30.7 MB |
| TV Guide | 24 | 2.25 MB |

---

## Sponsorship

<a href="https://www.hivelocity.net">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hivelocity-logo-dark.svg">
    <img src=".github/assets/hivelocity-logo-light.svg" alt="Hivelocity" height="44">
  </picture>
</a>

Hosting for this project is generously provided by **[Hivelocity](https://www.hivelocity.net)**, a provider of bare-metal dedicated servers, cloud, and colocation across 40+ global data centers.

---

## 3D Aircraft Models

The Flight Tracker's 3D mode renders each flight with a model matching its
airframe. All models are used under free licenses, with thanks to their
authors (processing pipeline and full provenance: [`scripts/aircraft-models/`](scripts/aircraft-models/)):

| Aircraft | Author | License | Source |
|---|---|---|---|
| Airbus A320 (generic fallback) | PHILdesign | CC-BY 4.0 | [Thingiverse](https://www.thingiverse.com/thing:2203732) |
| Boeing 737-800 | Jonah Ashton | CC-BY 4.0 | [Thingiverse](https://www.thingiverse.com/thing:2426394) |
| Boeing 757-200 | Liam Gathercole, Skyop, Isais Prestes; reworked by Juuso Tapaninen | GPL-2.0+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/757-200/) |
| Boeing 767-300ER | RTicknor | CC-BY-SA 3.0 | [Thingiverse](https://www.thingiverse.com/thing:947061) |
| Boeing 777-300ER | Jevan Yu | CC-BY 4.0 | [Thingiverse](https://www.thingiverse.com/thing:1703733) |
| Boeing 727 | Bogdan Deac (yuppy) | GPL-2.0 | [Thingiverse](https://www.thingiverse.com/thing:3452615) |
| Boeing 717 (DC-9/MD-80 family) | A. C. (Adcoff72) | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:3319522) |
| McDonnell Douglas DC-10 | Reean24, after "DC10" by manilov.ap | CC-BY 4.0 | [Thingiverse](https://www.thingiverse.com/thing:5278513) |
| Airbus A319 / A321 | P6619 | CC-BY-SA 3.0 | [Thingiverse](https://www.thingiverse.com/thing:173006) |
| Bombardier CRJ-200 | Fredepo | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:1308356) |
| Embraer ERJ-145XR | RTicknor | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:1727564) |
| Fairchild-Dornier 328JET (ATR-42 stand-in) | A. C. (Adcoff72) | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:3319511) |
| Gulfstream G550 (business jets) | Giddi | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:3315582) |
| Douglas DC-3 | pumpkinhead3d | CC-BY 3.0 | [Thingiverse](https://www.thingiverse.com/thing:2733162) |

Models were decimated and re-oriented for use as map markers; the Boeing
727 and 757 are format conversions (OBJ/AC3D → STL) and remain under the
GPL. Per-model license metadata is also served alongside the assets at
`maps/aircraft/models.json`.

---

## Special Thanks

- Chris Wooster
- Sergey Kochergan
- Kori Stephens
- Alison L. Roberts
- Ryan M.
- Richard Harms
- Marina Harper
- Matt MG Herron
- Will Harris
- Tristan Warsaw
- Michael Locher
- Ruthalas
- James Wendel
- Adil Majid
- Jason Smith
- Adros
- Nikita Rogozov
- Will Riches
- Alana Malone
- Cameron Murphy
- Florence Arsenault
- Brian Witt
- Robinson Collado
- Léon Spaans
- Ben Romberg
- Adam Garst
- Greg
- Tolu
- David
- Gus Gordon
- Andrew Poirier
- Ty Satrang
- Carla Fuentes
- Laura M. Macklin Baglien
