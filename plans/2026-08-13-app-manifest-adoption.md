# Classicy App Manifest Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every `registerAppEventHandler` call in `packages/frontend` (12 call sites, 11 app ids) to classicy 0.72.0's unified `registerApp` manifest API, with zod action/state schemas, at exact behavioral parity.

**Architecture:** Each app's existing context/settings module keeps its reducer unchanged and swaps its bottom-of-file `registerAppEventHandler(prefix, handler)` call for one `registerApp({ id, description, prefix, handler, actions, state })` call, with a `z.looseObject` state schema co-located in the same file. A single shared test file (`src/appManifests.test.ts`) imports the real (unmocked) classicy registry and asserts every app's manifest landed. FlightTracker exercises the multi-module merge path (two prefixes, one app id); the playlist store plugin registers prefix+action only, with no state schema.

**Tech Stack:** classicy ≥ 0.72.0 (`registerApp` API), zod ^4.4.3 (new direct dependency), Vitest, TypeScript.

**Spec:** `plans/2026-08-13-app-manifest-handoff.md` (the Classicy team's handoff doc, saved verbatim; API verified present in classicy 0.72.0's published types).

## Global Constraints

- classicy must be ≥ 0.72.0 (`registerApp` first ships there; installed 0.71.7 does NOT export it). The dep stays pinned to `"latest"` — never hand-edit the version (root `CLAUDE.md`); bump via `pnpm update classicy --latest --recursive`.
- `zod` becomes a direct dependency of `packages/frontend` at `"^4.4.3"` — the exact range classicy itself declares, so pnpm resolves one shared instance. (pnpm's strict `node_modules` forbids importing it transitively.)
- Every state schema is `z.looseObject(...)`, never `z.object(...)`; every top-level state field is `.optional()` with a `.describe()`; every action entry has a `description` (handoff §2 — this text feeds balloon help and discovery).
- **Zero behavior change.** No `scriptable: true` anywhere in this migration (the repo has zero `registerClassicyUntrustedActionAllowlist` calls today — empty allowlist is parity). No `parseAppData` adoption (the repo has zero `isXData`-style guards; the existing `readXSettings` per-field-fallback readers already normalize invalid values, which is stronger than `parseAppData`'s all-or-nothing check).
- Reducers are NOT modified. Only the import block, the added schema, and the registration call at the bottom of each file change.
- Every commit message ends with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (project provenance requirement — root `CLAUDE.md`).
- Full gates before declaring done: `pnpm --filter @rt911/frontend exec tsc -b`, `pnpm lint`, `pnpm test`, and a dev-console sweep confirming zero `[registerApp]` schema warnings.
- **Test-mock hazard (the biggest risk in this migration):** 49 test files `vi.mock("classicy")`; 26 spread `importOriginal` (safe), but 23 are full factories. A full factory that omits `registerApp` throws `registerApp is not a function` for any module in the test's import graph that calls it at module load. Task 1 hardens all 23 preemptively.

---

### Task 1: Toolchain — classicy 0.72, zod, and test-mock hardening

**Files:**
- Modify: `packages/frontend/package.json` (add zod)
- Modify: `pnpm-lock.yaml` (via pnpm)
- Modify: the 23 full-factory `vi.mock("classicy", ...)` test files listed in Step 3

**Interfaces:**
- Produces: `registerApp`, `getAppManifest`, `listScriptableActions` importable from `"classicy"`; `z` importable from `"zod"`; every full-factory classicy mock stubs `registerApp`.

- [ ] **Step 1: Bump classicy and add zod**

```bash
cd /home/robbiebyrd/rt911
pnpm update classicy --latest --recursive
pnpm --filter @rt911/frontend add zod@^4.4.3
```

- [ ] **Step 2: Verify the new API is present**

```bash
grep -c "registerApp" packages/frontend/node_modules/classicy/dist/types/src/SystemFolder/ControlPanels/AppManager/ClassicyAppManifest.d.ts
node -e "console.log(require('/home/robbiebyrd/rt911/packages/frontend/node_modules/classicy/package.json'.replace(/package\.json$/,'') + 'package.json'))" 2>/dev/null || true
cat packages/frontend/node_modules/.pnpm/classicy@*/node_modules/classicy/package.json | grep '"version"'
```
Expected: grep count ≥ 1; version ≥ 0.72.0.

- [ ] **Step 3: Add `registerApp` stubs to every full-factory classicy mock**

These 23 files `vi.mock("classicy", () => ({...}))` without `importOriginal`. In each factory object, add the line `registerApp: () => {},` (next to the existing `registerAppEventHandler: () => {},` stub where one exists; otherwise anywhere in the factory object):

```
src/Applications/Account/SpecialTab.realAlert.test.tsx
src/Applications/Feedback/Feedback.test.tsx
src/Applications/FlightTracker/FlightTracker.test.tsx
src/Applications/HyperCard/extensions/DirectusFlightMapPart.test.tsx
src/Applications/HyperCard/extensions/DirectusVideoPart.test.tsx
src/Applications/HyperCard/extensions/DirectusWeatherPart.test.tsx
src/Applications/HyperCard/extensions/HyperCardClockBridge.test.tsx
src/Applications/IMBuddies/IMBuddiesProvider.test.tsx
src/Applications/PagerDecoder/usePagerPlayback.test.ts
src/Applications/RadioScanner/CaptionOverlay.test.tsx
src/Applications/RadioScanner/RadioScanner.test.tsx
src/Applications/Weather/Weather.test.tsx
src/Providers/FilesystemSync/FilesystemSyncProvider.test.tsx
src/Providers/MediaStream/MediaStreamProvider.chat.test.tsx
src/Providers/MediaStream/MediaStreamProvider.clock.test.tsx
src/Providers/MediaStream/MediaStreamProvider.flights.test.tsx
src/Providers/MediaStream/MediaStreamProvider.newsBody.test.tsx
src/Providers/MediaStream/MediaStreamProvider.news.test.tsx
src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx
src/Providers/MediaStream/MediaStreamProvider.reconnect.test.tsx
src/Providers/MediaStream/MediaStreamProvider.weather.test.tsx
src/Providers/MediaStream/playlistGating.test.tsx
src/Providers/Playlist/RoomControlBridge.test.tsx
```

The stub shape (example — match each file's existing factory style):

```ts
vi.mock("classicy", () => ({
	// ...existing entries...
	registerAppEventHandler: () => {},
	registerApp: () => {},
}));
```

- [ ] **Step 4: Full suite green before any migration**

Run: `pnpm test`
Expected: PASS (identical to pre-task baseline — this task changes no behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/package.json pnpm-lock.yaml packages/frontend/src
git commit -m "chore(frontend): classicy 0.72 + zod dep + registerApp mock stubs

Prep for app-manifest adoption: bump classicy to the registerApp API,
add zod (classicy's own range, one shared instance), and stub
registerApp in every full-factory classicy vi.mock so module-load
registration can't break unrelated suites.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared manifest test scaffold

**Files:**
- Create: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Produces: a `CASES` table each later task appends one row to: `[appId, prefixes[], actionTypes[], hasState]`. Later tasks only add rows and their migration — the assertions here never change.

- [ ] **Step 1: Write the test file with the first row (TV.app) — it must FAIL until Task 3 migrates TV**

```ts
// packages/frontend/src/appManifests.test.ts
//
// Deliberately NO vi.mock("classicy"): these tests exercise the real manifest
// registry that each context module writes into at import time. Importing a
// context module below runs its registerApp() side effect.
import { describe, expect, it } from "vitest";
import { getAppManifest, listScriptableActions } from "classicy";

import "./Applications/TV/TVContext";

// [appId, expected prefixes, spot-checked action types, has a state schema]
const CASES: Array<[string, string[], string[], boolean]> = [
	[
		"TV.app",
		["ClassicyAppTV"],
		["ClassicyAppTVTuneChannel", "ClassicyAppTVSetGridState", "ClassicyAppTVSetChannelOrder"],
		true,
	],
];

describe("app manifests", () => {
	it.each(CASES)(
		"%s registers prefixes, described actions, and state",
		(appId, prefixes, actionTypes, hasState) => {
			const m = getAppManifest(appId);
			expect(m, `${appId} has no manifest — registerApp not called?`).toBeDefined();
			expect(m!.prefixes).toEqual(expect.arrayContaining(prefixes));
			for (const type of actionTypes) {
				expect(
					m!.actions[type]?.description,
					`${type} missing or missing description`,
				).toBeTruthy();
			}
			if (hasState) expect(m!.state).toBeDefined();
		},
	);

	it("exposes no scriptable actions (parity with the empty pre-manifest allowlist)", () => {
		expect(listScriptableActions()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to verify it fails for the right reason**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts`
Expected: FAIL — `TV.app has no manifest` (NOT an import error; an import error means Task 1 was incomplete).

- [ ] **Step 3: Commit (red test rides with Task 3's green — commit both together in Task 3 Step 5 if your workflow forbids red commits; otherwise commit now)**

```bash
git add packages/frontend/src/appManifests.test.ts
git commit -m "test(frontend): app-manifest registry assertions (red until TV migrates)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migrate TV.app

**Files:**
- Modify: `packages/frontend/src/Applications/TV/TVContext.ts` (imports at 1–2, registration at 226)
- Test: `packages/frontend/src/appManifests.test.ts` (row already present from Task 2)

**Interfaces:**
- Consumes: `registerApp` from classicy; `CaptionStyle`, `TVRemoteCommand`, `classicyTVEventHandler` already in the file.
- Produces: exported `TvDataSchema` (z.looseObject) and `TVContext`'s existing exports unchanged.

- [ ] **Step 1: Replace the registration in `TVContext.ts`**

Change the imports at the top:

```ts
import type { ActionMessage, ClassicyStore } from "classicy";
import { registerApp } from "classicy";
import { z } from "zod";
```

Add the schemas above the `registerAppEventHandler` call, then replace that call (line 226) with `registerApp`:

```ts
const captionStyleSchema = z.object({
	font: z.string().describe("CSS custom-property name for the caption font family, e.g. \"--ui-font\"."),
	color: z.number().describe("Caption text color, packed 0xRRGGBB."),
	colorOpacity: z.number().describe("Caption text alpha, 0..1."),
	bgColor: z.number().describe("Caption background color, packed 0xRRGGBB."),
	bgOpacity: z.number().describe("Caption background alpha, 0..1."),
	size: z.number().describe("Caption font-size scale, percent (100 = base size)."),
});

const channelRefSchema = z
	.union([z.number(), z.string()])
	.describe("A channel by numeric MediaItem id or by source slug (e.g. \"WETA\").");

export const TvDataSchema = z.looseObject({
	multiSelectMode: z.boolean().optional().describe("Whether grid view is in multi-select mode."),
	selectedChannels: z.array(z.string()).optional().describe("Source slugs of the channels selected in grid view."),
	mutedChannels: z.array(z.string()).optional().describe("Source slugs of grid channels the user has muted."),
	channelVolumes: z.record(z.string(), z.number()).optional().describe("Per-channel volume (0..1) keyed by source slug."),
	disabledChannels: z.array(z.string()).optional().describe("Source slugs the user turned off in Settings (blacklist: new channels default on)."),
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each one-shot command applies exactly once."),
			kind: z.enum(["tune", "grid", "exitGrid"]).describe("Which remote command to run."),
			channel: channelRefSchema.optional(),
			channels: z.array(channelRefSchema).optional(),
		})
		.optional()
		.describe("Pending one-shot remote-control command (tune / grid / exitGrid)."),
	volumeLimit: z.number().optional().describe("Maximum volume (0..1) applied to any playing video."),
	overallMuted: z.boolean().optional().describe("Whether every video is muted at once."),
	tvPaused: z.boolean().optional().describe("Whether playback is frozen (the virtual clock keeps running)."),
	captionsOn: z.boolean().optional().describe("Whether closed captions are shown."),
	captionStyle: captionStyleSchema.optional().describe("Closed-caption display style."),
	activePlayer: z.number().optional().describe("MediaItem id of the active single-view player."),
	currentChannel: z.string().optional().describe("Source slug of the active channel, published for external controllers (playlist locked-focus)."),
	channelOrder: z.array(z.string()).optional().describe("User's drag-ordered source slugs for the thumbnail strip."),
});

export type TvData = z.infer<typeof TvDataSchema>;

registerApp({
	id: TV_APP_ID,
	description: "Watch the synchronized 9/11 broadcast channels, live to the virtual clock.",
	prefix: "ClassicyAppTV",
	handler: classicyTVEventHandler,
	actions: {
		ClassicyAppTVSetGridState: {
			description: "Persist grid view's selection, mute, and volume state.",
			params: z.object({
				multiSelectMode: z.boolean().describe("Whether multi-select mode is on."),
				selectedChannels: z.array(z.string()).describe("Selected channels' source slugs."),
				mutedChannels: z.array(z.string()).describe("Muted channels' source slugs."),
				channelVolumes: z.record(z.string(), z.number()).describe("Per-channel volume (0..1) keyed by source slug."),
			}),
		},
		ClassicyAppTVSetDisabledChannels: {
			description: "Persist which channels the user turned off in Settings.",
			params: z.object({
				disabledChannels: z.array(z.string()).describe("Disabled channels' source slugs."),
			}),
		},
		ClassicyAppTVTuneChannel: {
			description: "Tune to a single channel and show it as the only video.",
			params: z.object({ channel: channelRefSchema }),
		},
		ClassicyAppTVSetGrid: {
			description: "Show a grid of the given channels.",
			params: z.object({ channels: z.array(channelRefSchema).describe("Channels to show in the grid.") }),
		},
		ClassicyAppTVExitGrid: {
			description: "Leave grid view and return to a single active channel.",
		},
		ClassicyAppTVSetVolumeLimit: {
			description: "Set the maximum volume applied to any playing video.",
			params: z.object({ volumeLimit: z.number().describe("Volume ceiling, 0..1.") }),
		},
		ClassicyAppTVSetMuted: {
			description: "Mute or unmute every video at once.",
			params: z.object({ muted: z.boolean().describe("true = mute all.") }),
		},
		ClassicyAppTVPause: {
			description: "Freeze every video; the virtual clock keeps running.",
		},
		ClassicyAppTVPlay: {
			description: "Resume playback at the live virtual-clock time (not where it paused).",
		},
		ClassicyAppTVSetCaptionState: {
			description: "Set whether closed captions are on and their display style.",
			params: z.object({
				captionsOn: z.boolean().describe("Whether captions are shown."),
				captionStyle: captionStyleSchema,
			}),
		},
		ClassicyAppTVSetActivePlayer: {
			description: "Persist which channel is the active single-view player.",
			params: z.object({ activePlayer: z.number().describe("Active player's MediaItem id.") }),
		},
		ClassicyAppTVSetCurrentChannel: {
			description: "Publish the active channel's source slug for external controllers.",
			params: z.object({ source: z.string().describe("The active channel's source slug.") }),
		},
		ClassicyAppTVSetChannelOrder: {
			description: "Persist the user's drag-ordered channel strip.",
			params: z.object({ channelOrder: z.array(z.string()).describe("Source slugs in display order.") }),
		},
	},
	state: TvDataSchema,
});
```

Delete the old `registerAppEventHandler("ClassicyAppTV", classicyTVEventHandler);` line and the now-unused `registerAppEventHandler` import.

- [ ] **Step 2: Manifest test goes green**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts`
Expected: PASS.

- [ ] **Step 3: TV's existing suites stay green**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/TV`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/Applications/TV/TVContext.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): TV.app manifest via registerApp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Migrate FlightTracker.app (multi-module merge)

FlightTracker is the repo's instance of handoff §3: two modules, one app id. `flightMapSettings.ts` is the primary (registers `description` intent + the state schema, which must also cover the keys `flightTrackerCommands.ts` writes: `command`, `focusedFlight`); `flightTrackerCommands.ts` is secondary (prefix + actions only, no state). Both files load at import time from `FlightTracker.tsx`; merge is additive so order only affects which `description`/`state` wins — give both the same `description` string so order can't matter.

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/flightMapSettings.ts` (registration at 233–236)
- Modify: `packages/frontend/src/Applications/FlightTracker/flightTrackerCommands.ts` (registration at 62)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `LOOP_SPEEDS` (`[10,20,50,100,500]`) from `./loopClock`; `FlightFilter`/`EMPTY_FLIGHT_FILTER` from `./flightFilter`; `BASEMAP` style ids via the existing `BasemapStyleId` import; `CameraMode` via the existing import.
- Produces: exported `FlightTrackerDataSchema` from `flightMapSettings.ts`.

- [ ] **Step 1: `flightMapSettings.ts` — primary registration**

Imports: swap `registerAppEventHandler` for `registerApp`, add `import { z } from "zod";` and add `LOOP_SPEEDS` to the existing `./loopClock` import.

Above the old registration call, add (then replace the call):

```ts
const FLIGHT_TRACKER_DESCRIPTION =
	"Radar-reconstructed flight map for September 11, 2001 — tracks, loops, and airport POIs.";

export const FlightTrackerDataSchema = z.looseObject({
	mapSettings: z
		.looseObject({
			mapStyle: z.string().describe("Basemap display mode id (classic/radar/satellite)."),
			darkMap: z.boolean().describe("Dark basemap variant; orthogonal to mapStyle."),
			pinColorLight: z.number().describe("Aircraft pin color on light basemaps, packed 0xRRGGBB."),
			pinColorDark: z.number().describe("Aircraft pin color on dark basemaps, packed 0xRRGGBB."),
			notablePinColorLight: z.number().describe("Notable-flight pin color on light basemaps, packed 0xRRGGBB."),
			notablePinColorDark: z.number().describe("Notable-flight pin color on dark basemaps, packed 0xRRGGBB."),
			observerPinColorLight: z.number().describe("Witness-aircraft pin color on light basemaps, packed 0xRRGGBB."),
			observerPinColorDark: z.number().describe("Witness-aircraft pin color on dark basemaps, packed 0xRRGGBB."),
			buildingHeroColorLight: z.number().describe("Hero-building color on light basemaps, packed 0xRRGGBB."),
			buildingHeroColorDark: z.number().describe("Hero-building color on dark basemaps, packed 0xRRGGBB."),
			radarSweep: z.boolean().describe("Whether the radar sweep animation is shown."),
			trailMultiplier: z.number().describe("Comet-tail length as a multiple of base TRAIL_POINTS; 0 = off."),
			globe: z.boolean().describe("Globe projection toggle."),
			cluster: z.boolean().describe("Marker clustering toggle."),
			threeD: z.boolean().describe("3D buildings/extrusion toggle."),
			terrain: z.boolean().describe("Topographic relief (hillshade + 3D ground mesh)."),
			anonTraffic: z.boolean().describe("Show anonymous radar traffic (RDR-… ids) as an opt-in layer."),
			cameraMode: z.string().describe("Camera-follow framing for tracked flights (track/cockpit/highlight)."),
		})
		.partial()
		.optional()
		.describe("Map appearance and layer-toggle preferences (the Settings dialog)."),
	loopSettings: z
		.looseObject({
			enabled: z.boolean().describe("Whether radar-loop replay mode is on."),
			windowMinutes: z.union([z.literal(30), z.literal(90)]).describe("Replay window length in minutes."),
			speed: z
				.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100), z.literal(500)])
				.describe("Replay speed multiplier."),
		})
		.partial()
		.optional()
		.describe("Loop-strip playback preferences; ephemeral playhead state is never persisted."),
	filterSettings: z
		.looseObject({
			flight: z.string().describe("Flight-number criterion; \"\" = any."),
			tail: z.string().describe("Tail-number criterion; \"\" = any."),
			carrier: z.string().describe("Carrier criterion; \"\" = any."),
			origin: z.string().describe("Origin-airport criterion; \"\" = any."),
			dest: z.string().describe("Destination-airport criterion; \"\" = any."),
			flights: z.array(z.string()).describe("Explicit flight list from an area selection; [] = inactive."),
		})
		.partial()
		.optional()
		.describe("The Filter Flights window's criteria; ANDed together."),
	poiSettings: z
		.looseObject({
			enabled: z.boolean().describe("Master POI-layer toggle."),
			disabledLayers: z.array(z.string()).describe("POI layers turned off (blacklist: new layers default visible)."),
			unclusteredLayers: z.array(z.string()).describe("POI layers with clustering off (default: all cluster)."),
		})
		.partial()
		.optional()
		.describe("Airport/POI marker-layer preferences (the Layers… window)."),
	// Written by flightTrackerCommands.ts (secondary module, handoff §3 convention):
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each focus command applies exactly once."),
			kind: z.literal("focus").describe("Command kind; only \"focus\" exists."),
			callsign: z.string().describe("Callsign to select, e.g. \"AA11\"."),
		})
		.optional()
		.describe("Pending one-shot remote focus command."),
	focusedFlight: z
		.string()
		.nullable()
		.optional()
		.describe("Currently selected flight's callsign, published for playlist locked-focus."),
});

