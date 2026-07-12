"""
Directus REST client for the weather pipeline (issue #184).

Ported from flight_recon.directus (same server, same gotchas):
- json-typed fields MUST carry the cast-json special (none yet in these
  collections, but keep _JSON_META for the Phase 2 fields that will).
- insert_many is bounded by row count AND serialized bytes (1 MB payload cap).

Idempotency: weather_stations is a ~190-row reference table keyed by ICAO —
re-loads do delete_all + insert. Phase 2 flows will add windowed deletes for
observations/forecasts when they land.
"""

import json
import logging
import time

import httpx

log = logging.getLogger(__name__)

INSERT_CHUNK = 2000        # row-count bound per request
MAX_BATCH_BYTES = 700_000  # size bound: Directus MAX_PAYLOAD_SIZE defaults to 1 MB
DELETE_MAX_PASSES = 50     # QUERY_LIMIT_MAX may cap a bulk delete; loop until empty

# json-typed fields MUST carry the cast-json special: without it Directus
# rejects the whole collection payload with an opaque 400 ("collection/field
# required"). Discovered empirically against directus:latest, 2026-07-07.
_JSON_META = {"special": ["cast-json"], "interface": "input-code"}

COLLECTIONS = {
    "weather_stations": {
        "meta": {"icon": "cloud", "note": "Curated US/CA/MX METAR stations "
                                          "(reference table, ICAO-keyed)",
                 "accountability": None},
        "fields": [
            {"field": "station_id", "type": "string",
             "schema": {"is_primary_key": True}},
            {"field": "name", "type": "string", "schema": {"is_nullable": False}},
            {"field": "lat", "type": "float", "schema": {"is_nullable": False}},
            {"field": "lon", "type": "float", "schema": {"is_nullable": False}},
            {"field": "elevation_m", "type": "float"},
            {"field": "country", "type": "string", "schema": {"is_nullable": False}},
            {"field": "tz", "type": "string", "schema": {"is_nullable": False}},
            {"field": "isd_id", "type": "string", "schema": {"is_nullable": False}},
            {"field": "wfo", "type": "string"},
            {"field": "nws_zone", "type": "string"},
        ],
    },
    "weather_observations": {
        "meta": {"icon": "thermostat", "note": "Hourly METAR/ISD surface observations, "
                                               "2001-09-09..12 (loaded by Phase 2)",
                 "accountability": None},
        "fields": [
            {"field": "id", "type": "integer",
             "schema": {"is_primary_key": True, "has_auto_increment": True}},
            {"field": "station_id", "type": "string", "schema": {"is_nullable": False}},
            {"field": "observed_at", "type": "timestamp",
             "schema": {"is_nullable": False}},
            {"field": "temp_c", "type": "float"},
            {"field": "dewpoint_c", "type": "float"},
            {"field": "wind_dir_deg", "type": "integer"},
            {"field": "wind_speed_kt", "type": "float"},
            {"field": "gust_kt", "type": "float"},
            {"field": "pressure_hpa", "type": "float"},
            {"field": "sky_condition", "type": "string"},
            {"field": "present_weather", "type": "string"},
            {"field": "visibility_km", "type": "float"},
            {"field": "raw_metar", "type": "text"},
            {"field": "run_id", "type": "string"},
        ],
    },
    "weather_forecasts": {
        "meta": {"icon": "wb_sunny", "note": "Archived NWS forecast text products "
                                             "(ZFP/AFD), 2001-09 (loaded by Phase 2)",
                 "accountability": None},
        "fields": [
            {"field": "id", "type": "integer",
             "schema": {"is_primary_key": True, "has_auto_increment": True}},
            {"field": "wfo", "type": "string"},
            {"field": "zone", "type": "string"},
            {"field": "product_type", "type": "string"},
            {"field": "issued_at", "type": "timestamp", "schema": {"is_nullable": False}},
            {"field": "raw_text", "type": "text", "schema": {"is_nullable": False}},
            {"field": "run_id", "type": "string"},
        ],
    },
}


