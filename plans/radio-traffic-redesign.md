---
status: in_progress
approved_at: "2026-08-18T17:22:30.220Z"
updated: "2026-08-18T17:32:07.423Z"
started_at: "2026-08-18T17:32:07.423Z"
---
# Plan: Radio Traffic — Radio Scanner Re-engineering

**Created:** 2026-08-18 | **Status:** Draft | **Effort:** XL | **Branch:** `feat/radio-traffic-redesign`

**Figma:** https://www.figma.com/design/0ThIP36B8Cio7c2dYbSLgY/Radio-Traffic-App?node-id=1-182

## Summary

Replace the Radio Scanner's station-tuner UI with the Figma "Radio Traffic" design: a tag-driven filter-tree sidebar, a modal tool palette, and three lanes (LIVE / UPCOMING / PREVIOUS) of per-clip cards. Each card shows a static peaks waveform with clock-vs-audio drift scrubbers and five metadata tabs (Details, Mentions, Parties, Transcript, Source).

The tabs are powered by data currently locked inside the private `mp3_items.parties` blob. Rather than exposing that blob, this plan **extracts the presentable parts into new public Directus fields** — the same move that produced `mp3_tags` — so redaction happens once at derivation time and `parties` stays private.

## Architecture Context

- **Local `main` is 1167 commits behind `origin/main`.** Every path below refers to `origin/main`. Sync before starting.
- Data flow today: Postgres `mp3_items` → Redis (`mp3:items`/`mp3:by_start`) → Go `Session` windowed pump → msgpack `mp3` (300s forward window) + `mp3_history` (full back-catalogue) frames → `MediaStreamProvider` → `RadioScanner.tsx`.
- **The gap:** everything the five tabs need lives in `mp3_items.parties`, which is private in Directus and absent from `mp3SelectFrom` (`internal/db/postgres.go`), `model.MediaItem` (`internal/model/item.go`), the wire spec, and the frontend `MediaItem`.
- **Schema authority is the infra repo**, not this one. `f93a6fe9`: "The schema is declared in the infra repo and applied by the PreSync hook" (`infra@main:apps/rt911/directus-schema-job.yaml`, a PreSync Job running `schema/apply.py` over `schema/snapshot.json`). `parties`, `tags_curated`, `peaks`, `mp3_tags`, `mp3_items_tags` are all already declared there. **The new fields in Step 1 require an infra PR to that snapshot.**
- **Public read grants live in this repo, in two hand-synced places** (documented in `apply-hypercard-public-perms.mjs`): `seed.mjs`'s `ensurePublicReadAccess()` for fresh installs, and `apply-hypercard-public-perms.mjs` to converge an already-seeded production. Grants are explicit field lists filtered to `approved = 1`, never `["*"]`. Its header warns: "any new field a frontend reader asks for must be added here" — requesting an ungranted field is itself a 403.
- **`Applications/RadioScanner/` is not just an app — it is the shared radio library**, which is why Step 8 extracts it to `radio-core/` before anything is deleted. Six places outside it import from it today: `Applications/RadioTuner` (4 files), `Applications/PlaylistEditor` (3), `Mobile/screens` (4), `Mobile/IpodShell.tsx`, `Providers/Playlist` (2), and `Desktop.tsx`. By import count: `stationGrouping` ×10, `radioScannerSettings` ×4, `StationPlayer`/`stationLogos`/`audioBlocked` ×2 each, then `radioPlayback`, `StationButtonContent`, `RadioSettingsWindow`, `RadioScannerContext`, `RadioScanner`, `RadioScanner.module.scss` ×1.
- Key files: `stationGrouping.ts` (time-window predicates — reuse as-is; **10 consumers, do not change its exports**), `StationPlayer.tsx` (drift correction, seek-on-jump — shared with RadioTuner), `audioCapture.ts`/`audioSource.ts`/`audioBlocked.ts` (playback engine — keep), `WaveformVisualizer.tsx` (live AnalyserNode — cannot draw a whole file, superseded for cards).
- **The Radio app is mounted in `Desktop.tsx:42`, not `app.tsx`** — and `RadioScannerContext.ts` exports `radioTuneStation`, which `Providers/Playlist/PlaylistProvider.tsx:28` uses to tune the radio from a playlist. Both are easy to miss when deleting the shell.
- `seed.mjs:500-516` `TAG_INDEX_SQL` is dead code: it indexes `(tags::text)`/`(tags::jsonb)`, but `tags` became a `list-m2m` alias in `f93a6fe9`. Remove.
- **The streamer already has a real HTTP surface** alongside `/stream`: stdlib `http.NewServeMux` in `cmd/server/main.go:325-352`, one `func New*Handler(deps…, logger) http.HandlerFunc` per file in `internal/handler/`. Existing routes: `/stream`, `/chat/username-available`, `/feedback`, `/clock`, `/alert`, `/room`, `/health`, `/ready`. The metadata API is an additive fourth read route on that same mux — no new server, no new framework.

## Research Findings

- Tag namespaces (`parties/tags.py`) are exactly the sidebar's groups: `topic:`, `facility:`, `link:`, `tier:`, `aircraft:`, `agency:`, `role:`, `person:` — 8, confirmed against the live vocabulary.
- `mp3_tags` columns: `id, tag, namespace, value, color, sort`. `color`/`sort` are curator-settable but **unset on every row today** — the chip palette must key off `namespace`.
- `parties` blob (schema_version 2): `tier`, `link`, `participants[]{facility,position,person,role,confidence,source}`, `aircraft[]`, `mentions{facilities,aircraft,people}`, `subject`, `topics[]`, `confidence`, `evidence`, `sources{}`, `gate_reasons[]`, `commission{}`, `model`, `generated_at`.
- **Tags conflate participants with mentions.** `tags.py` emits `facility:` for both participant facilities *and* `mentions.facilities`, so a tag cannot tell you whether a facility was on the call or merely talked about. The Mentions and Parties tabs need that distinction — hence structured `participants`/`mentions` fields, not tags.
- `topics[]` has no such conflation (a topic is only ever what a call is *about*) and is a closed 25-value vocabulary already fully represented by the `topic:` namespace. **The Mentions tab's topics column reads from tags** — no `topics` field needed.
- `rebuild_tags_flow` (`parties/flows.py:176-215`) is the exact template for Step 1: re-derives from stored `parties`, reads no transcripts, calls no model, `dry_run=True` default, paged via `_page_mp3_items`.
- Tab → data mapping: **Details** = start/end/duration + `link` + tag chips + `subject`. **Mentions** = `mentions.{facilities,aircraft,people}` + `topic:` tags (4 columns). **Parties** = `participants[]` (person, facility, role, confidence badge). **Transcript** = the `.srt`/`.vtt` at `subtitles` (already on the wire). **Source** = `provenance`.
- Card badge states from the mock: `•` (in sync), `SEEKING`, `-6 seconds` (drift), `4s`/`03:13` (countdown), `PLAYING`.
- Card carries **two** scrubbers: `Live Scrubber Position` (where the virtual clock says we should be) and `Current Scrubber Position` (where the audio element actually is). The drift between them is the `-6 seconds` badge.
- Geometry (892×601 window): sidebar 141w (Toolbar 141×26 at y=20, tree below); lanes at x=144; LIVE 747×281, UPCOMING 747×150, PREVIOUS 678×124. Card 210×124: Header 196×19, Waveform 206×27 @y=29, Control Bar 206×14 @y=56, Tabs 207×53 @y=70 (bar 11px, panel 206×39). Expand/collapse buttons exist on UPCOMING and PREVIOUS only — **LIVE cannot be collapsed**.
- **`PeaksWaveform.tsx` already exists** at `Applications/PlaylistEditor/PeaksWaveform.tsx` — `{peaks: number[][], height: number}`, static canvas draw, `ResizeObserver` redraw, `-128..127` scaling, and a header comment stating it is deliberately *not* an extension of `WaveformVisualizer`. Alongside it: `usePeaksForSpan.ts`. **Step 11 extracts and extends this component; it does not write a new one.** Both halves of `plans/2026-08-17-timeline-lane-preview-plan.md` Phase 3 have therefore shipped.
- Two `NowPlayingList.tsx` files exist (`RadioScanner/`, `RadioTuner/`). RadioTuner's import of its own copy is commented out at `RadioTuner.tsx:28` — that file is currently dead code.
- **Correction to the brief:** PREVIOUS is `end <= now`, not "end greater than current time". Existing `previousSegments` already encodes it correctly; keep that predicate.
- Existing predicates transfer unchanged: LIVE `start ≤ now < effectiveEnd`, UPCOMING `start > now`, PREVIOUS `end !== null && end <= now`.
- Handler conventions (`internal/handler/username.go`): method check → origin check (**only where identity is involved**) → package-level `rate.NewLimiter` global bucket → validate → query → `writeJSON`. `golang.org/x/time/rate` is already a direct dep.
- `writeJSON` (`username.go:99-105`) hardcodes `Cache-Control: no-store` — correct there, wrong for immutable metadata. Needs a sibling helper, **not** a modification: changing it in place would silently make username answers cacheable.
- **No CORS handling exists anywhere in the Go backend** — zero hits for `Access-Control`/`cors`. It is all Traefik middleware at the ingress; see the verified section below.
- `OriginAllowlist.Trusted` gates **identity, never the connection** — "an untrusted origin still streams media, flights, and every other channel anonymously." Public metadata therefore gets no origin gate, matching the anonymous mp3 channel it mirrors.
- Go 1.25: `ServeMux` supports method+wildcard patterns (`GET /mp3/meta/{id}` + `r.PathValue("id")`). Existing routes predate this and use bare paths with manual method checks.
- No ETag or positive `Cache-Control` precedent exists in the backend — conditional-GET support is net-new.