export type FlightTrackerData = z.infer<typeof FlightTrackerDataSchema>;

registerApp({
	id: appId,
	description: FLIGHT_TRACKER_DESCRIPTION,
	prefix: "ClassicyAppFlightTracker",
	handler: classicyFlightTrackerEventHandler,
	actions: {
		ClassicyAppFlightTrackerSetMapSettings: {
			description: "Persist the whole map-appearance settings object.",
			params: z.object({ mapSettings: z.record(z.string(), z.unknown()).describe("Full FlightMapSettings object.") }),
		},
		ClassicyAppFlightTrackerSetLoopSettings: {
			description: "Persist the whole loop-playback settings object.",
			params: z.object({ loopSettings: z.record(z.string(), z.unknown()).describe("Full FlightLoopSettings object.") }),
		},
		ClassicyAppFlightTrackerSetFilterSettings: {
			description: "Persist the whole flight-filter criteria object.",
			params: z.object({ filterSettings: z.record(z.string(), z.unknown()).describe("Full FlightFilter object.") }),
		},
		ClassicyAppFlightTrackerSetPoiSettings: {
			description: "Persist the whole POI-layer settings object.",
			params: z.object({ poiSettings: z.record(z.string(), z.unknown()).describe("Full FlightPoiSettings object.") }),
		},
	},
	state: FlightTrackerDataSchema,
});
```

Note the pattern for "whole settings object in one dispatch" actions: the *state* schema documents the detailed field shapes (that's where balloon help reads from); the *params* schema stays a described record because the reducer stores the object opaquely. Export `FLIGHT_TRACKER_DESCRIPTION` is intentionally module-local (not exported) — `flightTrackerCommands.ts` repeats the string literal below so neither file imports the other (they are deliberately independent modules today).

- [ ] **Step 2: `flightTrackerCommands.ts` — secondary registration (no state)**

Swap `registerAppEventHandler` for `registerApp`, add `import { z } from "zod";`, replace line 62's call:

```ts
registerApp({
	id: appId,
	description:
		"Radar-reconstructed flight map for September 11, 2001 — tracks, loops, and airport POIs.",
	prefix: "ClassicyAppFlightRemote",
	handler: classicyFlightRemoteEventHandler,
	actions: {
		ClassicyAppFlightRemoteFocus: {
			description: "Select the flight with this callsign (one-shot; retries until it is airborne).",
			params: z.object({ callsign: z.string().describe("Callsign to focus, e.g. \"AA11\".") }),
		},
		ClassicyAppFlightRemoteSetFocused: {
			description: "Publish the currently selected flight (playlist locked-focus reads this).",
			params: z.object({
				callsign: z.string().nullable().describe("Selected callsign, or null when nothing is selected."),
			}),
		},
	},
	// State schema intentionally omitted: flightMapSettings.ts is the primary
	// module and its FlightTrackerDataSchema covers command/focusedFlight
	// (handoff §3 — first state schema wins; a second one would warn).
});
```

- [ ] **Step 3: Add the manifest-test row**

In `src/appManifests.test.ts`, add the import and row:

```ts
import "./Applications/FlightTracker/flightMapSettings";
import "./Applications/FlightTracker/flightTrackerCommands";
```

```ts
	[
		"FlightTracker.app",
		["ClassicyAppFlightTracker", "ClassicyAppFlightRemote"],
		["ClassicyAppFlightTrackerSetMapSettings", "ClassicyAppFlightRemoteFocus"],
		true,
	],
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Applications/FlightTracker`
Expected: PASS, and no console warning about a second state schema (both registrations must agree the state comes from flightMapSettings only).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): FlightTracker.app manifest via registerApp (two-module merge)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Migrate Browser.app

**Files:**
- Modify: `packages/frontend/src/Applications/Browser/BrowserContext.ts` (registration at 115)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `BrowserFavorite`, `BrowserHistoryEntry`, `BrowserHomePage`, `BrowserRemoteCommand` interfaces already in the file; `TimeMachineProxyConfig` shape (`enabled, protocol, host, port, archiveTime, proxyPrefix, path`) from `./useBrowserNavigation` — mirror it, do not import it (would be a value-less type import anyway).
- Produces: exported `BrowserDataSchema`.

- [ ] **Step 1: Replace the registration in `BrowserContext.ts`**

Imports: swap `registerAppEventHandler` → `registerApp`, add `import { z } from "zod";`.

```ts
const favoriteSchema = z.object({
	id: z.string().describe("Stable favorite id."),
	title: z.string().describe("Display title."),
	url: z.string().describe("Destination URL."),
	icon: z.string().describe("Icon asset URL."),
});

