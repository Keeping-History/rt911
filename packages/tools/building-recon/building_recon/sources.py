"""Fetch + parse building footprints from the three open-data portals.

Each parse_* is a pure adapter (raw source payload -> RawBuilding dicts); only
fetch_source touches the network. AOI filtering drops anything outside the two
impact-zone boxes so downstream work stays small.
"""
import os
import httpx
from prefect import task
from building_recon import aoi

NETWORK_RETRIES = dict(retries=4, retry_delay_seconds=15, retry_jitter_factor=0.3)
FT_TO_M = 0.3048


def _first_vertex(geom: dict) -> tuple[float, float] | None:
    if geom.get("type") != "Polygon":
        return None
    ring = (geom.get("coordinates") or [[]])[0]
    if not ring:
        return None
    x, y = ring[0][0], ring[0][1]
    return float(x), float(y)


def _features(payload: dict) -> list[dict]:
    return payload.get("features", []) if isinstance(payload, dict) else []


def parse_nyc(payload: dict) -> list[dict]:
    out = []
    for feat in _features(payload):
        geom = feat.get("geometry") or {}
        v = _first_vertex(geom)
        if not v or not aoi.point_in_aoi(v[0], v[1], "manhattan"):
            continue
        p = feat.get("properties", {})
        ge = p.get("groundelev")
        out.append({
            "ring": [[float(x), float(y)] for x, y in geom["coordinates"][0]],
            "height_ft": float(p["heightroof"]) if p.get("heightroof") not in (None, "") else None,
            "height_m": None,
            "base_elevation_m": float(ge) * FT_TO_M if ge not in (None, "") else 0.0,
            "cnstrct_yr": int(p["cnstrct_yr"]) if p.get("cnstrct_yr") not in (None, "", "0") else None,
            "area": "manhattan",
            "source": "nyc",
            "name": p.get("name") or None,
        })
    return out


def _parse_arcgis(payload: dict, area: str, source: str, height_field: str, year_field: str | None) -> list[dict]:
    out = []
    for feat in _features(payload):
        geom = feat.get("geometry") or {}
        v = _first_vertex(geom)
        if not v or not aoi.point_in_aoi(v[0], v[1], area):
            continue
        p = feat.get("properties", {})
        h = p.get(height_field)
        yr = p.get(year_field) if year_field else None
        out.append({
            "ring": [[float(x), float(y)] for x, y in geom["coordinates"][0]],
            "height_m": float(h) if h not in (None, "") else None,   # DC/Arlington heights already meters (confirm)
            "height_ft": None,
            "base_elevation_m": 0.0,
            "cnstrct_yr": int(yr) if yr not in (None, "", 0) else None,
            "area": area,
            "source": source,
            "name": p.get("name") or None,
        })
    return out


def parse_dc(payload: dict) -> list[dict]:
    # Confirm the exact height + year field names against the DC layer metadata.
    return _parse_arcgis(payload, "pentagon", "dc", height_field="height_m", year_field="year_built")


def parse_arlington(payload: dict) -> list[dict]:
    return _parse_arcgis(payload, "pentagon", "arlington", height_field="height_m", year_field="year_built")


def _bbox_query(url: str, bbox: tuple, source: str) -> str:
    mn_lng, mn_lat, mx_lng, mx_lat = bbox
    if source == "nyc":  # Socrata within_box(the_geom, north_lat, west_lng, south_lat, east_lng)
        where = f"within_box(the_geom,{mx_lat},{mn_lng},{mn_lat},{mx_lng})"
        return f"{url}?$where={where}&$limit=50000"
    # ArcGIS REST envelope query returning GeoJSON.
    env = f"{mn_lng},{mn_lat},{mx_lng},{mx_lat}"
    return (f"{url}/query?geometry={env}&geometryType=esriGeometryEnvelope"
            f"&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&f=geojson")


SOURCES: dict[str, dict] = {
    "nyc": {"url": "https://data.cityofnewyork.us/resource/5zhs-2jue.geojson", "area": "manhattan", "parse": parse_nyc},
    "dc": {"url": os.environ.get("DC_BUILDINGS_URL", ""), "area": "pentagon", "parse": parse_dc},
    "arlington": {"url": os.environ.get("ARLINGTON_BUILDINGS_URL", ""), "area": "pentagon", "parse": parse_arlington},
}


@task(**NETWORK_RETRIES)
def fetch_source(name: str, client: httpx.Client | None = None) -> list[dict]:
    spec = SOURCES[name]
    own = client is None
    client = client or httpx.Client(timeout=120.0)
    try:
        url = _bbox_query(spec["url"], aoi.AOIS[spec["area"]]["bbox"], name)
        resp = client.get(url)
        resp.raise_for_status()
        return spec["parse"](resp.json())
    finally:
        if own:
            client.close()