### Verified against the live cluster and the infra repo (2026-08-18)

Counts from `rt911-db` (`psql -U directus -d directus`), schema from `infra@main:apps/rt911/schema/snapshot.json`:

| Fact | Value | Consequence |
|---|---|---|
| `mp3_items` total | **814** | — |
| with `parties` | **755 (93%)** | 59 items have no parties — cards must degrade to `title` + Transcript only |
| with `peaks` | **814 (100%)** | **the peaks pipeline is already done** — no extraction, no flow, no backfill |
| with `subtitles` | **814 (100%)** | Transcript tab works for every item |
| `mp3_tags` rows | **1131**, 8 namespaces | — |
| `mp3_items_tags` rows | **8192** | — |
| `mp3_tags.color` set | **0 rows** | chips **cannot** use `color`; a namespace palette is the only source |

- Peaks format verified on a live row: **480 buckets of `[min,max]`**, e.g. `[-3,3][-12,10][-54,70]` — exactly the shape `PeaksWaveform` expects. No peaks code exists on `origin/main`; the data was produced out of band. Consume it, don't rebuild it.
- Namespace cardinality: `aircraft` 377, `facility` 372, `person` 339, `topic` 25, `role` 6, `agency` 5, `link` 5, `tier` 2. The mock shows ~6 per group and never faced this: the big three get a **searchable multi-select window** (Step 10); the five small ones render inline.
- `mp3_tags.namespace` is **NOT NULL** in the schema — there is no un-namespaced/curated bucket to render. Group by `namespace` unconditionally; no "Other" group.
- `mp3_tags.color` and `.sort` **do exist** (`character varying`, `integer`) but are absent from the public Directus grant. The backend reads Postgres directly, so the Step 1 LATERAL join can select them regardless.
- **`mp3_items.parties` returns `403 FORBIDDEN`** to anonymous readers today and **stays that way** under this plan. Only the derived projection from Step 1 becomes public.
- **CORS is Traefik middleware `streamer-cors`** (`infra@main:apps/rt911/streamer.yaml:255-296`) bound to the ingress at `path: /`, `pathType: Prefix` — it covers the **whole** streamer host, so new `/mp3/*` routes are covered automatically. Verified live against `stream.911realtime.org`.
- **But the preflight allows only `Content-Type`** and sets no `access-control-expose-headers`. Verified live: an `OPTIONS` with `Access-Control-Request-Headers: if-none-match` comes back with `access-control-allow-headers: Content-Type`. So JS may **not** set `If-None-Match` and may **not** read `ETag`. See Step 6.

## Security Considerations

- **Redaction happens once, at derivation (Step 1).** `gate_reasons` and `model` are never copied into the public fields, so no downstream layer can leak them, the Go code has nothing to strip, and the two transports cannot drift. `parties` itself stays private in Directus.
- `evidence` is a verbatim transcript quote — already public via the `.srt` files, so copying it into a public field is not a new exposure.
- The public grant is an **explicit field list filtered to `approved = 1`**, matching the existing script's rule. Never `["*"]`; `parties`, `tags_curated` and `gate_reasons` stay out of it.
- No new auth surface: the mp3 channel is already anonymous and read-only. No client input is added except tag-filter selections, which never leave the browser.
- Peaks are derived audio envelopes of already-public files — no new exposure.
- The HTTP metadata routes are **unauthenticated and un-origin-gated by design** — they serve the same public reference data as the anonymous mp3 channel, and `OriginAllowlist` gates identity, not access. They must therefore read no cookie and call no `LookupSessionUser`.
- HTTP makes the corpus trivially scrapable in one request where the WS path required a session. That is acceptable for public 9/11 archival metadata, but the endpoints still get a global rate limiter to keep a scripted client from pinning the box.

## Performance Considerations