export const BrowserDataSchema = z.looseObject({
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each navigation applies exactly once."),
			kind: z.literal("navigate").describe("Command kind; only \"navigate\" exists."),
			url: z.string().describe("URL to navigate the Browser window to."),
		})
		.optional()
		.describe("Pending one-shot remote navigation (playlist scheduled browser entries)."),
	homePage: z
		.object({
			url: z.string().describe("Home page URL."),
			label: z.string().describe("Home button label."),
			icon: z.string().describe("Home button icon URL."),
		})
		.optional()
		.describe("The user's chosen home page."),
	favorites: z.array(favoriteSchema).optional().describe("The favorites bar's entries, in order."),
	history: z
		.array(
			z.object({
				url: z.string().describe("Visited URL."),
				visitedAt: z.string().describe("ISO-8601 visit timestamp."),
			}),
		)
		.optional()
		.describe("Visit history, deduplicated by normalized URL, capped at 500."),
	proxyConfig: z
		.looseObject({
			enabled: z.boolean().describe("Whether the Time Machine web proxy is used."),
			protocol: z.string().describe("Proxy scheme, e.g. \"https\"."),
			host: z.string().describe("Proxy host."),
			port: z.number().describe("Proxy port."),
			archiveTime: z.string().describe("Wayback timestamp the proxy pins pages to."),
			proxyPrefix: z.string().describe("Path prefix the proxy expects."),
			path: z.string().describe("Extra path segment appended after the prefix."),
		})
		.partial()
		.optional()
		.describe("Time Machine proxy configuration (mirrors TimeMachineProxyConfig)."),
	showFavoritesBar: z.boolean().optional().describe("Whether the favorites bar is visible."),
});

