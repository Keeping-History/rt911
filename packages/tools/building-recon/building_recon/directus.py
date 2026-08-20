"""
Directus REST client for the building-footprint reconstruction pipeline.

Schema notes
------------
- `buildings.geometry` is a plain ``json`` field holding the GeoJSON Polygon
  geometry object. rt911-db is stock postgres:16 without PostGIS, so Directus
  geometry fields (which want real spatial types) are out; JSON keeps the
  footprint structured and directly renderable by the frontend, and we use no
  server-side spatial operators.

Idempotency
-----------
Unlike flight-recon (windowed by `flight_date`), `buildings` is a single
whole-collection snapshot: there is no natural partition to re-load by
window, so re-runs are made idempotent by `delete_all()` — bulk-delete every
row in the collection — before inserting the freshly assembled set.
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
# required"). Discovered empirically against directus:latest, 2026-07-07
# (see flight-recon/flight_recon/directus.py).
_JSON_META = {"special": ["cast-json"], "interface": "input-code"}

COLLECTIONS = {
    "buildings": {
        # accountability None: skip per-row directus_activity writes — 5x
        # insert throughput on bulk loads; this is a bulk-replaced snapshot,
        # not audited edit history.
        "meta": {"icon": "domain", "note": "2001 building footprints (height, base "
                                            "elevation, footprint geometry)",
                 "accountability": None},
        "fields": [
            {"field": "id", "type": "integer",
             "schema": {"is_primary_key": True, "has_auto_increment": True}},
            {"field": "area", "type": "string", "schema": {"is_nullable": False}},
            {"field": "source", "type": "string"},
            {"field": "name", "type": "string", "schema": {"is_nullable": True}},
            {"field": "height_m", "type": "float", "schema": {"is_nullable": False}},
            {"field": "base_elevation_m", "type": "float", "schema": {"is_nullable": False}},
            {"field": "cnstrct_yr", "type": "integer", "schema": {"is_nullable": True}},
            {"field": "is_hero", "type": "boolean", "schema": {"default_value": False}},
            {"field": "geometry", "type": "json", "meta": _JSON_META},
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
    def count(self, collection):
        r = self._http.get(f"/items/{collection}", params={"aggregate[count]": "*"})
        _check(r)
        return int(r.json()["data"][0]["count"])

    def _clear_cache(self):
        """Flush Directus's response cache. This deployment runs
        CACHE_AUTO_PURGE=false, so a mutating DELETE does NOT invalidate the
        cached aggregate-count that delete_all's verify loop reads below —
        without a flush, count() returns a stale pre-delete value forever and
        the loop raises after DELETE_MAX_PASSES even though the rows are gone.
        A `Cache-Control: no-store` header (CACHE_SKIP_ALLOWED is off) and
        cache-busting query params (stripped from the cache key) are both
        ignored by this instance, so an explicit clear is the only reliable
        bust. Best-effort: if the clear is unavailable the loop still
        terminates via its pass cap, just as before this fix."""
        try:
            _check(self._http.post("/utils/cache/clear"))
        except httpx.HTTPError as e:
            log.warning("Directus cache clear failed (%s); a stale cached count "
                        "may make delete_all loop to its pass cap", e)

    def delete_all(self, collection):
        """Bulk-delete every row in `collection`. Returns rows deleted."""
        self._clear_cache()  # fresh initial count: a stale 0 would skip a real delete
        total = self.count(collection)
        if total == 0:
            return 0
        log.warning("deleting %d existing rows from %s", total, collection)
        for _ in range(DELETE_MAX_PASSES):
            r = self._http.request("DELETE", f"/items/{collection}",
                                   json={"query": {"limit": -1}})
            _check(r)
            self._clear_cache()  # DELETE doesn't auto-purge → bust before re-counting
            if self.count(collection) == 0:
                return total
            time.sleep(0.5)
        raise RuntimeError(f"{collection}: rows remain after {DELETE_MAX_PASSES} delete passes")

    def insert_many(self, collection, rows, chunk=INSERT_CHUNK, max_bytes=MAX_BATCH_BYTES):
        """Chunked POST /items/{collection}. Returns rows inserted.

        Batches are bounded by BOTH row count and serialized size — rows with
        big json fields (a large building's geometry can run several KB) blow
        past Directus's 1 MB payload cap long before `chunk` rows."""
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


def rows_from_features(feats: list[dict]) -> list[dict]:
    """Map assembled FeatureCollection features (`{geometry, properties}`) to
    `buildings` rows.

    The frontend-contract properties only carry `area`/`height_m`/
    `base_elevation_m` (see build_2001.build_feature_collection) — `source`,
    `name`, and `cnstrct_yr` are not part of that contract, so they're read
    opportunistically and omitted (not sent as null) when absent."""
    rows = []
    for feat in feats:
        props = feat["properties"]
        row = {
            "area": props["area"],
            "height_m": props["height_m"],
            "base_elevation_m": props["base_elevation_m"],
            "is_hero": False,
            "geometry": feat["geometry"],
        }
        if "source" in props:
            row["source"] = props["source"]
        if "name" in props:
            row["name"] = props["name"]
        if "cnstrct_yr" in props:
            row["cnstrct_yr"] = props["cnstrct_yr"]
        rows.append(row)
    return rows


def rows_from_building_features(feats: list[dict]) -> list[dict]:
    """Map the RICH feature list from `build_2001.assemble` (`ring`/`height_m`/
    `base_elevation_m`/`area`/`source`/`name`/`cnstrct_yr`, not a GeoJSON
    `geometry`/`properties` split) to `buildings` rows.

    This is what makes the Directus store canonical: unlike
    `rows_from_features` (which reads the frontend-contract FeatureCollection
    and so never sees `source`/`name`/`cnstrct_yr`), this reads the pre-strip
    feature dicts, so those columns are always populated."""
    rows = []
    for feat in feats:
        ring = [[float(x), float(y)] for x, y in feat["ring"]]
        if ring and ring[0] != ring[-1]:
            ring = [*ring, ring[0]]
        rows.append({
            "area": feat["area"],
            "source": feat.get("source"),
            "name": feat.get("name"),
            "height_m": feat["height_m"],
            "base_elevation_m": feat["base_elevation_m"],
            "cnstrct_yr": feat.get("cnstrct_yr"),
            "is_hero": False,
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return rows


def load_buildings(client: DirectusClient, rows: list[dict]) -> dict:
    """Ensure the `buildings` collection exists, replace its contents with
    `rows`, and verify the count. Returns `{"inserted": n}`."""
    client.ensure_collection("buildings")
    client.delete_all("buildings")
    client._clear_cache()
    client.insert_many("buildings", rows)
    client._clear_cache()
    n = client.count("buildings")
    if n != len(rows):
        raise RuntimeError(f"buildings: post-load count {n} != expected {len(rows)}")
    return {"inserted": n}