- **`mp3_history` is the hazard.** It carries the *entire* back-catalogue (~755 items) and is re-sent wholesale on every subscribe/init/**seek**. At ~2KB of `parties` + tags per item that is ~1.5MB of msgpack per Time Machine scrub. Do **not** inline parties/tags into `mp3`/`mp3_history` frames.
- Mitigation: a dedicated `mp3_meta` frame sent **once per subscription** carrying an id-keyed metadata map. This is immutable historical reference data — no reveal-gating, no retention-pruning, no re-send on seek. The tag vocabulary is **not** in this frame (Decision 2); it comes from `GET /mp3/tags`, browser-cached, so the sidebar paints without waiting on the socket.
- Peaks: 480 buckets × 2 int8 ≈ 2KB/item regardless of duration; ships in the same one-shot `mp3_meta` frame.
- Card grid renders ~10 cards. Static canvas peaks draw once per resize — unlike `WaveformVisualizer`, no `rAF` loop, no `AudioContext` per card. Concurrent `<audio>` stays bounded because only one LIVE player is unmuted by default.
- `mp3SelectFrom` gains a LATERAL tag aggregate; it runs on cache warm only, not per tick.
- HTTP metadata routes serve from the **already-warm Redis mp3 cache**, never Postgres — no new DB load.
- **Correction (second opinion, verified):** `NOTIFY` does **not** keep them fresh for free. `mp3_listen.go:38-43` installs its trigger on `mp3_items` **only** (`AFTER INSERT OR UPDATE OR DELETE ON mp3_items`, channel `mp3_items_changed`); there is no trigger or listener on `mp3_tags`/`mp3_items_tags` anywhere in the backend. So `derive-public-meta` (which PATCHes `mp3_items`) *does* invalidate, but `sync_item_tags`/`rebuild_tags_flow` — which only touch junction rows — **do not**, leaving the vocabulary and per-item tags stale indefinitely. See Step 5.
- `GET /mp3/meta` is the same ~1.5MB payload as the `mp3_meta` frame. It gets an ETag computed once per cache warm (not per request) plus `public, max-age=300, stale-while-revalidate=86400`, so repeat callers cost a 304. `GET /mp3/tags` exists precisely so the filter tree can avoid the 1.5MB when it only needs ~50KB of vocabulary.
- Serialize the meta payload once per cache generation and hold the bytes, rather than re-encoding JSON per request.

## Decisions (settled 2026-08-18)

1. **Toolbar is [Arrow = solo] [Mute] [Unmute] [Hand = reorder].** Ship neutral placeholder glyphs — Robbie will replace the artwork.
2. **The tag vocabulary is HTTP-only.** The app reads `GET /mp3/tags`; the `mp3_meta` frame carries per-item metadata *only*. One source, smallest frame, and the sidebar renders from the browser cache without waiting on the socket. Accepted trade: the filter tree now depends on the streamer's HTTP side, not just its socket.
3. **Sidebar renders 8 sibling namespace groups**, driven by `mp3_tags.namespace`, so `topic:` keeps a filter control.
4. **The station-strip tuner is removed from RadioScanner but must not affect RadioTuner.** RadioTuner is a separate app importing nine modules from `RadioScanner/` — Step 8 extracts them first, Step 20 deletes only the shell.
5. **Vocabulary failure is stale-but-usable, not empty.** `GET /mp3/tags` failures fall back to the last-known-good copy in app state, flagged `stale`. Keeps Decision 2 intact; an empty filter tree would be feature loss, since tag filtering is the primary navigation.
6. **Playback is owned by a central coordinator, not by cards** (Step 16). Cards mount and unmount on filter, reorder and lane migration; if `<audio>` lifetime followed component lifetime, clock sync would be probabilistic. Cards are views over a registry keyed by item id.
7. **The shared modules move to `radio-core/` before any deletion** (Step 8). Overrides the earlier "keep the directory name" default: leaving the shared library inside a directory named after a deleted app invites a future dead-code pass to break RadioTuner, PlaylistEditor and Mobile.
8. **Tags and the public projection are re-derived by one flow** (`rederive-mp3-metadata`), superseding `rebuild_tags_flow`. Both are pure functions of `parties`; separate rebuild paths let the Parties tab and the tag filters disagree about the same recording.

## Open Questions

None. Decisions 1-8 are settled; the four raised by the second opinion were resolved 2026-08-18.

## Prerequisites

- `git fetch origin && git checkout -b feat/radio-traffic-redesign origin/main` — do **not** branch from local `main`.

**Rollout order is a hard sequence, not a checklist.** `Mp3Metadata` selects columns that do not exist yet; if the backend image ships before the schema is applied, the query errors and the mp3 channel goes down in production. ArgoCD runs `automated.selfHeal: true`, so there is no imperative rollback window — the fix is to land in this order and verify each gate:

1. Infra PR adds the Step 1 fields to `infra@main:apps/rt911/schema/snapshot.json`; the PreSync Job applies them.
2. **Verify the columns exist in production Postgres** before merging any backend change:
   `kubectl exec -n rt911 <rt911-db-pod> -- psql -U directus -d directus -c "\d mp3_items"`
3. `rederive-mp3-metadata` with `dry_run=False` — populates the public fields on 755 rows and rebuilds their tags in the same pass.
4. `apply-hypercard-public-perms.mjs --apply` — opens the public grant.
5. Merge the backend + frontend PR (they ship together; the wire change requires it).

Steps 1-2 of the plan cannot land before rollout gate 1.

## Steps

### Step 1: derive public metadata fields from `parties`
- **Test:** `packages/tools/video-grabber/tests/test_public_meta.py` — `build_public_meta` copies `subject`/`link`/`tier`/`confidence`/`evidence`; projects `participants[]` to `{person,facility,position,role,confidence}`; copies `mentions.{facilities,aircraft,people}`; builds `provenance` from `sources`/`commission`/`generated_at`; **omits `gate_reasons` and `model` entirely**; returns all-empty for `None`.
- **Implement:** `packages/tools/video-grabber/video_grabber/parties/public_meta.py` (pure) + a `derive-public-meta` flow in `parties/flows.py`.
- **Code:**
```python
REDACTED = {"gate_reasons", "model"}  # QA signals — never leave the pipeline

def build_public_meta(parties: dict | None) -> dict:
    """The presentable projection of `parties`. Redaction happens here, once."""
    p = parties or {}
    return {
        "subject": p.get("subject"),
        "link": p.get("link"),
        "tier": p.get("tier"),
        "confidence": p.get("confidence"),
        "evidence": p.get("evidence"),
        "participants": [
            {k: q.get(k) for k in ("person", "facility", "position", "role", "confidence")}
            for q in p.get("participants") or []
        ],
        "mentions": {k: (p.get("mentions") or {}).get(k) or []
                     for k in ("facilities", "aircraft", "people")},
        # Enumerated, not subtree-copied. `{k: p.get(k) for k in (...)}` over
        # "commission"/"sources" would publish whatever future keys a producer
        # adds under them — the redaction boundary is only as strong as the
        # public schema is closed.
        "provenance": {
            "generated_at": p.get("generated_at"),
            "sources": {k: v for k, v in (p.get("sources") or {}).items()
                        if k in PUBLIC_SOURCE_PATHS},
            "commission": {k: (p.get("commission") or {}).get(k)
                           for k in ("title", "source", "stamp")},
        },
    }
```
```python
@flow(name="rederive-mp3-metadata")
def rederive_mp3_metadata_flow(limit: int | None = None, dry_run: bool = True) -> None:
    """Re-derive tags AND the public projection from the `parties` each row
    already carries. Reads no transcripts, calls no model.

    One flow, not two, because both are pure functions of the same source and
    a change to either derivation makes the other's output stale (this is why
    rebuild_tags_flow exists at all). Splitting them lets the Parties tab and
    the tag filters disagree about the same recording — the UI would show a
    participant that its own facility filter cannot find.
    """
    vocab = {} if dry_run else load_vocabulary(cfg)
    for row in _page_mp3_items(cfg, "id,parties,tags_curated"):
        parties = row.get("parties")
        meta = build_public_meta(parties)
        meta["derived_at"] = DERIVATION_VERSION   # bump when either rule changes
        records = build_tag_records(parties, row.get("tags_curated") or [])
        if not dry_run:
            patch_item(cfg, row["id"], meta)          # fires mp3_items_changed
            sync_item_tags(cfg, row["id"], records, vocab)
```
- **Constraint (security):** `REDACTED` is the single redaction point in the whole system. A test must assert both keys are absent from the output.
- **Constraint (security — second opinion):** a deny-list is not enough; the projection must be a **closed allow-list**. `identify_parties_flow` writes `model`, `generated_at`, `commission` and `gate_reasons` into `parties` (`parties/flows.py:136-147`), and nothing stops a future producer adding more. Test with a `parties` blob containing an unknown key at top level **and** nested under `commission`/`sources`: neither may appear in the output.
- **Constraint:** `dry_run` defaults True, matching every other video-grabber flow.
- **Constraint:** 59 of 814 rows have no `parties` — they must produce empty fields, not an error.
- **Constraint (Decision 8):** this flow **supersedes** `rebuild_tags_flow` rather than sitting beside it. Derived data with two independent rebuild paths drifts; `derived_at` records which derivation version produced a row, so a stale row is detectable rather than merely suspected.
- **Constraint (ordering):** patch `mp3_items` **before** `sync_item_tags`, so the `mp3_items_changed` NOTIFY that invalidates the cache fires after both writes land (Step 5 extends that trigger to the junction tables).
- **Validation:** `cd packages/tools/video-grabber && pytest tests/test_public_meta.py -v && ruff check video_grabber/parties/`

### Step 2: public read grants for the new fields
- **Test:** `packages/backend/apply-hypercard-public-perms.test.mjs` — the mp3_items grant field list contains every new field; a dry run against a grant missing one reports drift and exits 1; the `approved = 1` item filter is preserved; `parties` and `tags_curated` are absent from the list.
- **Implement:** add the new fields to the mp3_items field list in **both** `apply-hypercard-public-perms.mjs` and `seed.mjs`'s `ensurePublicReadAccess()`.
- **Code:**
```js
// Kept in sync by hand with seed.mjs — Dockerfile.seed bakes only seed.mjs,
// so a shared module would break the seed image.
const MP3_PUBLIC_FIELDS = [
  /* …existing… */
  "subject", "link", "tier", "confidence", "evidence",
  "participants", "mentions", "provenance", "peaks",
];
```
- **Constraint (security):** explicit list, never `["*"]`; keep the `approved = 1` filter. `parties`, `tags_curated` and anything carrying `gate_reasons` stay out.
- **Depends on:** Step 1
- **Validation:** `node apply-hypercard-public-perms.mjs` (dry run — exits 1 until applied)

### Step 3: standalone metadata and vocabulary queries
- **Test:** `packages/backend/internal/db/postgres_test.go` — `Mp3Metadata` returns a map keyed by item id with metadata + `Tags` populated; an item with no junction rows yields an empty (non-nil) tag slice; an item with no `parties`-derived fields still appears with zero values. `Mp3TagVocabulary` returns **all** `mp3_tags` rows including ones attached to no item, ordered by `sort NULLS LAST, tag`. **`mp3SelectFrom` and `model.MediaItem` are byte-for-byte unchanged** — assert the existing mp3 query tests still pass untouched.
- **Implement:** `packages/backend/internal/db/postgres.go` — two **new** functions with their own scanners.
- **Code:**
```go
// Deliberately NOT part of mp3SelectFrom. That constant feeds AllMp3Items,
// Mp3ItemByID, CurrentMp3Items and Mp3ItemHistory, all of which scan through
// the generic queryItems() whose rows.Scan is a fixed 20-column positional
// list shared with the news/media/pager selects — widening it breaks every
// other caller. Worse, those four return []model.MediaItem, which is exactly
// what SendMp3/SendMp3History msgpack onto the wire: growing MediaItem would
// put ~2KB of metadata on every mp3 and mp3_history frame, which is the cost
// this plan's whole mp3_meta design exists to avoid.
func Mp3Metadata(ctx context.Context, pool *pgxpool.Pool) (map[int]model.ItemMeta, error)
func Mp3TagVocabulary(ctx context.Context, pool *pgxpool.Pool) ([]model.Tag, error)
```
```sql
-- Mp3Metadata: id-keyed, approved only, one row per item.
SELECT mi.id, mi.subject, mi.link, mi.tier, mi.confidence, mi.evidence,
       mi.participants, mi.mentions, mi.provenance, mi.peaks,
       COALESCE(tg.tags, '[]'::json)
FROM mp3_items mi
LEFT JOIN LATERAL (
  SELECT json_agg(json_build_object(
    'tag', t.tag, 'namespace', t.namespace, 'value', t.value, 'color', t.color
  ) ORDER BY t.sort NULLS LAST, t.tag) AS tags
  FROM mp3_items_tags j JOIN mp3_tags t ON t.id = j.mp3_tags_id
  WHERE j.mp3_items_id = mi.id
) tg ON true
WHERE mi.approved = 1;

-- Mp3TagVocabulary: the full 1131-row vocabulary. NOT derivable by deduping
-- the per-item aggregate above — that would silently drop any tag not
-- currently attached to an approved item.
SELECT id, tag, namespace, value, color, sort
FROM mp3_tags ORDER BY sort NULLS LAST, tag;
```
- **Constraint (security):** never select `parties` — the redacted projection is the only thing that leaves the database.
- **Constraint:** `mp3_items.approved = 1` mirrors the existing mp3 queries and the public Directus grant, so REST and the streamer agree on what exists.
- **Depends on:** Step 1
- **Validation:** `cd packages/backend && go test ./internal/db/...`

### Step 4: ItemMeta carries metadata, tags and peaks over msgpack
- **Test:** `packages/backend/internal/model/item_test.go` — round-trip through msgpack with `SetCustomStructTag("json")`; assert every metadata field, `tags` and `peaks` survive; assert the struct has **no field capable of carrying `gate_reasons` or `model`** (redaction is structural, not a runtime filter).
- **Implement:** `packages/backend/internal/model/item.go`.
- **Code:**
```go
type Tag struct {
	Tag       string  `json:"tag"`
	Namespace string  `json:"namespace"`   // NOT NULL in the schema
	Value     string  `json:"value"`
	Color     *string `json:"color,omitempty"`
}