export type BrowserData = z.infer<typeof BrowserDataSchema>;

registerApp({
	id: "Browser.app",
	description: "Browse the September 2001 web through the Time Machine archive proxy.",
	prefix: "ClassicyAppBrowser",
	handler: classicyBrowserEventHandler,
	actions: {
		ClassicyAppBrowserNavigate: {
			description: "Navigate the Browser window to a URL (one-shot).",
			params: z.object({ url: z.string().describe("URL to open.") }),
		},
		ClassicyAppBrowserSetHomePage: {
			description: "Set the home page (URL, label, and icon).",
			params: z.object({
				url: z.string().describe("Home page URL."),
				label: z.string().describe("Home button label."),
				icon: z.string().describe("Home button icon URL."),
			}),
		},
		ClassicyAppBrowserInitFavorites: {
			description: "Seed the favorites list, only if none exists yet.",
			params: z.object({ favorites: z.array(favoriteSchema).describe("Initial favorites.") }),
		},
		ClassicyAppBrowserAddFavorite: {
			description: "Append one favorite.",
			params: z.object({ favorite: favoriteSchema }),
		},
		ClassicyAppBrowserRemoveFavorite: {
			description: "Remove the favorite with this id.",
			params: z.object({ id: z.string().describe("Favorite id to remove.") }),
		},
		ClassicyAppBrowserRecordVisit: {
			description: "Record a visit in history (deduplicated by normalized URL, capped at 500).",
			params: z.object({ url: z.string().describe("Visited URL.") }),
		},
		ClassicyAppBrowserClearHistory: {
			description: "Clear all browsing history.",
		},
		ClassicyAppBrowserUpdateProxyConfig: {
			description: "Replace the Time Machine proxy configuration.",
			params: z.object({
				proxyConfig: z.record(z.string(), z.unknown()).describe("Full TimeMachineProxyConfig object."),
			}),
		},
		ClassicyAppBrowserSetShowFavoritesBar: {
			description: "Show or hide the favorites bar.",
			params: z.object({ showFavoritesBar: z.boolean().describe("true = show the bar.") }),
		},
	},
	state: BrowserDataSchema,
});
```

- [ ] **Step 2: Add the manifest-test row**

```ts
import "./Applications/Browser/BrowserContext";
```

```ts
	[
		"Browser.app",
		["ClassicyAppBrowser"],
		["ClassicyAppBrowserNavigate", "ClassicyAppBrowserAddFavorite", "ClassicyAppBrowserClearHistory"],
		true,
	],
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Applications/Browser`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src/Applications/Browser/BrowserContext.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): Browser.app manifest via registerApp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Migrate RadioScanner.app and Weather.app

**Files:**
- Modify: `packages/frontend/src/Applications/RadioScanner/RadioScannerContext.ts` (registration at 62)
- Modify: `packages/frontend/src/Applications/Weather/weatherSettings.ts` (registration at 108)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `RadioScannerSettings` shape (`vizMode, useThemeColors, colorBright, colorDim, maxVolume, captionStyle, playOriginalAudio`) and `VIZ_MODES` (`["Bars","Spectrum","Radial","Wave"]`) from `./radioScannerSettings`; `WeatherLoopSettings`/`WeatherMapSettings` interfaces already in `weatherSettings.ts`; `WEATHER_LOOP_SPEEDS` (`[600,1800,3600]`).
- Produces: exported `RadioScannerDataSchema`, `WeatherDataSchema`.

- [ ] **Step 1: `RadioScannerContext.ts`**

Imports: swap `registerAppEventHandler` → `registerApp`, add `import { z } from "zod";`.

```ts
export const RadioScannerDataSchema = z.looseObject({
	activeStation: z.string().optional().describe("Slug of the station currently tuned."),
	mutedItems: z.array(z.string()).optional().describe("Slugs of stations the user has muted."),
	showWaveform: z.boolean().optional().describe("Whether the waveform visualizer overlay is shown."),
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each tune command applies exactly once."),
			kind: z.literal("tune").describe("Command kind; only \"tune\" exists."),
			station: z.string().describe("Station slug to tune to."),
		})
		.optional()
		.describe("Pending one-shot remote tune command."),
	settings: z
		.looseObject({
			vizMode: z.enum(["Bars", "Spectrum", "Radial", "Wave"]).describe("Waveform display type."),
			useThemeColors: z.boolean().describe("true = follow the desktop theme colors, re-theming live."),
			colorBright: z.number().describe("Custom bright color, packed 0xRRGGBB."),
			colorDim: z.number().describe("Custom dim (gradient end) color, packed 0xRRGGBB."),
			maxVolume: z.number().describe("Volume ceiling for all audio, percent 0..100."),
			captionStyle: z.record(z.string(), z.unknown()).describe("Closed-caption appearance (CaptionStyle)."),
			playOriginalAudio: z.boolean().describe("true = play the source recording instead of the noise-reduced render."),
		})
		.partial()
		.optional()
		.describe("The Settings window's persisted preferences."),
});

