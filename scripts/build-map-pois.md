# Flight Tracker POI dataset (map_pois airports)

Generates `map_pois.airports.json` -- one record per US airport that met the
FAA's statutory "primary" commercial-service threshold (>10,000 annual
revenue passenger enplanements) in CY2000, the year immediately preceding
2001-09-11 (403 airports; see "Final count" below) -- plus a curated
`map_pois.airports.overlay.json` of 1998-2003 statistics for the large and
medium hubs. Both are checked in and consumed by `scripts/load-map-pois.mjs`
(Task 10).

## Defining "primary commercial"

Rather than reconstruct the FAA's NPIAS 2001 primary-airport roster from
proxies (e.g. OurAirports' current-day `type`/`scheduled_service` fields,
which reflect 2026 status, not 2001, and are a poor match -- see the "why
not OurAirports alone" note at the end of this doc), this dataset is built
from the FAA's own historical determination of which airports *were*
primary in the relevant year:

**Primary source:** FAA DOT/TSC CY2000 ACAIS Database, Report C12
("Changes in Revenue Passenger Enplanements at Primary Airports"), Report
Date 10/19/2001 -- i.e. published about five weeks after 2001-09-11, using
full-year CY2000 data (the most recent complete year at the time):

```sh
curl -sL -A "Mozilla/5.0" \
  https://www.faa.gov/sites/faa.gov/files/airports/planning_capacity/passenger_allcargo_stats/passenger/cy00_primary_change.pdf \
  -o cy00_primary.pdf
```

(A plain `curl -sL` without a `User-Agent` header gets a 403 from
faa.gov; the header above works.) This is the FAA's own report of exactly
which airports crossed the >10,000-enplanement "primary" threshold that
year, down to the LOCID and exact enplanement count -- effectively the
NPIAS-era primary list the original task brief speculated might not be
obtainable. It was transcribed verbatim into `faa_cy2000_primary.txt`
(rank, FAA LOCID, name, city, state, CY2000 enplanements, % change,
CY1999 enplanements per row).

**Rule:** every US row (`state` not in `{PR, GU, VI, CM, AQ}`, i.e.
excluding Puerto Rico, Guam, the US Virgin Islands, the Northern Mariana
Islands, and American Samoa) with `CY2000 enplanements > 10,000`. This is
the FAA's own statutory primary-airport definition (49 U.S.C. § 47102),
applied using the FAA's own published figures -- not a proxy or a guess.

## Base dataset (map_pois.airports.json)

### 1. Download OurAirports for coordinates/runway data

```sh
curl -sL https://davidmegginson.github.io/ourairports-data/airports.csv -o airports.csv
curl -sL https://davidmegginson.github.io/ourairports-data/runways.csv  -o runways.csv
```

The FAA report gives enplanements and an FAA LOCID/city/state but no
coordinates or runway data, so each row is joined against current
OurAirports data for `lat`/`lon`, `city`, `region`, `icao`, and runway
stats. Coordinates are effectively static, so today's OurAirports data is
fine for any airport that existed in 2001.

### 2. Join each FAA LOCID to OurAirports

Tried in order against OurAirports' `iata_code`, `local_code`, `gps_code`,
then `ident` -- always preferring a **US** match with a resolvable IATA
code over a non-US one, even if that means falling through to a later
field. This matters: 3-letter FAA LOCIDs get reused internationally, so a
naive "first match on `iata_code`" join silently produces wrong-country
results for a handful of airports whose *current* IATA code doesn't match
their CY2000 FAA LOCID:

- `CRQ` (McClellan-Palomar, Carlsbad CA in the FAA report) resolves via
  `iata_code` to **Caravelas Airport, Brazil** (IATA `CRQ` is currently
  assigned there); the real match is via `local_code` to `KCRQ`, whose
  current `iata_code` is `CLD`.
- `HXD` (Hilton Head, SC) resolves via `iata_code` to **Haixi Delingha
  Airport, China**; the real match is via `local_code` to `KHXD`, current
  `iata_code` `HHH`.
- `SAW` (Marquette/Sawyer Intl, MI) resolves via `iata_code` to
  **Istanbul Sabiha Gökçen, Turkey**; the real match is via `local_code`
  to `KSAW`, current `iata_code` `MQT`.

Two more FAA LOCIDs from CY2000 have since been fully retired and needed a
manual override (confirmed via OurAirports' `keywords` field, which
records prior identifiers): `L15` (Henderson, NV) -> `HSH`, and `17Z`
(Manokotak, AK) -> `KMO`.

### 3. Exclude airports with no usable current IATA, or a post-2001 relocation

- **`SGU` excluded.** The FAA report's CY2000-primary "St George Muni"
  (Utah) closed; the IATA code `SGU` now belongs to *St George Regional*,
  a different facility at a different site that opened in 2011. Including
  it under today's coordinates would misrepresent a 2001-era location.
- **Five airports excluded for lacking a resolvable IATA in current
  OurAirports data** (schema requires a real 3-letter IATA code):
  `PFN` (Panama City-Bay Co Intl, closed 2010, superseded by `ECP` which
  did not exist in 2001 and is therefore correctly absent from this
  dataset entirely), `LHD` (Lake Hood Seaplane Base, Anchorage), `CVX`
  (Charlevoix Muni, MI), `3W2` (Put-in-Bay, OH), `PCW` (Port Clinton/now
  Erie-Ottawa Intl, OH).

Two well-known post-2001 US airport openings/relocations -- Northwest
Florida Beaches Intl (`ECP`, opened 2010) and Williston Basin Intl (`XWA`,
opened 2019) -- never needed explicit exclusion: they simply don't appear
in the FAA CY2000 report at all, because they didn't exist yet. This is
one of the strengths of using the FAA's own historical report as the base
set rather than a current-day proxy: post-2001 openings are excluded by
construction, not by a hand-maintained denylist.

### 4. Emit records

For each surviving airport, `generate_map_pois.py` emits:

- `name`, `city` from the matched OurAirports record (`name`,
  `municipality`); `iata` from OurAirports `iata_code` (which is
  authoritative for lookups even where it differs from the CY2000 FAA
  LOCID, per step 2); `icao` from `icao_code` (falling back to `ident`
  when it's already 4 characters); `region` = `iso_region` minus the
  `US-` prefix.
- `lat`/`lon` = OurAirports `latitude_deg`/`longitude_deg`, rounded to 4
  dp. Cross-checked: for every one of the 216 IATA codes already present in
  the bundled `packages/frontend/src/Applications/FlightTracker/airports.json`
  (route-endpoint coordinates used by existing flight tracks), the
  generated coordinates match exactly.
- `details.elevation_ft` = `elevation_ft` (parsed as an integer; `null`
  for the one seaplane base in the dataset, Metlakatla `MTM`, which has no
  meaningful elevation and none recorded).
- `details.runway_count` = count of non-closed `runways.csv` rows for the
  airport's `ident`; `details.longest_runway_ft` = max `length_ft` across
  those runways.
- `layer` = `"Major Airports"`, `category` = `"airport"`,
  `detail_title` = `"Airport Details"`.

### 5. Sort by IATA and write

```sh
python3 generate_map_pois.py
```

(run from `scripts/`, with `ourairports.csv`/`runways.csv` and
`faa_cy2000_primary.txt` alongside it -- paths are relative in the script).
It writes both `map_pois.airports.json` and `npias-2001-primary.txt` (the
final sorted IATA list -- now the *actual* derived primary-airport roster,
not a placeholder). Re-running against freshly downloaded OurAirports CSVs
should reproduce the same 403-record dataset (OurAirports coordinates are
effectively static for existing facilities; the FAA CY2000 report is a
static historical PDF).

### Final count

**403 airports.** FAA CY2000 primary report: 409 US rows (territories
already excluded) with CY2000 enplanements > 10,000. Minus 1 (`SGU`,
relocated post-2001) minus 5 (no resolvable current IATA) = **403**. The
generator's stderr/stdout line (`final record count: 403`) is
authoritative.

This is closer to, and better-justified than, the ~380 figure the original
task brief speculated at -- it's not a guess calibrated to match that
number, it's what the FAA's own CY2000 report actually contains after
removing the handful of entries that can't be honestly represented with
current data (relocated facility, no IATA code).

### Why not derive the set from OurAirports alone

An earlier iteration of this pipeline tried deriving "primary commercial"
from OurAirports' current `type`/`scheduled_service` fields (large/medium
airport with `scheduled_service == "yes"`), plus hand-curated exclusion
lists for General Aviation relievers, military radar sites, and small
Alaska villages. That produced ~450 airports and required guessing at
several judgment calls that turned out to be *wrong* once checked against
the real FAA data -- e.g. Boeing Field (`BFI`) and Westerly State (`WST`)
were initially assumed to be non-primary GA fields, but both cross the
10,000-enplanement threshold in the actual CY2000 report; conversely
Orlando Sanford (`SFB`) was initially assumed to have had no scheduled
service until Allegiant started in 2002, but CY2000 records over 500,000
enplanements there (era-appropriate leisure-charter traffic). Once the
actual FAA report was located, it replaced that entire heuristic --
it's authoritative, it's from the right year, and it removes the need to
guess at borderline GA-vs-commercial classifications entirely.

## Curated era overlay (map_pois.airports.overlay.json)

`{ IATA: { ...details } }` for the 65 airports the FAA CY2000 report
classifies as **Large** (31) or **Medium** (34) hubs:

- `hub_class` -- computed directly from the same FAA CY2000 report using
  the FAA's statutory hub-classification formula (49 U.S.C. § 47102):
  Large = enplanements ≥ 1% of the CY2000 US primary-airport total
  (708,638,875, per the report's own summary line); Medium = 0.25-1%;
  Small = 0.05-0.25%; Nonhub = below 0.05% (down to the >10,000 primary
  floor). This is a direct computation from verified published figures,
  not an estimate.
- `enplanements_2000` -- the exact CY2000 figure from the same report.
- `operator` -- the operating authority (city, county, port authority,
  airport authority, etc.), included only where confidently known.
- `opened_year` -- included only for a handful of airports with a
  well-established opening/relocation date (e.g. Denver Intl 1995, Austin
  -Bergstrom 1999, Dulles 1962); omitted elsewhere rather than guessed.
- `note` -- short, factual, era-appropriate context (hub carrier,
  notable 2001-09-11 relevance where applicable, etc.); omitted where
  nothing solid was available.

Every field is included only when reasonably confident for the 1998-2003
window; uncertain figures are omitted rather than estimated. Every overlay
key is validated to exist in the base dataset by `scripts/map_pois.test.mjs`.

## Validation

Run `node scripts/map_pois.test.mjs` -- every base record must have a
name, the `"Major Airports"` layer, `"airport"` category, finite lat/lon,
and a unique 3-letter IATA code; every overlay key must exist in the base
set.