type Participant struct {
	Person     string `json:"person,omitempty"`
	Facility   string `json:"facility,omitempty"`
	Position   string `json:"position,omitempty"`
	Role       string `json:"role,omitempty"`
	Confidence string `json:"confidence,omitempty"`
}

// Mirrors the public Directus fields one-for-one. Two deliberate absences:
// there is no Parties type (the blob never reaches this layer), and ItemMeta
// is NOT embedded in MediaItem — it travels on its own frame, keyed by id.
type ItemMeta struct {
	Subject      string        `json:"subject,omitempty"`
	Link         string        `json:"link,omitempty"`
	Tier         string        `json:"tier,omitempty"`
	Confidence   string        `json:"confidence,omitempty"`
	Evidence     string        `json:"evidence,omitempty"`
	Participants []Participant `json:"participants,omitempty"`
	Mentions     *Mentions     `json:"mentions,omitempty"`
	// Typed, not `any`: a generic JSON passthrough would re-open the
	// redaction boundary Step 1 closed.
	Provenance   *Provenance   `json:"provenance,omitempty"`
	Tags         []Tag         `json:"tags,omitempty"`
	Peaks        [][2]int8     `json:"peaks,omitempty"`
}
```
- **Constraint:** msgpack keys come from `json` tags (backend CLAUDE.md hard rule #8) — never rename a tag without updating the frontend in the same PR.
- **Constraint (perf, load-bearing):** **do not add any of these fields to `model.MediaItem`.** `CurrentMp3Items`/`Mp3ItemHistory` return `[]model.MediaItem` straight into `SendMp3`/`SendMp3History` (`session.go:385,396`), so a field on `MediaItem` is a field on every `mp3` and `mp3_history` frame — ~1.5MB per seek. `ItemMeta` is a separate type on a separate frame for exactly this reason.
- **Depends on:** Step 3
- **Validation:** `go test ./internal/model/...`

### Step 5: one-shot `mp3_meta` frame carries per-item metadata
- **Test:** `packages/backend/internal/session/session_test.go` — subscribing to `mp3` emits exactly one `mp3_meta` frame; a subsequent `seek` re-emits `mp3`/`mp3_history` but **not** `mp3_meta`; `mp3` frames contain no metadata keys; **the frame carries no `vocabulary` field** (Decision 2).
- **Implement:** `packages/backend/internal/session/session.go`, `internal/cache/mp3.go`.
- **Code:**
```go
// Per-item metadata only. The tag vocabulary is served by GET /mp3/tags —
// it is the same for every session, so pushing it down each socket is waste.
type Mp3MetaMessage struct {
	Type  string                 `json:"type"`  // "mp3_meta"
	Items map[int]model.ItemMeta `json:"items"`
}
```
```go
// cache/mp3.go today holds only item-keyed structures (keyMp3Items HASH,
// keyMp3ByStart ZSET). Metadata and vocabulary are whole-corpus, not
// time-sliced, so they get their own keys, built once on warm and rebuilt on
// the existing mp3_items_changed NOTIFY.
const (
	keyMp3Meta  = "mp3:meta"       // STRING — msgpack map[id]ItemMeta
	keyMp3Vocab = "mp3:vocab"      // STRING — msgpack []Tag
	keyMp3Etag  = "mp3:meta:etag"  // STRING — content hash, computed on warm
)
```
- **Constraint (perf):** this is the whole point — keeps ~1.5MB of immutable metadata off every seek. `mp3`/`mp3_history` frames stay exactly as they are today.
- **Constraint:** the assembler that builds `map[int]model.ItemMeta` from `db.Mp3Metadata` lives in `cache/mp3.go` and is shared verbatim with Step 6's HTTP handlers — one producer, two transports.
- **Constraint (correctness — verified gap):** the existing `mp3_items_changed` trigger does **not** fire on `mp3_tags`/`mp3_items_tags` writes, so a tag rebuild leaves this snapshot stale forever. Extend `InstallMp3Triggers` to install the same trigger function on both tag tables (they can share the `mp3_items_changed` channel — the handler already resyncs wholesale), **or** rebuild the snapshot on a timer. Add a test: a junction-row write invalidates the metadata snapshot.
- **Constraint (consistency):** stamp a single `generation` (the cache-build id) into both the `mp3_meta` frame and `GET /mp3/tags`. A client holding vocabulary from generation N and item tags from N+1 can show tags on cards that its own filter tree cannot offer. The client compares and refetches on mismatch.
- **Constraint (security):** nothing to strip — `ItemMeta` structurally cannot carry `gate_reasons`/`model` (Step 1 redacted them at derivation).
- **Depends on:** Step 4
- **Validation:** `go test ./internal/session/... ./internal/cache/...`

### Step 6: mp3 metadata HTTP API
- **Test:** `packages/backend/internal/handler/mp3meta_test.go` — `GET /mp3/tags` returns the vocabulary; `GET /mp3/meta` returns vocabulary + items; `GET /mp3/meta/{id}` returns one item and 404s on an unknown id; a non-GET returns 405; a matching `If-None-Match` returns 304 with an empty body; responses carry a positive `Cache-Control` (**not** `no-store`); `gate_reasons`/`model` are absent from every response; no handler reads a cookie.
- **Implement:** `packages/backend/internal/handler/mp3meta.go`, registered in `cmd/server/main.go`.
- **Code:**
```go
// Public reference data: no auth, no origin gate. OriginAllowlist gates
// identity, not access, and this is the same corpus the anonymous mp3
// channel already streams.
var mp3MetaLimiter = rate.NewLimiter(10, 20)

func NewMp3MetaHandler(c *cache.Mp3Cache, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
		if !mp3MetaLimiter.Allow() { http.Error(w, "slow down", http.StatusTooManyRequests); return }
		body, etag := c.MetaSnapshot()          // bytes + ETag, built once per cache generation
		if r.Header.Get("If-None-Match") == etag { w.WriteHeader(http.StatusNotModified); return }
		writeCachedJSON(w, etag, body)
	}
}