export type RadioScannerData = z.infer<typeof RadioScannerDataSchema>;

registerApp({
	id: appId,
	description: "Listen to synchronized 9/11 radio and scanner recordings by station.",
	prefix: "ClassicyAppRadioScanner",
	handler: classicyRadioScannerEventHandler,
	actions: {
		ClassicyAppRadioScannerSetState: {
			description: "Persist the active station, per-station mutes, and waveform visibility.",
			params: z.object({
				activeStation: z.string().describe("Tuned station's slug."),
				mutedItems: z.array(z.string()).describe("Muted stations' slugs."),
				showWaveform: z.boolean().describe("Whether the waveform overlay is shown."),
			}),
		},
		ClassicyAppRadioScannerTuneStation: {
			description: "Tune the scanner to a station by slug (one-shot; retries until the station list has it).",
			params: z.object({ station: z.string().describe("Station slug to tune to.") }),
		},
		ClassicyAppRadioScannerSetSettings: {
			description: "Replace the whole persisted settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full RadioScannerSettings object."),
			}),
		},
	},
	state: RadioScannerDataSchema,
});
```

- [ ] **Step 2: `weatherSettings.ts`**

Imports: swap `registerAppEventHandler` → `registerApp`, add `import { z } from "zod";`.

```ts
export const WeatherDataSchema = z.looseObject({
	loopSettings: z
		.looseObject({
			enabled: z.boolean().describe("Whether radar-loop replay mode is on."),
			windowHours: z
				.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)])
				.describe("Replay window length in hours."),
			speed: z
				.union([z.literal(600), z.literal(1800), z.literal(3600)])
				.describe("Replay speed multiplier (radar frames are on a 5-minute cadence)."),
		})
		.partial()
		.optional()
		.describe("Loop-strip playback preferences; ephemeral playhead state is never persisted."),
	mapSettings: z
		.looseObject({
			mapStyle: z.string().describe("Basemap display mode id (classic/radar/satellite)."),
			darkMap: z.boolean().describe("Dark basemap variant; orthogonal to mapStyle."),
		})
		.partial()
		.optional()
		.describe("Map appearance (the View menu's style items)."),
});