def _check(r):
    """raise_for_status, but keep Directus's error body — it names the invalid
    field, which the bare status line never does."""
    if r.status_code >= 400:
        raise httpx.HTTPStatusError(
            f"Directus {r.request.method} {r.request.url.path} -> "
            f"{r.status_code}: {r.text[:500]}",
            request=r.request, response=r)
    return r


class DirectusClient:
    def __init__(self, base_url, token, timeout=60.0):
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    def close(self):
        self._http.close()

    # ------------------------------------------------------------ schema
    def collection_exists(self, name):
        # Directus answers 403 (not 404) for unknown collections on some
        # policies, so treat any non-200 as "missing".
        return self._http.get(f"/collections/{name}").status_code == 200

    def existing_fields(self, collection):
        r = self._http.get(f"/fields/{collection}")
        _check(r)
        return {f["field"] for f in r.json()["data"]}

    def ensure_collection(self, name):
        """Create `name` (and any missing fields) per COLLECTIONS. Returns
        a list of human-readable actions taken (empty = already in shape)."""
        spec = COLLECTIONS[name]
        actions = []
        if not self.collection_exists(name):
            r = self._http.post("/collections", json={
                "collection": name,
                "meta": spec["meta"],
                "schema": {},
                "fields": spec["fields"],
            })
            _check(r)
            actions.append(f"created collection {name} with {len(spec['fields'])} fields")
            return actions
        have = self.existing_fields(name)
        for f in spec["fields"]:
            if f["field"] not in have:
                r = self._http.post(f"/fields/{name}", json=f)
                _check(r)
                actions.append(f"added field {name}.{f['field']}")
        return actions

    # ------------------------------------------------------------ items
    def count(self, collection, flt):
        r = self._http.get(f"/items/{collection}", params={
            "aggregate[count]": "*", "filter": json.dumps(flt)})
        _check(r)
        return int(r.json()["data"][0]["count"])

    def delete_all(self, collection):
        """Delete every row (reference-table reload). Returns rows deleted."""
        pk = next(f["field"] for f in COLLECTIONS[collection]["fields"]
                  if f.get("schema", {}).get("is_primary_key"))
        flt = {pk: {"_nnull": True}}
        total = self.count(collection, flt)
        if total == 0:
            return 0
        log.warning("deleting all %d rows from %s before reload", total, collection)
        for _ in range(DELETE_MAX_PASSES):
            r = self._http.request("DELETE", f"/items/{collection}",
                                   json={"query": {"filter": flt, "limit": -1}})
            _check(r)
            if self.count(collection, flt) == 0:
                return total
            time.sleep(0.5)
        raise RuntimeError(f"{collection}: rows remain after {DELETE_MAX_PASSES} "
                           f"delete passes")

    def insert_many(self, collection, rows, chunk=INSERT_CHUNK, max_bytes=MAX_BATCH_BYTES):
        """Chunked POST /items/{collection}. Returns rows inserted.

        Batches are bounded by BOTH row count and serialized size — rows with
        big json fields (a transcontinental track's geometry is ~6-10 KB)
        blow past Directus's 1 MB payload cap long before `chunk` rows."""
        pk = next(f["field"] for f in COLLECTIONS[collection]["fields"]
                  if f.get("schema", {}).get("is_primary_key"))
        i = 0
        while i < len(rows):
            batch, size = [], 2  # brackets
            while i < len(rows) and len(batch) < chunk:
                row_bytes = len(json.dumps(rows[i], default=str)) + 1
                if batch and size + row_bytes > max_bytes:
                    break
                batch.append(rows[i])
                size += row_bytes
                i += 1
            r = self._http.post(f"/items/{collection}", json=batch,
                                params={"fields": pk})
            _check(r)
            log.info("%s: inserted %d/%d", collection, i, len(rows))
        return len(rows)

    def insert_one(self, collection, row):
        r = self._http.post(f"/items/{collection}", json=row)
        _check(r)
        return r.json()["data"]