// Sibling of writeJSON, which hardcodes no-store. Do not modify that one:
// making username answers cacheable is exactly the bug it guards against.
func writeCachedJSON(w http.ResponseWriter, etag string, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
```
```go
mux.HandleFunc("GET /mp3/tags", handler.NewMp3TagsHandler(mp3Cache, logger))
mux.HandleFunc("GET /mp3/meta", handler.NewMp3MetaHandler(mp3Cache, logger))
mux.HandleFunc("GET /mp3/meta/{id}", handler.NewMp3MetaItemHandler(mp3Cache, logger))  // r.PathValue("id")
```
- **Constraint (security):** nothing to strip here — `ItemMeta` structurally cannot carry `gate_reasons`/`model` (Step 1 redacted them at derivation). Reuse Step 5's assembler rather than building a second one.
- **Constraint (perf):** serve from the Redis mp3 cache, never Postgres; build bytes + ETag once per cache generation, not per request.
- **Constraint (style):** these three use Go 1.22+ method patterns because `{id}` requires them; the older bare-path routes above them are left alone.
- **Constraint (CORS — verified live):** Traefik middleware `streamer-cors` covers the whole host at `path: /`, so these routes are reachable with no infra change. But its preflight allows only `Content-Type` and exposes no headers, so **browser JS must not set `If-None-Match` and cannot read `ETag`**. Rely on the browser's own HTTP-cache revalidation, which is unaffected. Hand-rolled conditional GET from `fetch()` would require adding `If-None-Match` to `accessControlAllowHeaders` and `ETag` to `accessControlExposeHeaders` in `infra@main:apps/rt911/streamer.yaml` — out of scope here.
- **Depends on:** Steps 3, 4, 5
- **Validation:** `cd packages/backend && go test ./internal/handler/...`

### Step 7: frontend consumes mp3_meta
- **Test:** `MediaStreamProvider.test.tsx` — an `mp3_meta` frame populates `mp3Meta` keyed by item id; a later `seek` leaves it intact; an id with no metadata yields `undefined`, never a throw. Separately `tagVocabulary.test.ts` — `fetchTagVocabulary` never rejects; on any failure (non-ok, throw, missing field) it returns the **cached copy marked `stale: true`**, and only `[]` when there is no cache at all; it is fetched once per page load through a shared promise; a `generation` mismatch against the `mp3_meta` frame triggers exactly one refetch, not a loop.
- **Implement:** `MediaStreamContext.ts` (types + context members), `MediaStreamProvider.tsx` (frame handling), and a new `RadioTraffic/tagVocabulary.ts` for the HTTP read.
- **Code:**
```ts
// Vocabulary comes over HTTP, not the socket (Decision 2). Modelled on
// stationLogos.ts: one shared in-flight promise, never rejects.
//
// On failure it falls back to the last-known-good copy in app state rather
// than [] (Decision 5). An empty sidebar is not graceful degradation here —
// tag filtering IS the navigation, so an empty tree is closer to feature loss
// than to a cosmetic gap. Stale-but-usable beats empty.
export async function fetchTagVocabulary(
	cached: CachedVocabulary | null, f = fetch,
): Promise<{ vocabulary: TagDef[]; generation: string | null; stale: boolean }> {
	try {
		const res = await f(`${STREAM_HTTP_BASE}/mp3/tags`);
		if (!res.ok) throw new Error(String(res.status));
		const body = await res.json();
		return { vocabulary: body.vocabulary ?? [], generation: body.generation, stale: false };
	} catch {
		return cached
			? { ...cached, stale: true }
			: { vocabulary: [], generation: null, stale: true };
	}
}
```
```ts
export interface ItemMeta {
	subject?: string; link?: string; tier?: string; confidence?: string; evidence?: string;
	participants?: Participant[];
	mentions?: { facilities: string[]; aircraft: string[]; people: string[] };
	provenance?: unknown;
	tags?: TagDef[];
	peaks?: [number, number][];
}
```
- **Constraint:** metadata is exempt from reveal-gating and retention pruning — it is not time-scoped.
- **Constraint:** `STREAM_HTTP_BASE` already exists as `chatHttpBase(STREAM_URL)` in `lib/endpoints.ts` — reuse it, do not add a new `VITE_` variable (each one needs a Dockerfile `ARG`/`ENV` and a workflow build-arg, and a missing declaration shows up only as production silently using a default).
- **Constraint (CORS):** `GET /mp3/tags` is a simple cross-origin GET, already covered by `streamer-cors`. Do not set request headers on it — the preflight allows only `Content-Type`.
- **Depends on:** Steps 5, 6
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/`

### Step 8: extract `radio-core/` from `RadioScanner/`
- **Test:** no new behavioural test — this is a pure move. The proof is that **every existing suite passes untouched**: `RadioTuner`, `PlaylistEditor`, `Mobile/screens`, `Providers/Playlist`, `appManifests.test.ts`, and RadioScanner's own co-located tests. Add one guard test asserting `radio-core` imports nothing from `Applications/`, so the dependency can never invert.
- **Implement:** move the shared modules to `packages/frontend/src/Applications/radio-core/` (or `src/radio-core/`) and rewrite consumer imports. **No logic changes in this step** — a move-only diff is reviewable; a move-plus-edit diff is not.
- **Code:**
```
radio-core/          moved from RadioScanner/, imported by 6 places
  stationGrouping.ts        ×10 consumers — the widest
  radioScannerSettings.ts   ×4      StationPlayer.tsx        ×2
  stationLogos.ts           ×2      audioBlocked.ts          ×2
  radioPlayback.ts          ×1      StationButtonContent.tsx ×1
  RadioSettingsWindow.tsx   ×1      radio.module.scss        ×1 (was RadioScanner.module.scss)
  audioCapture.ts  audioSource.ts  audioContextKeepAlive.ts
  CaptionOverlay.tsx  WaveformVisualizer.tsx  FocusedItemPlayer.tsx
  RadioProgressBar.tsx  marquee.ts  useHorizontalOverflow.ts
```
- **Constraint:** `radioScannerSettings.ts` keeps its exported type names in this step even though the file moves — renaming symbols and moving files in one commit makes the diff unreviewable. Rename separately if at all.
- **Constraint:** consumers to update — `Applications/RadioTuner` (4 files), `Applications/PlaylistEditor` (3), `Mobile/screens` (4), `Mobile/IpodShell.tsx`, `Providers/Playlist` (2), `Desktop.tsx`, `appManifests.test.ts`.
- **Constraint:** doing this *before* the new app is written means Steps 9-19 import from `radio-core/` from the start, and Step 20's deletion is then genuinely just RadioScanner's shell.
- **Depends on:** none — land it first, independently, so a regression here is isolated from the feature.
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run && pnpm --filter @rt911/frontend exec tsc -b`

### Step 9: card classification and badge state
- **Test:** `packages/frontend/src/Applications/RadioTraffic/cardStatus.test.ts` — lane assignment across before/during/after/open-ended/no-end-date; badge resolves to `•` when |drift| ≤ 1s, `-6 seconds` at 6s behind, `SEEKING` while a seek is in flight, `4s`/`03:13` countdown for UPCOMING, `PLAYING` for a user-started PREVIOUS clip.
- **Implement:** `packages/frontend/src/Applications/RadioTraffic/cardStatus.ts` — pure, no React.
- **Code:**
```ts
export type Lane = "live" | "upcoming" | "previous";
export type Badge =
	| { kind: "in-sync" } | { kind: "seeking" }
	| { kind: "drift"; seconds: number }
	| { kind: "countdown"; label: string }
	| { kind: "playing" };

export function laneFor(item: MediaItem, nowMs: number): Lane;
/** liveMs = calcSeekSeconds(item, nowMs)*1000; currentMs = audioEl.currentTime*1000 */
export function badgeFor(args: { lane: Lane; liveMs: number; currentMs: number; seeking: boolean; userPlaying: boolean }): Badge;
```
- **Constraint:** reuse `activeSegments`/`upcomingSegments`/`previousSegments` predicates from `radio-core/stationGrouping.ts` — do not re-derive the windows, and do not change their exports (10 consumers).
- **Depends on:** Step 8
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/cardStatus.test.ts`

### Research Enhancement

- **Edge Case — PREVIOUS has a data gap the plan didn't account for.** `sendMp3Snapshot` fires only on init/subscribe/seek (`ws.go:948,966`), never on forward ticking, so an item that ends *between* snapshots is in no history frame and would simply vanish instead of moving to PREVIOUS. The app being replaced solves this with a `seenItemsRef` accumulator that folds every live-seen `mp3Items` entry into the history pool (`RadioScanner.tsx:195-202,417-426`). **Port that accumulator**, and add a test: an item that ends with no intervening `mp3_history` frame still appears in PREVIOUS.
- **Edge Case — `badgeFor`'s `seeking` argument has no producer.** Nothing in `MediaStreamProvider.tsx` exposes seek-in-flight state; `seekDetection.ts` clears buffers and dispatches `{type:"seek"}` but tracks nothing afterward. Decide and specify: a single connection-level flag (set on seek dispatch, cleared on the next `mp3` frame) is the cheaper option and matches the mock, where SEEKING appears on one card at a time only because one card is playing. Add it to the Step 7 context surface.
- **Ref:** spec-flow-analyzer; verified against `origin/main` `ws.go`, `RadioScanner.tsx`, `seekDetection.ts`.

### Step 10: tag vocabulary tree and item filtering
- **Test:** `packages/frontend/src/Applications/RadioTraffic/tagFilter.test.ts` — vocabulary groups into the 8 namespace buckets ordered by `sort` (null-last) then `value`; an empty checked-set matches every item; checked tags within one namespace OR together, across namespaces AND together; an item with no tags is excluded once any filter is active; a namespace with 300+ values still groups in one pass.
- **Implement:** `packages/frontend/src/Applications/RadioTraffic/tagFilter.ts`.
- **Code:**
```ts
export interface TagGroup { namespace: string; label: string; values: TagDef[]; large: boolean }
/** aircraft 377, facility 372, person 339 — these open a picker instead of expanding. */
export const LARGE_NAMESPACES = new Set(["aircraft", "facility", "person"]);
export function groupVocabulary(vocab: TagDef[]): TagGroup[];
/** OR within a namespace, AND across namespaces — checking two facilities widens, adding an aircraft narrows. */
export function matchesFilter(tags: TagDef[] | undefined, checked: ReadonlySet<string>): boolean;
```
- **Depends on:** Step 7
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/tagFilter.test.ts`

### Research Enhancement

- **Edge Case — filtering out a playing card kills its audio silently.** Removing an item from a lane's render list unmounts its `TrafficCard`, destroying the `<audio>` element mid-playback. Two behaviours need deciding and testing: (a) on re-check, does the clip resume at `calcSeekSeconds(item, now)` or restart at 0 — it must reseek, or a filter toggle desyncs the card from the clock; (b) if the hidden card was the solo target, the app lands in the all-muted state from Step 15's enhancement **with the card gone**, so there is nothing to click to recover. Releasing solo on filter-hide covers both.
- **Ref:** spec-flow-analyzer.

### Step 11: searchable multi-select picker for large namespaces
- **Test:** `tagSearch.test.ts` + `TagPickerWindow.test.tsx` — `searchTags` matches case-insensitively on `value`, ranks prefix matches above substring, and returns everything for an empty query; the window lists a namespace's values with checkboxes; typing narrows the list; checked values survive narrowing and are reported on confirm; Cancel discards pending changes.
- **Implement:** `TagPickerWindow.tsx` (a `ClassicyWindow` opened from the sidebar), `tagSearch.ts` (pure).
- **Code:**
```ts
/** Prebuilt lowercased index — 377 values are re-filtered on every keystroke. */
export function buildSearchIndex(values: TagDef[]): SearchIndex;
export function searchTags(index: SearchIndex, query: string): TagDef[];
```
```tsx
// A large namespace's sidebar row opens the picker instead of expanding inline.
<button onClick={() => setPicker("aircraft")}>
	Aircraft{checkedIn("aircraft") > 0 ? ` (${checkedIn("aircraft")})` : ""}…
</button>
```
- **Constraint (perf):** filter the prebuilt index, not the raw array.
- **Visual — requires human verification:** window chrome, list metrics, the checked-count affordance on the sidebar row.
- **Depends on:** Step 10
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/tagSearch.test.ts src/Applications/RadioTraffic/TagPickerWindow.test.tsx`

### Step 12: relocate `PeaksWaveform` and add the dual scrubbers
- **Test:** extend the existing `PeaksWaveform.test.tsx` at its new path — existing behaviour (canvas sized from layout, redraw on resize, no-2D-context no-op under jsdom) still passes; `peaks` absent or empty renders a flat skeleton without throwing; `livePct`/`currentPct` are exposed on the DOM for assertion; PlaylistEditor's own render is unchanged.
- **Implement:** move `Applications/PlaylistEditor/PeaksWaveform.tsx` (+ its test) to a shared home, re-export from PlaylistEditor's old path so `usePeaksForSpan.ts` and the timeline lanes keep working, then add the two optional scrubber props.
- **Code:**
```tsx
// Existing signature — do not break PlaylistEditor's call sites.
export function PeaksWaveform({ peaks, height, livePct, currentPct }: {
	peaks: number[][]; height: number;
	/** Where the virtual clock says we should be. Card view only. */
	livePct?: number;
	/** Where the <audio> element actually is. The gap is the drift badge. */
	currentPct?: number;
}) { /* … existing canvas draw, unchanged … */ }
```
- **Constraint:** the existing component is already correct — static canvas, `ResizeObserver` redraw, resolves `currentColor` before assigning `fillStyle` (a canvas cannot parse the CSS keyword), sizes the bitmap from `clientWidth` every draw. Preserve all of it; add only the scrubbers.
- **Constraint (perf):** scrubbers are absolutely-positioned divs, **not** canvas — they move every tick and must not force a redraw of the envelope.
- **Constraint:** no `requestAnimationFrame`, no `AudioContext`, no `createMediaElementSource`. Do not extend `WaveformVisualizer`.
- **Visual — requires human verification:** scrubber weight (2px), colours for live vs current, skeleton treatment.
- **Depends on:** Step 7
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/PlaylistEditor/ src/Applications/RadioTraffic/`

### Step 13: card tab panels
- **Test:** `packages/frontend/src/Applications/RadioTraffic/tabs/*.test.tsx` — Details renders start/end/duration/link + chips + `subject`; Mentions renders four columns (`mentions.*` plus `topic:` tags) and omits empty columns; Parties renders one column per participant with a confidence badge whose class tracks high/medium/low; Transcript renders cues from the `.vtt` and shows a placeholder when `subtitles` is absent; Source renders `provenance`; **an item with no metadata renders all five tabs without throwing**.
- **Implement:** `tabs/DetailsTab.tsx`, `MentionsTab.tsx`, `PartiesTab.tsx`, `TranscriptTab.tsx`, `SourceTab.tsx`.
- **Code:**
```tsx
// mp3_tags.color is NULL on every row today, so the namespace palette is the
// source of truth; color is honoured only if a curator ever sets one.
<span className={styles.chip} style={{ background: tag.color ?? NS_COLOR[tag.namespace] }}>
	{tag.value}
</span>
```
- **Constraint:** `TranscriptTab` reuses `vttUrl()` + `useQuickTimeSubtitles` — do not re-implement cue parsing.
- **Constraint:** the Mentions topics column reads `topic:` tags — there is no `topics` field, by design.
- **Visual — requires human verification:** chip palette, confidence badge colours, 4-column Mentions grid at 206×39.
- **Depends on:** Step 7
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/tabs/`

### Step 14: traffic card composition
- **Test:** `TrafficCard.test.tsx` — header shows `meta.subject` falling back to `full_title` (covers the 59 metadata-less items) and the Step-8 badge; the tab bar exposes five tabs with arrow paging when overflowing; the control bar's pause button toggles.
- **Implement:** `TrafficCard.tsx`, `CardTabBar.tsx`.
- **Code:**
```tsx
<article className={styles.card} data-lane={lane}>
	<CardHeader title={meta?.subject ?? item.full_title} badge={badge} />
	<PeaksWaveform peaks={meta?.peaks} livePct={livePct} currentPct={currentPct} height={27} />
	<CardControlBar muted={muted} onTogglePause={…} />
	<CardTabBar tabs={TABS} active={active} onSelect={setActive} />
</article>
```
- **Constraint:** `useHorizontalOverflow` already exists — use it to decide when the tab arrows appear.
- **Visual — requires human verification:** 210×124 card metrics, Platinum window-frame chrome.
- **Depends on:** Steps 9, 12, 13
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/TrafficCard.test.tsx`

### Step 15: filter tree sidebar
- **Test:** `FilterTree.test.tsx` — one row per namespace; the five small namespaces expand inline with checkboxes; the three large ones open the Step-10 picker instead and show a checked count; checking a value calls back with the tag string; checked state renders the ✓ marker; a namespace with no values is omitted.
- **Implement:** `FilterTree.tsx`, using the repo-local `Components/Disclosure/Disclosure.tsx` (has `defaultOpen`; `ClassicyDisclosure` does not) and `ClassicyCheckbox`.
- **Code:**
```tsx
{groups.map((g) => g.large ? (
	<LargeNamespaceRow key={g.namespace} group={g}
		count={checkedIn(g.namespace)} onOpen={onOpenPicker} />
) : (
	<Disclosure key={g.namespace} label={g.label} defaultOpen={OPEN_BY_DEFAULT.has(g.namespace)}>
		{g.values.map((t) => (
			<ClassicyCheckbox key={t.tag} id={t.tag} label={t.value}
				checked={checked.has(t.tag)} onClickFunc={() => onToggle(t.tag)} />
		))}
	</Disclosure>
))}
```
- **Visual — requires human verification:** 141px sidebar width, indentation, ✓ glyph.
- **Depends on:** Step 11
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/FilterTree.test.tsx`

### Step 16: central audio coordinator
- **Test:** `audioCoordinator.test.ts` — elements are keyed by item id and **survive** their card unmounting (filter hide, lane migration, reorder); `ensure(itemId, url)` is idempotent; `release(itemId)` pauses before dropping the element; the autoplay-retry listeners are registered **once** for the whole app, not per card; a clock jump > 5s reseeks every registered element; `currentTime` is readable for a card that is not rendered.
- **Implement:** `audioCoordinator.ts` — a module-level registry owning every `HTMLAudioElement`, with `useSyncExternalStore` subscriptions for cards.
- **Code:**
```ts
// Cards are views, not owners. In the tuner one StationPlayer owned the whole
// mix, so element lifetime == app lifetime. In a card grid, cards mount and
// unmount for reasons unrelated to media — filter toggles, lane migration,
// drag reorder — and if element lifetime follows component lifetime, playback
// and clock sync become probabilistic.
export function ensure(itemId: number, url: string): HTMLAudioElement;
export function release(itemId: number): void;   // pauses first — removing the
// element from the DOM does NOT stop playback (StationPlayer.tsx:218-220)
export function positionMs(itemId: number): number | undefined;
export function subscribe(itemId: number, cb: () => void): () => void;
```
- **Constraint (perf — verified):** `StationPlayer.tsx:156-162` registers three **document-level capture** listeners (`click`, `keydown`, `pointerdown`) for autoplay retry. That is fine for one player; ~10 cards each doing it is 30 global listeners firing on every interaction. Register them **once** in the coordinator and drive the existing `audioBlocked.ts` token store, which is already a shared singleton.
- **Constraint:** the drift health-check (15s) and jump-reseek (>5s) move here too — they iterate the registry, not a component's refs.
- **Depends on:** Step 9
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/audioCoordinator.test.ts`

### Step 17: modal tool palette
- **Test:** `toolMode.test.ts` + `ToolPalette.test.tsx` — exactly one tool active at a time; `arrow` + card click solos that card (every other live card muted); `mute` + click mutes only the clicked card; `unmute` + click unmutes only it; `hand` + click neither solos nor mutes; per-card mute state survives a tool change.
- **Implement:** `toolMode.ts` (pure reducer), `ToolPalette.tsx`.
- **Code:**
```ts
export type Tool = "arrow" | "mute" | "unmute" | "hand";
export interface AudioState { soloId: number | null; muted: ReadonlySet<number> }
/** Default: exactly one LIVE player is audible — the solo target. */
export function applyToolClick(state: AudioState, tool: Tool, itemId: number): AudioState;
export function isAudible(state: AudioState, itemId: number, lane: Lane): boolean;
```
- **Constraint:** reuse `effectiveMutedIds` semantics from `radioPlayback.ts` rather than inventing a second solo model.
- **Visual — requires human verification:** placeholder glyphs for the four tools; Robbie replaces the artwork.
- **Depends on:** Step 16
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/toolMode.test.ts`

### Research Enhancement

- **Edge Case — a stale `soloId` silences everything.** `effectiveMutedIds(muted, soloId, playingIds)` (`radioPlayback.ts:37-44`) returns `playingIds.filter(id => id !== soloId)` — if the soloed item is no longer playing, *nothing* matches the exception and every card is muted with no visible cause. The current app has a dedicated effect for this (`RadioScanner.tsx:383-392`: "A soloed clip that finishes (or expires on seek) releases the solo, so the rest of the mix comes back rather than staying silent"). **Port it**: clear `soloId` whenever the soloed item leaves LIVE, ends, or is hidden by a filter. Test each of those three exits.
- **Best Practice — "exactly one LIVE player audible by default" needs a stated rule.** With `soloId: null` and nothing muted, `isAudible` is true for every LIVE card, so the invariant fails at startup. The old app dodged this by requiring a station pick first (`activeStation === ""` → silence); the redesign has no such gate. Specify the auto-solo target — earliest `start_date`, tie-broken by lowest `id`, is deterministic and testable — and re-run it whenever the current target leaves LIVE.
- **Ref:** spec-flow-analyzer; verified against `origin/main` `radioPlayback.ts`, `RadioScanner.tsx`.

### Step 18: lanes with collapse and drag-reorder
- **Test:** `LaneSection.test.tsx` — LIVE renders no collapse control while UPCOMING and PREVIOUS do; collapsing hides the cards and keeps the label; with the `hand` tool active a card drag reorders within its lane and cannot cross lanes; with any other tool dragging is inert.
- **Implement:** `LaneSection.tsx`, `laneOrder.ts` (pure reorder).
- **Code:**
```ts
/** Manual order is sparse: only dragged ids are pinned; the rest keep chronological order. */
export function applyManualOrder(items: MediaItem[], order: readonly number[]): MediaItem[];
export function moveWithinLane(order: readonly number[], fromId: number, toIndex: number): number[];
```
- **Constraint:** LIVE has no collapse control in the design — do not add one.
- **Visual — requires human verification:** lane label strips (15–22px), drag affordance (`hand-grab` cursor).
- **Depends on:** Steps 14, 17
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/LaneSection.test.tsx`

### Research Enhancement

- **Edge Case — `laneOrder` has no defined behaviour across lane changes.** A pinned position is meaningful only relative to a sibling set, and that set changes as items move UPCOMING→LIVE→PREVIOUS with the clock, or reverse on a backward seek (`retention.ts` leading-edge behaviour). Specify: a pin is scoped to `(lane, itemId)` and is **dropped when the item changes lane**, so a stale pin can never reorder a lane the user never touched. Test a manually-reordered card crossing a lane boundary in both directions.
- **Performance — the pin map is unbounded as written.** `laneOrder` persists to Classicy app state and only ever grows; over a long session with backward seeks it accumulates ids for items no longer in any lane. Prune on write to ids currently present, matching `sanitizeItemIds`' intent in `radioPlayback.ts`.
- **Ref:** spec-flow-analyzer; `origin/main` `retention.ts`, `radioPlayback.ts`.

### Step 19: app shell and audio orchestration
- **Test:** `RadioTraffic.test.tsx` — subscribes to mp3 on mount and unsubscribes on unmount; cards distribute into the three lanes; an active tag filter removes non-matching cards from every lane; exactly one LIVE `<audio>` is unmuted by default; a clock jump > 5s re-seeks mounted elements.
- **Implement:** `RadioTraffic.tsx` (replaces `RadioScanner.tsx`'s layout), `RadioTrafficContext.ts` (persist `checked`, `tool`, lane collapse, `laneOrder`).
- **Code:**
```tsx
<ClassicyApp id={appId} name="Radio Traffic" icon={…}>
  <ClassicyWindow id={`${appId}_main`} title="Radio Traffic" initialSize={[892, 601]}>
    <aside><ToolPalette … /><FilterTree … /></aside>
    <main>
      <LaneSection lane="live" collapsible={false} items={live} />
      <LaneSection lane="upcoming" items={upcoming} />
      <LaneSection lane="previous" items={previous} />
    </main>
  </ClassicyWindow>
</ClassicyApp>
```
- **Constraint:** keep `getNowMs()` sub-minute correction, `calcSeekSeconds`, the 15s drift health-check and the >5s jump reseek from `StationPlayer.tsx` — port them, do not rewrite them.
- **Depends on:** Steps 15, 18
- **Validation:** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic/`

### Research Enhancement

- **Best Practice — persisted state needs sanitize-on-load.** This codebase treats stored app state as untrusted: `radioScannerSettings.ts:108-109` ("a hand-edited or stale value could be anything; invalid fields fall back individually") plus `sanitizeItemIds`/`sanitizeStationKeys`/`sanitizeActiveStation` in `radioPlayback.ts`, applied at `RadioScanner.tsx:183-185`. Step 17 persists `checked` (tag strings), `tool` (enum), lane-collapse flags and `laneOrder` (ids) with no equivalent. Add a `sanitizeRadioTrafficState` covering all four — an unknown `tool` value in particular would put the app in a mode with no handler.
- **Edge Case — per-item mute is silently dropped.** `RadioScanner.tsx:183-185` persists `mutedItems`; Step 17's persisted list omits it, so per-card mute state (Decision 1: "each player has its own mute state") would reset on every reload. Either persist it or state the reset as intentional.
- **Ref:** spec-flow-analyzer; `origin/main` `radioScannerSettings.ts`, `radioPlayback.ts`, `RadioScanner.tsx`.

### Step 20: docs and dead-code removal
- **Test:** `RadioTuner.test.tsx` and the PlaylistEditor / Mobile suites must pass **unchanged** — they are the regression net for the deletions below.
- **Implement (docs):** `packages/backend/docs/websocket-protocol.md` (`mp3_meta` frame), a new `docs/http-api.md` (the three `/mp3/*` routes: shapes, caching, rate limits — no such doc exists today), `docs/data-model.md` (the new public fields, `mp3_tags`, `mp3_items_tags`, `peaks`, and that `parties` stays private), `packages/tools/video-grabber/docs/party-identification.md` (the `derive-public-meta` stage), `packages/frontend/CLAUDE.md` (app entry + the new `radio-core/` shared module), `Desktop.tsx` (swap registration — **not** `app.tsx`; `Desktop.tsx:42` is where the Radio app is mounted). Delete `seed.mjs:500-516` `TAG_INDEX_SQL`.
- **Implement (deletions).** After Step 8 the shared modules already live in `radio-core/`, so what remains in `RadioScanner/` is only the shell. Two of these are **not** as free-standing as they look:

| Delete | Prerequisite |
|---|---|
| `RadioScanner.tsx` + test | `Desktop.tsx:42` imports it (`import { RadioScanner } from "./Applications/RadioScanner/RadioScanner"`) — swap that registration to `RadioTraffic` in the same commit |
| `RadioScannerContext.ts` + test | **exports `radioTuneStation`**, imported by `Providers/Playlist/PlaylistProvider.tsx:28`, and side-effect-imported by `appManifests.test.ts:13`. Move `radioTuneStation` to `radio-core/` (or the new context) **before** deleting, or playlist→radio tuning breaks silently |
| `NowPlayingList.tsx` + test | superseded by cards; RadioTuner's own copy is separate and its import is already commented out at `RadioTuner.tsx:28` |

- **Constraint:** `BROADCAST_STATIONS` (exported from `stationGrouping.ts`, now in `radio-core/`) is read by `Providers/Playlist` — it must survive the move.
- **Constraint:** the two prerequisites above are the whole risk of this step. Neither is caught by a type error alone — `radioTuneStation` is a plain export and `Desktop.tsx` would simply fail to build, but a partial revert could leave the registration dangling. Run the full suite, not just the Radio ones.
- **Constraint:** wire-format changes require both sides in the same PR (root CLAUDE.md) — this ships with Steps 5 and 7.
- **Validation:** `pnpm lint && pnpm build && pnpm test && (cd packages/backend && go test ./...)`

### Step 21: author the Radio Traffic E2E spec
- **Test:** this step *is* the test. `packages/frontend/e2e/tests/radio-traffic.spec.ts` — the app opens from the desktop; cards render into LIVE/UPCOMING/PREVIOUS; checking a small-namespace tag narrows the visible cards; opening the picker for `aircraft`, typing, and confirming narrows them further; each tool activates and shows as selected; a card's tab bar switches panels.
- **Implement:** the spec plus any `data-testid` hooks the components need.
- **Code:**
```ts
// No Radio spec exists today — verified: zero matches for RadioScanner across
// packages/frontend/e2e/. The checklist's "update the E2E specs" was wrong;
// this is net-new authoring, and E2E is a required check that gates the
// GHCR push, so the feature cannot merge without it.
test("filters cards by tag", async ({ page }) => { /* … */ });
```
- **Constraint:** no mocking in E2E (repo testing rule) — drive the real app against the dev server, seeded to the canonical `2001-09-11T12:40:00.000Z` clock so lane membership is deterministic.
- **Constraint:** the virtual clock advances in real time; pause it or pin the seed before asserting lane membership, or the test flakes as cards migrate LIVE→PREVIOUS mid-run.
- **Depends on:** Step 19
- **Validation:** `pnpm --filter @rt911/frontend exec playwright test e2e/tests/radio-traffic.spec.ts`

## Acceptance Criteria

- [ ] `mp3_meta` is emitted once per mp3 subscription and not re-sent on seek; it carries no `vocabulary`; `mp3`/`mp3_history` payload sizes are unchanged from today
- [ ] The sidebar's vocabulary comes from `GET /mp3/tags` and degrades to an empty tree (not a crash) when that route is unreachable
- [ ] `RadioTuner`, `PlaylistEditor` and `Mobile` suites pass unchanged after the Step 18 deletions
- [ ] `gate_reasons` and `model` are absent from the derived public fields — asserted in Step 1's test, the single redaction point
- [ ] `mp3_items.parties` still returns 403 to anonymous Directus readers after the grant change
- [ ] `mp3SelectFrom`, `queryItems` and `model.MediaItem` are unchanged; metadata travels only on `mp3_meta` and the HTTP routes
- [ ] A soloed card that ends, changes lane, or is filtered out releases solo rather than silencing every card
- [ ] An item that ends between `mp3_history` snapshots still appears in PREVIOUS
- [ ] Persisted state is sanitized on load; an unknown `tool` value falls back rather than dead-ending the UI
- [ ] `GET /mp3/tags`, `GET /mp3/meta`, `GET /mp3/meta/{id}` serve from the Redis cache, answer 304 to a matching `If-None-Match`, and send a positive `Cache-Control`
- [ ] The HTTP routes require no auth and read no cookie
- [ ] Filter tree renders 8 namespaces: the five small ones inline, the three large ones via a searchable multi-select window
- [ ] The 59 items without metadata render with `full_title` and a populated Transcript tab, no errors
- [ ] Cards render in LIVE / UPCOMING / PREVIOUS using the existing time-window predicates, with PREVIOUS as `end <= now`
- [ ] Badge shows in-sync, SEEKING, drift-in-seconds, countdown, and PLAYING per the mock
- [ ] Tag filtering ORs within a namespace and ANDs across namespaces
- [ ] Details / Mentions / Parties / Transcript / Source all render from the public fields + tags + `subtitles`
- [ ] Arrow solos, Mute/Unmute set per-card state, Hand reorders within a lane; one LIVE player audible by default
- [ ] `PeaksWaveform` renders the existing 480-bucket data and degrades to a skeleton when peaks are absent
- [ ] Cards render for the 59 items that have no `parties`, falling back to `title` with only the Transcript tab populated
- [ ] `go test ./...`, `vitest run`, `pytest`, `eslint .`, `tsc -b` all pass
- [ ] Playwright E2E green — it is a **required** check and the `frontend` image job `needs:` it, so a red E2E blocks both merge and the GHCR push

## Enrichment Summary

**Deepened:** 2026-08-18
**Gaps found:** 11 (all verified against `origin/main`; none discarded)
**Agents used:** spec-flow-analyzer
**Second opinion:** ✓ GPT-5.4 (re-run; the first attempt died `agent_loop/EPERM` under the sandbox). Verdict: *"underestimates cross-transport drift, cache invalidation, and audio-lifecycle failures."* 10 findings; 6 new, 4 overlapping the gap analysis. Two were verified false-claim-in-plan and corrected.
**Confidence:** N/A (no synthesis needed — the two sources agreed wherever they overlapped)

### Second-Opinion Additions

- **The plan asserted something false.** Performance Considerations claimed "`NOTIFY`-driven invalidation keeps them fresh for free." Verified wrong: `mp3_listen.go:38-43` installs its trigger on `mp3_items` **only**, and nothing anywhere watches `mp3_tags`/`mp3_items_tags`. `derive-public-meta` PATCHes `mp3_items` so it does invalidate — but `rebuild_tags_flow`, which only rewrites junction rows, leaves the vocabulary and per-item tags stale **indefinitely**. Corrected, with a trigger-extension constraint on Step 5.
- **Cross-transport drift.** Vocabulary (HTTP) and item tags (WS) can come from different cache generations, showing tags on cards that the filter tree cannot offer. Step 5 now stamps a shared `generation` into both, and the client refetches on mismatch.
- **The redaction boundary was half-built.** `provenance` was a subtree copy into a Go `any` — so any future key added under `commission`/`sources` would silently become public. Now an enumerated allow-list in Step 1 and a typed `*Provenance` in Step 4, with a test that plants unknown keys at top level and nested.
- **Autoplay retry listeners would multiply.** `StationPlayer.tsx:156-162` registers three *document-level capture* listeners; that is fine for one player and 30 global listeners for a ten-card grid. Now registered once in the Step 15 coordinator, driving the existing `audioBlocked.ts` singleton.
- **Card-owned audio is the wrong ownership model** for a grid whose members mount and unmount on filter, reorder and lane migration. Added **Step 16**, a central coordinator keyed by item id; cards became views.
- **The shared library moves before anything is deleted.** Robbie overruled the "keep the directory name" default: Step 8 extracts `radio-core/` as a move-only, land-it-first refactor. Mapping the imports for it also caught two errors in the old deletion table — `RadioScannerContext.ts` exports `radioTuneStation` (used by `PlaylistProvider.tsx:28`), and the Radio app is mounted in `Desktop.tsx:42`, not `app.tsx`. Both would have broken silently.
- **Tag rebuild and public-meta derivation became one flow** with a `derived_at` version marker, so the Parties tab and the tag filters cannot disagree about the same recording.

### Key Discoveries

- **The plan contradicted itself on the backend.** Step 3 said "extend `mp3SelectFrom`", but that constant feeds four functions through the generic `queryItems`, whose `rows.Scan` is a fixed 20-column positional list shared with the news/media/pager selects — widening it breaks every other caller. Worse, all four return `[]model.MediaItem`, which `SendMp3`/`SendMp3History` msgpack straight onto the wire (`session.go:385,396`), so growing `MediaItem` would have put ~2KB/item on every `mp3` frame — precisely the cost `mp3_meta` exists to avoid. **Steps 3-5 rewritten** around a standalone `Mp3Metadata`/`Mp3TagVocabulary` pair with their own scanners; `mp3SelectFrom`, `queryItems` and `MediaItem` are now explicitly frozen.
- **`GET /mp3/tags` had no data source.** `cache/mp3.go` is entirely item-keyed; the per-item LATERAL aggregate cannot produce the 1131-row vocabulary (it would drop any tag not attached to an approved item). Added `Mp3TagVocabulary` plus `mp3:vocab`/`mp3:meta`/`mp3:meta:etag` cache keys. This mattered more after Decision 2 made the vocabulary load-bearing for the sidebar.
- **No Radio E2E spec exists.** Zero matches for `RadioScanner` under `packages/frontend/e2e/`; the checklist's "update the specs" was wrong. Added **Step 19** to author one — E2E is a required check that gates the GHCR push.
- **Three solved problems in the old app were not carried forward:** the `seenItemsRef` history accumulator (without it, items ending between snapshots vanish instead of moving to PREVIOUS), the solo auto-release effect (without it, a stale `soloId` mutes every card), and the sanitize-on-load pattern for persisted state.

### New Risks Identified

- **Deploy ordering — high.** `Mp3Metadata` selects columns that do not exist until the infra PreSync Job runs. Backend-before-schema takes the whole mp3 channel down, and `selfHeal: true` means no imperative rollback. Prerequisites now specify a five-gate sequence with an explicit `\d mp3_items` verification before any backend merge.
- **Silent total-mute — medium.** `effectiveMutedIds` returns every playing id as muted when `soloId` is set but absent from `playingIds`. Reachable three ways (clip ends, card changes lane, filter hides it) and invisible to the user. Mitigation: release solo on all three exits, tested individually.
- **Startup invariant unmet — medium.** "Exactly one LIVE player audible" fails at `soloId: null`, when every card is audible. Needs a stated auto-solo rule (earliest `start_date`, tie-broken by id).
- **Unbounded persisted state — low.** `laneOrder` only grows; prune to currently-present ids on write.

## Checklist (non-TDD cleanup)

- [ ] Branched from `origin/main`, not local `main`
- [ ] Infra PR landed adding the Step 1 fields to `apps/rt911/schema/snapshot.json`
- [ ] `rederive-mp3-metadata` run with `dry_run=False` over the corpus; 755 rows populated with matching `derived_at`, 59 left empty
- [ ] `radio-core/` extraction (Step 8) landed and green **before** any Radio Traffic code is written
- [ ] `apply-hypercard-public-perms.mjs --apply` run; a follow-up dry run exits 0
- [ ] Public field list identical in `seed.mjs` and `apply-hypercard-public-perms.mjs` (hand-synced by design)
- [ ] `TAG_INDEX_SQL` dead code removed from `seed.mjs`
- [ ] Retired RadioScanner UI files deleted or explicitly kept per Open Q5
- [ ] `radio-traffic.spec.ts` authored (Step 19) — no Radio E2E spec exists today, and E2E gates the image push
- [ ] All commits GPG-signed (`git log --show-signature -1`)
- [ ] **Every commit carries its `Co-Authored-By: Claude <noreply@anthropic.com>` trailer**, including subagent commits — `scripts/provenance.mjs` has no other certain signal, and a commit made via a literal `git commit -m "…"` loses the trailer and is silently recorded as human work. Use:
```sh
git add <files> && git commit -F - <<'EOF'
feat(radio): <description>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```
