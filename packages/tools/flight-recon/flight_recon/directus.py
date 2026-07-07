"""
Directus REST client for the flight-reconstruction pipeline.

Schema notes
------------
- `flight_tracks.geometry` is a plain ``json`` field holding the GeoJSON
  LineString geometry object. rt911-db is stock postgres:16 without PostGIS,
  so Directus geometry fields (which want real spatial types) are out; JSON
  keeps the track structured and directly renderable by the frontend, and we
  use no server-side spatial operators.
- `reconstruction_runs` uses `run_id` as its primary key and is append-only:
  it is the provenance ledger, never deleted by re-runs.

Idempotency
-----------
Re-runs are made idempotent by `delete_window()` — bulk-delete every
positions/tracks row whose `flight_date` falls inside the window being
reloaded — before inserting. `run_id` alone can't do this (each re-run mints
a new one) and the Directus items API has no upsert on non-PK natural keys.
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
    "flight_positions": {
        # accountability None: skip per-row directus_activity writes — 5x
        # insert throughput on bulk loads, and row-level audit of derived
        # data is noise (provenance lives in reconstruction_runs).
        "meta": {"icon": "flight", "note": "Per-minute reconstructed aircraft positions "
                                           "(BTS On-Time great-circle interpolation)",
                 "accountability": None},
        "fields": [
            {"field": "id", "type": "integer",
             "schema": {"is_primary_key": True, "has_auto_increment": True}},
            {"field": "flight", "type": "string", "schema": {"is_nullable": False}},
            {"field": "carrier", "type": "string"},
            {"field": "flight_date", "type": "date", "schema": {"is_nullable": False}},
            {"field": "utc", "type": "timestamp"},
            {"field": "et_seconds", "type": "integer", "schema": {"is_nullable": False}},
            {"field": "clock_seconds", "type": "integer", "schema": {"is_nullable": False}},
            {"field": "lat", "type": "float"},
            {"field": "lon", "type": "float"},
            {"field": "alt_ft", "type": "integer"},
            {"field": "phase", "type": "string"},
            {"field": "diverted", "type": "boolean"},
            {"field": "run_id", "type": "string", "schema": {"is_nullable": False}},
        ],
    },
    "flight_tracks": {
        "meta": {"icon": "route", "note": "One GeoJSON LineString per reconstructed flight",
                 "accountability": None},
        "fields": [
            {"field": "id", "type": "integer",
             "schema": {"is_primary_key": True, "has_auto_increment": True}},
            {"field": "flight", "type": "string", "schema": {"is_nullable": False}},
            {"field": "flight_date", "type": "date", "schema": {"is_nullable": False}},
            {"field": "origin", "type": "string"},
            {"field": "scheduled_dest", "type": "string"},
            {"field": "landed_at", "type": "string"},
            {"field": "diverted", "type": "boolean"},
            {"field": "wheels_off_utc", "type": "timestamp"},
            {"field": "wheels_on_utc", "type": "timestamp"},
            {"field": "geometry", "type": "json", "meta": _JSON_META},
            {"field": "run_id", "type": "string", "schema": {"is_nullable": False}},
        ],
    },
    "reconstruction_runs": {
        "meta": {"icon": "history", "note": "Provenance ledger for reconstruction runs "
                                            "(append-only)"},
        "fields": [
            {"field": "run_id", "type": "string", "schema": {"is_primary_key": True}},
            {"field": "start", "type": "date"},
            {"field": "end", "type": "date"},
            {"field": "source_file", "type": "string"},
            {"field": "flights_reconstructed", "type": "integer"},
            {"field": "positions_count", "type": "integer"},
            {"field": "tracks_count", "type": "integer"},
            {"field": "skipped_count", "type": "integer"},
            {"field": "skipped", "type": "json", "meta": _JSON_META},
            {"field": "cancelled_by_day", "type": "json", "meta": _JSON_META},
            {"field": "created_at", "type": "timestamp",
             "meta": {"special": ["date-created"], "readonly": True}},
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

    def delete_window(self, collection, start, end):
        """Bulk-delete rows with flight_date in [start, end]. Returns rows deleted."""
        flt = {"flight_date": {"_between": [str(start), str(end)]}}
        total = self.count(collection, flt)
        if total == 0:
            return 0
        log.warning("deleting %d existing rows from %s where flight_date in [%s, %s]",
                    total, collection, start, end)
        for _ in range(DELETE_MAX_PASSES):
            r = self._http.request("DELETE", f"/items/{collection}",
                                   json={"query": {"filter": flt, "limit": -1}})
            _check(r)
            if self.count(collection, flt) == 0:
                return total
            time.sleep(0.5)
        raise RuntimeError(f"{collection}: rows still match window filter after "
                           f"{DELETE_MAX_PASSES} delete passes")

    def insert_many(self, collection, rows, chunk=INSERT_CHUNK, max_bytes=MAX_BATCH_BYTES):
        """Chunked POST /items/{collection}. Returns rows inserted.

        Batches are bounded by BOTH row count and serialized size — rows with
        big json fields (a transcontinental track's geometry is ~6-10 KB)
        blow past Directus's 1 MB payload cap long before `chunk` rows."""
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
                                params={"fields": "id"})
            _check(r)
            log.info("%s: inserted %d/%d", collection, i, len(rows))
        return len(rows)

    def insert_one(self, collection, row):
        r = self._http.post(f"/items/{collection}", json=row)
        _check(r)
        return r.json()["data"]
