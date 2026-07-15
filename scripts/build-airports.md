# Flight Tracker airport coordinates (airports.json)

Generates `packages/frontend/src/Applications/FlightTracker/airports.json` —
IATA → `[lon, lat]` for every `origin`/`scheduled_dest` code in the public
`flight_tracks` collection (~216 codes, ~5 KB). The detail pane's
from-origin / to-destination distance fields read it via `airports.ts`.
Regenerate only if new flight data introduces unseen airport codes.

## Build (requires only curl + python3)

1. Pull the distinct route codes from Directus (public read, no auth):
   ```sh
   curl -s 'https://api-beta.911realtime.org/items/flight_tracks?groupBy[]=origin&limit=-1' -o origins.json
   curl -s 'https://api-beta.911realtime.org/items/flight_tracks?groupBy[]=scheduled_dest&limit=-1' -o dests.json
   ```
2. Download the public-domain OurAirports dataset:
   ```sh
   curl -sL 'https://davidmegginson.github.io/ourairports-data/airports.csv' -o ourairports.csv
   ```
3. Join on `iata_code` and emit the compact table:
   ```python
   import csv, json
   codes = set()
   for fname, key in (("origins.json", "origin"), ("dests.json", "scheduled_dest")):
       for row in json.load(open(fname))["data"]:
           if row.get(key):
               codes.add(row[key].strip().upper())
   # Prefer large/medium airports when a code appears more than once
   # (closed/duplicate rows exist in the dataset).
   rank = {"large_airport": 0, "medium_airport": 1, "small_airport": 2}
   best = {}
   for row in csv.DictReader(open("ourairports.csv", newline="", encoding="utf-8")):
       iata = (row.get("iata_code") or "").strip().upper()
       if iata not in codes:
           continue
       r = rank.get(row.get("type", ""), 3)
       if iata not in best or r < best[iata][0]:
           best[iata] = (r, round(float(row["longitude_deg"]), 4), round(float(row["latitude_deg"]), 4))
   table = {k: [v[1], v[2]] for k, v in sorted(best.items())}
   missing = sorted(codes - set(table))
   assert not missing, f"unresolved IATA codes: {missing}"
   json.dump(table, open("airports.json", "w"), separators=(",", ":"))
   ```
4. Every code must resolve (the `assert`). Copy the result over
   `packages/frontend/src/Applications/FlightTracker/airports.json` and run
   `airports.test.ts`.

Note: OurAirports is *current-day* data. Airport coordinates are effectively
static, so this is fine for 2001 flights; codes that have since moved airports
(none in this dataset as of 2026-07) would need a manual override entry.