export type WeatherData = z.infer<typeof WeatherDataSchema>;

registerApp({
	id: WEATHER_APP_ID,
	description: "September 2001 weather: METAR conditions, NEXRAD radar loops, and forecasts.",
	prefix: "ClassicyAppWeather",
	handler: classicyWeatherEventHandler,
	actions: {
		ClassicyAppWeatherSetLoopSettings: {
			description: "Persist the whole loop-playback settings object.",
			params: z.object({
				loopSettings: z.record(z.string(), z.unknown()).describe("Full WeatherLoopSettings object."),
			}),
		},
		ClassicyAppWeatherSetMapSettings: {
			description: "Persist the whole map-appearance settings object.",
			params: z.object({
				mapSettings: z.record(z.string(), z.unknown()).describe("Full WeatherMapSettings object."),
			}),
		},
	},
	state: WeatherDataSchema,
});
```

- [ ] **Step 3: Add the manifest-test rows**

```ts
import "./Applications/RadioScanner/RadioScannerContext";
import "./Applications/Weather/weatherSettings";
```

```ts
	[
		"RadioScanner.app",
		["ClassicyAppRadioScanner"],
		["ClassicyAppRadioScannerTuneStation", "ClassicyAppRadioScannerSetSettings"],
		true,
	],
	[
		"Weather.app",
		["ClassicyAppWeather"],
		["ClassicyAppWeatherSetLoopSettings", "ClassicyAppWeatherSetMapSettings"],
		true,
	],
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Applications/RadioScanner src/Applications/Weather`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/RadioScanner/RadioScannerContext.ts packages/frontend/src/Applications/Weather/weatherSettings.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): RadioScanner.app and Weather.app manifests via registerApp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Migrate TimeMachine.app, Feedback.app, Readme.app

Three single-concern apps in one reviewable unit.

**Files:**
- Modify: `packages/frontend/src/Applications/TimeMachine/timeMachineSettings.ts` (registration at 74)
- Modify: `packages/frontend/src/Applications/Feedback/FeedbackContext.ts` (registration at 27)
- Modify: `packages/frontend/src/Applications/README/ReadmeContext.ts` (registration at 30)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `TimeMachineSettings` (`skipMinutes 1–60, stepSeconds 1–600, scrubSeconds 1–60`) already in `timeMachineSettings.ts`; `FEEDBACK_APP_ID` from `./useFeedback`; `ReadmeSettings` (`hiddenTagIds: number[]`) shape from `./readmeSettings`.
- Produces: exported `TimeMachineDataSchema`, `FeedbackDataSchema`, `ReadmeDataSchema`.

- [ ] **Step 1: `timeMachineSettings.ts`**

Imports: swap `registerAppEventHandler` → `registerApp`, add `import { z } from "zod";`.

```ts
export const TimeMachineDataSchema = z.looseObject({
	settings: z
		.looseObject({
			skipMinutes: z.number().describe("⇚/⇛ skip distance, minutes (1–60)."),
			stepSeconds: z.number().describe("«/» step distance, seconds (1–600)."),
			scrubSeconds: z.number().describe("‹/› scrub distance, seconds (1–60)."),
		})
		.partial()
		.optional()
		.describe("Transport preferences (the Settings window's sliders); invalid stored values fall back per-field."),
});

export type TimeMachineData = z.infer<typeof TimeMachineDataSchema>;

registerApp({
	id: TIME_MACHINE_APP_ID,
	description: "Travel the virtual clock: jump, skip, step, and scrub through September 11, 2001.",
	prefix: "ClassicyAppTimeMachine",
	handler: classicyTimeMachineEventHandler,
	actions: {
		ClassicyAppTimeMachineSetSettings: {
			description: "Persist the whole transport-settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full TimeMachineSettings object."),
			}),
		},
	},
	state: TimeMachineDataSchema,
});
```

- [ ] **Step 2: `FeedbackContext.ts`**

```ts
export const FeedbackDataSchema = z.looseObject({
	github: z
		.string()
		.optional()
		.describe("The reporter's GitHub handle; \"\" means explicitly cleared (distinct from never entered)."),
});

export type FeedbackData = z.infer<typeof FeedbackDataSchema>;

registerApp({
	id: FEEDBACK_APP_ID,
	description: "Report a bug or suggestion; filed as a GitHub issue.",
	prefix: "ClassicyAppFeedback",
	handler: classicyFeedbackEventHandler,
	actions: {
		ClassicyAppFeedbackSetGithub: {
			description: "Persist the reporter's GitHub handle (\"\" = cleared).",
			params: z.object({ github: z.string().describe("GitHub handle, or \"\" to clear.") }),
		},
	},
	state: FeedbackDataSchema,
});
```

- [ ] **Step 3: `ReadmeContext.ts`**

```ts
export const ReadmeDataSchema = z.looseObject({
	settings: z
		.looseObject({
			hiddenTagIds: z
				.array(z.number())
				.describe("Tag ids the reader has unchecked (hidden). Empty = show everything."),
		})
		.partial()
		.optional()
		.describe("Reader preferences (the tag filter); ephemeral UI is never persisted."),
});

export type ReadmeData = z.infer<typeof ReadmeDataSchema>;

