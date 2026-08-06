# Radar tracks → Directus: load design (issues #262/#263)

Turning the 84 RADES full-corpus analysis into product. Inputs (all
regenerable from committed pipeline code; see provenance chain at the end):

- `packages/tools/flight-recon/data/rades/verified_tier.json` — **329 flights**
  whose radar-track naming carries independent posterior evidence
  (238 destination-consistent, 74 diverted-tracked, 42 origin-consistent,
  27 both-ends; categories overlap).
- `Radar_Evaluation_Squadron_(RADES)/stitched.pkl` — **23,783 stitched chains**
  (physics-gated; UA175 known-truth validated), of which ~23,400 stay
  anonymous after naming.
- The BTS csv (`/srv/flight-recon-data/bts_2001-09.csv`) for flight metadata.

Three data stories, in rollout order:

## Story 1 — Named-track upgrade (329 flights, no schema/backend change)

Replace the great-circle reconstructions of the verified-tier flights with
their real radar tracks, exactly the notables pattern:

- **flight_positions**: per-minute resample of the chain (reuse
  `flight_recon/resample.py`; Mode C altitude with interpolation across
  gaps; existing phase assignment). Same flight ids → the streamer and
  Flight Tracker need nothing.
- **flight_tracks**: real-curve geometry via `decimate_polyline`;
  `details.track_source = {"kind": "rades-radar", "evidence": [...],
  "codes": [...], "sites": [...]}` (json field — no schema change);
  wheels_off/on from BTS unchanged.
- **Idempotency**: scoped delete by the exact 329 flight ids for
  `flight_date='2001-09-11'` (the notables' scoped-delete pattern; never a
  window delete). New `reconstruction_runs` row citing 84 RADES + the tier
  evidence. The 5 curated notables are NOT touched (positional control
  guarantees no tier flight shadows them).

## Story 2 — Diverted restorations (the 74, additive)

These flights are currently **absent** from the map (BTS pre-2003 records no
diversion landing → skipped at import). The radar restores them with their
actual forced-landing airports — data no public dataset has.

- Insert as new flights: id = carrier+number from BTS; `diverted = true`;
  `landed_at` = radar-derived airport (nearest airport to a low track end);
  `wheels_on_utc` = track end time; `details.fate.text` = "Diverted to XXX
  under the FAA national ground stop" (+ track_source as above).
- Frontend: `FlightDetailPanel` already renders `landed_at`/`diverted`;
  fate text appears after its utc. Verify the landed-flight linger behavior
  (they should persist ~2 min at the diversion field, then hide — standard
  `flightLanding` path).
- Idempotency: same scoped-delete-by-id-list mechanism (their ids don't
  exist in prod today, so first run deletes 0).

## Story 3 — Anonymous traffic layer (~23,400 chains, opt-in)

Real GA/military/cargo/commuter traffic across the eastern US. This is the
schema/backend/frontend story and ships last.

- **Ids**: `RDR-NNNNN` (zero-padded sequence in chain order) — collision-free
  with real callsigns, stable across reloads of the same pipeline output.
  `carrier = null`, `aircraft_type = null` (generic icon).
- **Inclusion gates**: ≥ 50 returns, ≥ 15 min, ≥ 20 nm net displacement,
  inside the coverage box. Estimated ~1M additional per-minute position rows
  (~+29% of flight_positions) — acceptable for Postgres; index impact
  verified in dry-run.
- **Streamer**: a SEPARATE minute-bucket cache and opt-in subscription
  channel (`flights-anon`), following the pager/mp3 ref-counted `Set<appId>`
  pattern — the existing `flight:minutes` payloads must not grow 2-3× for
  every subscriber that never enables the layer. Backend change, both sides
  of the wire protocol updated in the same PR.
- **Frontend**: MapControls toggle ("Other traffic", persisted, default
  OFF), ghost styling (smaller/dimmer icons, excluded from clustering
  decisions and the aloft counter or counted separately), detail panel shows
  "Unidentified aircraft (84 RADES radar)" + squawk codes/sites/span.
- Loop-mode replay buffers include anon positions only while the toggle is
  on (subscription-driven, so this falls out of the channel design).

## Verification & gates

1. `rades_load.py --dry-run` against a scratch Postgres (schema-init path),
   then against prod DSN (rolls back; reports exact delete/insert counts).
2. PROD-LOAD REVIEW GATE: human review of `verified_tier.json` diffs + this
   spec + the dry-run report before the real run — same gate as notables.
3. Post-load: streamer rewarm (DEL + restart, confirm bucket count), API
   spot-checks (a named flight's geometry vertex count; a diverted flight's
   landed_at), browser verification at 9:50 ET and during the landing wave.
4. Story 3 additionally: payload-size measurement of the anon channel at the
   busiest minute before enabling the toggle in prod.

## Explicit non-goals (this iteration)

- No naming beyond the verified tier (72-79% raw matcher precision is not
  display-grade; the 743 unverified names stay anonymous).
- No BAR/WSD/SEA00/SEA04/SEA13/SEA17 position recovery, no IPS decode.
- No altitude smoothing beyond Mode C + interpolation.

## Provenance chain (regeneration)

```
RS3 binaries --(analysis/rs3_batch_decode.py)--> decoded/*.csv.gz
  --(analysis/segment_rades_exports.py --decoded-dir, segment+stitch)-->
  chains --(correlate_v2 + audits + export_verified)--> verified_tier.json
```

Pipeline commits: 852f546f (parser), 955399f2 (batch/SEADS self-cal),
0f307afd (coverage refit), aea8ad8e (audit), c243c9e6 (stitching + tier).
