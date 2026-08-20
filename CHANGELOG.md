# Changelog

All notable changes to **911realtime.org (v2)** — the Mac OS 8-style desktop that replays synchronized September 11, 2001 media as if it were happening live.

This project ships continuously via GitOps (branch/SHA image tags → ArgoCD), so releases are grouped by date and feature area rather than by version number.

## Summary — June 27 → July 21, 2026

The largest expansion of the desktop since the v2 rewrite. In roughly three weeks the platform grew from a handful of media apps into a full period-accurate operating environment, with **six new desktop apps**, a **mobile experience**, **user accounts**, a **teacher/classroom layer**, and the data pipelines and streamer channels behind all of it.

Highlights:

- **Flight Tracker** — a full MapLibre GL flight-replay app: real Sept 2001 BTS trajectories (3.47M positions), the four notable flights (AA11, UA175, AA77, UA93) with crew/souls/fate metadata, RADES radar returns, a 3D globe with terrain and per-airframe aircraft models, radar-sweep and loop-replay modes, area selection → saved filters, and a retro 8-bit "radar" map style.
- **Weather** — a new app driven by a reconstructed Sept 2001 weather record: conditions, forecasts, almanac, and an animated radar loop.
- **MarketWatch** — a period-accurate finance app with archival price overrides and synthetic intraday data.
- **README**, **Account**, and **Playlist Editor** apps — a site-news reader, real user accounts with SSO, and a teacher-facing playlist builder.
- **HyperCard** — a full visual stack editor plus embeddable app "cards" (TV, radio, news, pager, weather, flight map), shipped with a *Getting Started* guided tour and The Oregon Trail as a playable stack.
- **Mobile** — a complete iPod-style shell for phones, with Radio, TV, Now Playing, and Time Travel.
- **Accounts & classroom** — Directus-backed sign-in (Google/Apple SSO), profile editing with verified email, a Teacher role, and teacher-authored playlists that remotely drive every app.
- **Alerts** — a live emergency-alert system with an Apple-menu control panel.
- **Central clock** — the streamer can now force every connected client to one synchronized time (classroom/broadcast mode).
- **Filesystem sync** — a signed-in user's desktop files now persist to their account and follow them across devices.

Behind the scenes: new streamer channels (flights, weather, alerts, forced clock, flights-history), new offline pipelines (flight-recon, weather-recon, market-data, audio normalization), 23-channel subtitle coverage, self-healing transcription/usenet workers, and session analytics via OpenReplay.

---

## Apps

### Flight Tracker (new)
A MapLibre GL + PMTiles app that replays air traffic against the virtual clock.

- Live airborne flights streamed from the new `flights` channel, with dead-reckoning motion, heading-rotated plane icons, and gradient comet trails.
- **The four notable flights** — AA11, UA175, AA77, UA93 — curated from NTSB data, with aircraft type, tail number, crew, souls aboard, hijackers, and fate revealed on the virtual clock; flights persist at their crash sites.
- **3D mode**: globe projection, camera pitch/tilt, per-airframe 3D aircraft models, altitude curtains, 3D terrain with hillshading, and camera-follow modes.
- **Radar map style**: retro sweep animation with afterglow, plus 8-bit pixelated plane sprites.
- **Loop / replay mode**: rewind and replay a time window with ghost trails.
- **Area selection**: draw a rectangle or circle to select flights and save the selection as a reusable filter; multi-flight detail pane.
- Map toolbar (zoom, compass/reset-north, cluster toggle, filter, terrain, map style), world-coverage vector basemap, satellite and classic styles, dark map, and crayon-style pin colors.
- Airport coordinates + haversine distance for from-origin / to-destination detail fields; RADES radar returns and the GOFER06 (C-130) observer highlighted.

### Weather (new)
- Conditions panel, forecast, and historical almanac for Sept 2001, streamed from the new `weather` channel.
- **Loop mode**: an animated radar strip with play/pause, window, speed, and scrub controls.
- Classic / radar / satellite basemaps via the shared basemap module; forecast re-requested on seek to avoid anachronisms.

### MarketWatch (new)
- Period-accurate finance app backed by static Wasabi JSON, with archival price overrides (Wayback-sourced) for delisted/lineage-broken symbols and a synthetic-intraday seam for real minute data.

### README (new)
- A site-news / blog reader backed by Directus, with a two-pane article list, sanitized HTML bodies, manual sort, featured (★) articles, and themed fonts.

### Account (new)
- Classicy-native sign-in window with Google and Apple SSO.
- Create-an-account registration with seamless email verification.
- Profile editor: names, demographics, verified email changes, password, and teacher avatar upload.

### Playlist Editor (new)
- Teacher-facing editor for authored playlists: *My Playlists* list with CRUD and Copy Link, full-definition editing with a File → Open dialog, and a read-only timeline with duration lanes and flags.
- Sign-in gated; saves are validated (incomplete entries blocked) with dirty-close confirmation.