registerApp({
	id: appId,
	description: "Read the project's About/README articles, outside the virtual clock's time gate.",
	prefix: "ClassicyAppReadme",
	handler: classicyReadmeEventHandler,
	actions: {
		ClassicyAppReadmeSetSettings: {
			description: "Persist the whole reader-settings object.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Full ReadmeSettings object."),
			}),
		},
	},
	state: ReadmeDataSchema,
});
```

- [ ] **Step 4: Add the manifest-test rows**

```ts
import "./Applications/TimeMachine/timeMachineSettings";
import "./Applications/Feedback/FeedbackContext";
import "./Applications/README/ReadmeContext";
```

```ts
	["TimeMachine.app", ["ClassicyAppTimeMachine"], ["ClassicyAppTimeMachineSetSettings"], true],
	["Feedback.app", ["ClassicyAppFeedback"], ["ClassicyAppFeedbackSetGithub"], true],
	["Readme.app", ["ClassicyAppReadme"], ["ClassicyAppReadmeSetSettings"], true],
```

(`Feedback.app` — confirm the literal in `FEEDBACK_APP_ID` in `src/Applications/Feedback/useFeedback.ts` and use that exact string in the row.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Applications/TimeMachine src/Applications/Feedback src/Applications/README`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/TimeMachine/timeMachineSettings.ts packages/frontend/src/Applications/Feedback/FeedbackContext.ts packages/frontend/src/Applications/README/ReadmeContext.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): TimeMachine, Feedback, Readme manifests via registerApp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Migrate News.app and PagerDecoder.app

**Files:**
- Modify: `packages/frontend/src/Applications/News/NewsContext.ts` (registration at 56)
- Modify: `packages/frontend/src/Applications/PagerDecoder/PagerDecoderContext.ts` (registration at 63–66)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `NewsRemoteCommand`, `PagerDecoderSettings`/`PagerDecoderFilter` interfaces already in the files.
- Produces: exported `NewsDataSchema`, `PagerDecoderDataSchema`.

- [ ] **Step 1: `NewsContext.ts`**

```ts
export const NewsDataSchema = z.looseObject({
	command: z
		.object({
			seq: z.number().describe("Monotonic sequence so each focus command applies exactly once."),
			kind: z.literal("focus").describe("Command kind; only \"focus\" exists."),
			docId: z.number().describe("MediaItem id of the article to open."),
		})
		.optional()
		.describe("Pending one-shot remote focus command (open an article's detail window)."),
	openDocuments: z
		.array(z.number())
		.optional()
		.describe("MediaItem ids of the article detail windows currently open (playlist locked-focus reads this)."),
});

export type NewsData = z.infer<typeof NewsDataSchema>;

registerApp({
	id: appId,
	description: "Wire-service and newspaper headlines, revealed live to the virtual clock.",
	prefix: "ClassicyAppNews",
	handler: classicyNewsEventHandler,
	actions: {
		ClassicyAppNewsFocusItem: {
			description: "Open the detail window for an article by MediaItem id (one-shot; retries until it exists).",
			params: z.object({ docId: z.number().describe("Article's MediaItem id.") }),
		},
		ClassicyAppNewsSetOpenDocuments: {
			description: "Publish which article detail windows are open.",
			params: z.object({
				openDocuments: z.array(z.number()).describe("Open articles' MediaItem ids."),
			}),
		},
	},
	state: NewsDataSchema,
});
```

- [ ] **Step 2: `PagerDecoderContext.ts`**

```ts
const pagerFilterSchema = z.object({
	provider: z.string().describe("Provider filter substring; \"\" = any."),
	id_type: z.string().describe("Capcode id-type filter; \"\" = any."),
	channel: z.string().describe("Channel filter; \"\" = any."),
	mode: z.string().describe("Transmission-mode filter; \"\" = any."),
	recipient_id: z.string().describe("Recipient id filter; \"\" = any."),
	message: z.string().describe("Message-text filter substring; \"\" = any."),
});

export const PagerDecoderDataSchema = z.looseObject({
	settings: z
		.looseObject({
			retentionLines: z.number().describe("How many decoded lines to keep on screen."),
			filter: pagerFilterSchema.describe("Column filters applied to the decoded stream."),
		})
		.partial()
		.optional()
		.describe("The Settings window's persisted preferences."),
});

export type PagerDecoderData = z.infer<typeof PagerDecoderDataSchema>;

registerApp({
	id: "PagerDecoder.app",
	description: "Decoded pager traffic from September 11, 2001, streaming to the virtual clock.",
	prefix: "ClassicyAppPagerDecoder",
	handler: classicyPagerDecoderEventHandler,
	actions: {
		ClassicyAppPagerDecoderInitSettings: {
			description: "Seed the settings object, only if none exists yet.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Initial PagerDecoderSettings object."),
			}),
		},
		ClassicyAppPagerDecoderUpdateSettings: {
			description: "Merge a partial settings object over the stored one.",
			params: z.object({
				settings: z.record(z.string(), z.unknown()).describe("Partial PagerDecoderSettings to merge."),
			}),
		},
	},
	state: PagerDecoderDataSchema,
});
```

- [ ] **Step 3: Add the manifest-test rows**

```ts
import "./Applications/News/NewsContext";
import "./Applications/PagerDecoder/PagerDecoderContext";
```

```ts
	["News.app", ["ClassicyAppNews"], ["ClassicyAppNewsFocusItem", "ClassicyAppNewsSetOpenDocuments"], true],
	[
		"PagerDecoder.app",
		["ClassicyAppPagerDecoder"],
		["ClassicyAppPagerDecoderInitSettings", "ClassicyAppPagerDecoderUpdateSettings"],
		true,
	],
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Applications/News src/Applications/PagerDecoder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/News/NewsContext.ts packages/frontend/src/Applications/PagerDecoder/PagerDecoderContext.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): News.app and PagerDecoder.app manifests via registerApp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Migrate the playlist store plugin (PlaylistEditor.app)

`playlistStoreActions.ts` is a store *plugin*, not an app of its own: its `ClassicyAppPlaylistMergeData` handler merges keys into arbitrary apps' data. Register it under the playlist feature's real app id, `"PlaylistEditor.app"` (see `src/Applications/PlaylistEditor/PlaylistEditor.tsx:19`), with **no state schema** — the action writes into *other* apps' slices (whose looseObject schemas pass the merged keys through), and PlaylistEditor itself stores nothing here.

**Files:**
- Modify: `packages/frontend/src/Providers/Playlist/playlistStoreActions.ts` (registration at 24)
- Test: `packages/frontend/src/appManifests.test.ts`

**Interfaces:**
- Consumes: `classicyPlaylistEventHandler` already in the file.
- Produces: nothing new — exports unchanged.

- [ ] **Step 1: Replace the registration**

Imports: swap `registerAppEventHandler` → `registerApp`, add `import { z } from "zod";`.

```ts
registerApp({
	id: "PlaylistEditor.app",
	description: "Author teacher playlists and drive live rooms (jump, focus, message, lock).",
	prefix: "ClassicyAppPlaylist",
	handler: classicyPlaylistEventHandler,
	actions: {
		ClassicyAppPlaylistMergeData: {
			description: "Merge keys into another app's data slice (playlist settings entries).",
			params: z.object({
				appId: z.string().describe("Target app id whose data receives the merge."),
				values: z.record(z.string(), z.unknown()).describe("Keys merged into the target app's data."),
			}),
		},
	},
	// No state schema: this handler writes into OTHER apps' data slices, and
	// PlaylistEditor.app itself persists nothing through this prefix.
});
```

- [ ] **Step 2: Add the manifest-test row (note `hasState: false`)**

```ts
import "./Providers/Playlist/playlistStoreActions";
```

```ts
	["PlaylistEditor.app", ["ClassicyAppPlaylist"], ["ClassicyAppPlaylistMergeData"], false],