### HyperCard (new — full stack editor)
- A complete visual stack editor: canvas, tool palette, inspector, visual + JSON script builders, and undo.
- Save to **Download** or **Directus** (7 schemas), with a first-create rebind so editing never duplicates rows.
- Embeddable app "cards": TV video + multiview, mp3 audio, news, pager, weather station, and flight map, plus a `setDateTime` action.
- Ships with a **Getting Started** guided-tour stack and **The Oregon Trail** as a playable game stack.

### Feedback (new)
- In-desktop feedback app with screenshot capture and thumbnails; submissions create GitHub issues and upload attachments via a new backend `/feedback` endpoint.

### Finder (new)
- System Finder app added to the desktop.

### TV
- Rendered through the shared `QuickTimeVideoEmbed` (bespoke caption pipeline retired).
- **Drag-to-reorder** the thumbnail strip with a classic Mac marching-ants outline; order persists per channel.
- Aggressive 3-tier ABR: quality watchdog, forced full-quality bump on single-view focus, and a fix for the channel-switch wedge.
- Closed captions across 23 channels (subtitles built + hosted on Wasabi); caption color via `ClassicyColorPicker`.

### Radio Scanner
- **Closed captions** now render in the focused-item player, with TV-style caption settings.
- One-button-per-station playlist playback, click-to-solo a now-playing item, waveform visualizer settings (mode + colors), and a max-volume ceiling slider.
- Safari mute/solo fixed by driving an in-graph gain node; now-playing marquee scrolls only on overflow.

### Browser
- 90s-style retro spinning-globe loading throbber.

---

## Mobile
- A complete **iPod-style shell** for touch devices: click-wheel navigation, main menu, Radio station list, TV channel list with background audio, source-aware Now Playing, and a Time Travel screen (bookmarks + wheel time-scrubbing).
- Boot branches between the desktop and mobile shell on device detection; `?ipod` URL override forces the shell.

---

## Accounts, Classroom & Alerts
- **Authentication**: Directus auth REST wrapper, `AuthProvider` session context, Google/Apple SSO, and a **Teacher** role with native Directus permissions.
- **Teacher playlists**: authored playlists remotely drive every app — TV channel, Radio tuning, News/Flight focus, and Browser navigation — reconciled on a tick loop with availability-window gating.
- **Central (forced) clock**: the streamer can force all connected clients onto one master time via a key-guarded REST API, with clock frames and heartbeat drift correction; the frontend locks date/time editors, closes Time Machine, and suppresses playlist jumps while forced.
- **Alerts**: a live emergency-alert system — a new `alerts` streamer channel + `alert_items` with severity, a background extension that shows one alert at a time and remembers dismissals, and an **Alerts Manager** control panel in the Apple menu to enable/disable.
- **Filesystem sync**: a signed-in user's Classicy desktop files persist to their account (Directus/Wasabi) and follow them across devices, with login pull, logout reset, and a pre-sign-out flush.

---

## Streamer (backend)
- New subscription channels: **flights** (minute-bucketed Redis cache), **flights-history** (chunked replay for loop mode), **weather** (subscribe/snapshot/on-demand forecast), and **alerts** (NOTIFY trigger + Redis listener).
- **Forced clock mode**: Redis-backed `MasterClock`, clock frames on connect, init/seek clamped to master time, and a key-guarded `/clock` control API.
- Weather channel guards against NULL zone rows; binary MessagePack wire protocol documented per channel.

---

## Data pipelines (tools)
- **flight-recon** (new): reconstructs BTS flight trajectories → Directus via a Prefect k8s work pool; real Sept 2001 data loaded (3.47M positions) with a Postgres COPY fast path, era-correct 2001 fleet reference, and a decode map for EBCDIC-mangled tail numbers.
- **weather-recon** (new): rebuilds the Sept 2001 weather record — IEM radar composites, AFOS forecasts, and GHCN almanac → Wasabi/Postgres, with station→2001-zone resolution.
- **market-data** (new): generates MarketWatch price data (Yahoo/FRED) with split un-adjustment, fail-loud validation, and archival overrides for delisted symbols.
- **audio normalization** (new): a two-pass loudnorm Prefect pipeline (migration 005 `normalize_jobs`) that archives originals and best-effort purges Cloudflare.
- **Resilience**: usenet and transcription workers now self-heal orphaned jobs via a supervisor + heartbeat pattern.

---

## Platform & Infrastructure
- **OpenReplay** session analytics: tracker baked into the bundle, app open/close + TV channel + pause/resume/seek + virtual-time tracking, and signed-in-user identification.
- **Accessibility**: `eslint-plugin-jsx-a11y` added and violations fixed.
- **Basemaps**: shared classic/radar/satellite basemap module; world-coverage vector basemap + glyph fonts and satellite/terrain PMTiles hosted on Wasabi.
- App icons registered via the `ClassicyIcons` registry (Time Machine, Feedback, Flight Tracker).
- Pre-boot **About / content-warning screen** on the desktop.
- Streamer tests added and gating the build; GHCR registry cache for the video-grabber image.

---

_Generated from git history for June 27 – July 21, 2026._