```

- [ ] **Step 3: Run tests**

Run: `pnpm --filter @rt911/frontend exec vitest run src/appManifests.test.ts src/Providers/Playlist src/Applications/PlaylistEditor`
Expected: PASS.

- [ ] **Step 4: Confirm no `registerAppEventHandler` remains outside classicy**

Run: `grep -rn "registerAppEventHandler" packages/frontend/src --include="*.ts" --include="*.tsx" | grep -v ".test."`
Expected: no output (test-file stubs may keep the key name; production code must not).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Playlist/playlistStoreActions.ts packages/frontend/src/appManifests.test.ts
git commit -m "feat(frontend): playlist store plugin manifest via registerApp

Completes the registerAppEventHandler -> registerApp migration; no
production call sites of the deprecated API remain.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification sweep

**Files:** none modified (fixes discovered here belong to the task whose schema is wrong — amend that file and note it).

- [ ] **Step 1: Static gates**

```bash
cd /home/robbiebyrd/rt911
pnpm --filter @rt911/frontend exec tsc -b --force   # --force: tsc -b's cache is known to mask errors in this repo
pnpm lint
pnpm test
```
Expected: all PASS.

- [ ] **Step 2: Dev-console schema sweep (handoff §7 — the schemas' real test)**

Use the `packages/frontend:verify` skill (Playwright against `pnpm dev`; check who owns :5173 first — stale classicy example servers squat low ports). Exercise, with the console captured:
1. TV: open, tune a channel, toggle grid, mute, reorder thumbnails, change caption settings.
2. FlightTracker: open, change map style, toggle loop, set a filter, focus a flight from a stack/playlist path if available.
3. TimeMachine: move the clock; open Settings and move all three sliders.
4. Weather, RadioScanner, News, PagerDecoder, Browser, README, Feedback: open each, change one persisted setting each.

Expected: zero `console.warn` mentioning `registerApp` or `failed its manifest schema`. Any warning names the appId + action + zod issues — fix the *schema* to match the reducer's reality (never the reverse), in the owning file from Tasks 3–9.

- [ ] **Step 3: E2E gate (required by CI; red E2E blocks the GHCR push)**

```bash
pnpm --filter @rt911/frontend exec playwright test
```
Expected: PASS.

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add -A packages/frontend/src
git commit -m "fix(frontend): align manifest schemas with reducer reality from dev sweep

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Skip if the sweep was clean.)

---

### Task 11 (optional): Balloon-help exemplar from live metadata

Proves the §6 wiring end-to-end on one surface so later apps have an in-repo reference. TimeMachine's Settings window (three sliders whose state fields now carry `.describe()` text) is the smallest real target.

**Files:**
- Modify: the TimeMachine Settings window component (locate via `grep -rn "skipMinutes" packages/frontend/src/Applications/TimeMachine --include="*.tsx"`)
- Test: co-located component test in the same folder

- [ ] **Step 1: Wrap each slider**

For each of the three sliders, following the handoff's conditional pattern (render the bare control when `describeAppState` returns undefined):

```tsx
import { ClassicyBalloonHelp, describeAppState } from "classicy";

const skipBalloon = describeAppState(TIME_MACHINE_APP_ID, "settings.skipMinutes");
// in JSX:
{skipBalloon ? (
	<ClassicyBalloonHelp title="Skip distance" content={skipBalloon.content}>
		{skipSlider}
	</ClassicyBalloonHelp>
) : (
	skipSlider
)}
```

Supply human titles ("Skip distance", "Step distance", "Scrub distance") — the returned `title` is the raw field name (handoff §6).

- [ ] **Step 2: Component test asserting the balloon content comes from the manifest**

In the Settings window's test file (create it co-located if none exists — remember this repo has no RTL auto-cleanup: new test files need `afterEach(cleanup)`), assert `describeAppState(TIME_MACHINE_APP_ID, "settings.skipMinutes")?.content` matches the schema's describe text and that the wrapped slider renders.

- [ ] **Step 3: Run, verify, commit**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/TimeMachine
git add packages/frontend/src/Applications/TimeMachine
git commit -m "feat(frontend): TimeMachine settings balloons from the app manifest

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12 (deferred — needs a product decision): `scriptable` exposure

Deliberately NOT part of this migration. Today's allowlist is empty, so parity means no `scriptable: true` anywhere. The natural candidates are the documented cross-app remote commands (`ClassicyAppTVTuneChannel`, `ClassicyAppTVSetGrid`, `ClassicyAppRadioScannerTuneStation`, `ClassicyAppNewsFocusItem`, `ClassicyAppFlightRemoteFocus`, `ClassicyAppBrowserNavigate`) — exposing them would let user-authored HyperCard stacks drive the desktop, which is the feature's point, but it widens what untrusted stack scripts can do (Browser navigation especially). When approved: add `scriptable: true` to the chosen entries, update `appManifests.test.ts`'s scriptable-parity test to assert the exact expected list instead of `[]`, and exercise one stack effect end-to-end. **Do not flip any of these on without explicit sign-off.**

---

## Self-Review (performed while writing)

- **Spec coverage:** §2 one-call migration → Tasks 3–9 (all 12 call sites; verified by Task 9 Step 4's grep). §3 multi-module merge → Task 4. §4 scriptable → deliberately deferred (Task 12) at parity, since the allowlist is empty today. §5 parseAppData → deliberately not adopted (Global Constraints — no guards exist; existing readers normalize, which is stronger). §6 balloon help → optional Task 11. §7 kernel validation → Task 10 Step 2 sweep. §8 checklist items all mapped.
- **Placeholder scan:** every schema and registration is concrete code derived from the actual reducers; the only intentionally-loose schemas are `z.record(z.string(), z.unknown())` params for replace-whole-object actions, documented as such.
- **Type consistency:** schema field names checked against each reducer's writes (e.g., TV `overallMuted` not `muted`; RadioScanner `mutedItems` not `mutedChannels`; Flight loop `windowMinutes` vs Weather `windowHours`).
