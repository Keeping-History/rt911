"""Fetch + parse building footprints from the open-data portals (NYC + Arlington).

Each parse_* is a pure adapter (raw source payload -> RawBuilding dicts); only
fetch_source touches the network. AOI filtering drops anything outside the two
impact-zone boxes so downstream work stays small.

Sources (field names + geometry confirmed against live metadata 2026-07-24):
  - NYC       : Socrata 5zhs-2jue (Building Footprints). Fields height_roof (ft),
                construction_year, ground_elevation (ft). Geometry MULTIPOLYGON.
  - Arlington : od_Building_Height_Polygons ("Building Heights"). Fields
                Est_Building_Height_ft (ft), Est_Ground_Elevation_ft (ft); NO
                construction year. Geometry Polygon. Covers the Pentagon
                (~77 ft) — the impact landmark for that AOI.

DC was dropped: the Pentagon is in Arlington, VA, so DC footprints (east of the
Potomac) fall entirely outside the pentagon AOI and contribute nothing.
"""
import httpx
from prefect import task
from building_recon import aoi

NETWORK_RETRIES = dict(retries=4, retry_delay_seconds=15, retry_jitter_factor=0.3)
FT_TO_M = 0.3048

# Arlington's ArcGIS server (arlgis.arlingtonva.us) sits behind a WAF that 404s
# the default python-httpx User-Agent; a browser-like UA is required. Harmless
# for the NYC Socrata endpoint, which accepts either.
_USER_AGENT = "Mozilla/5.0 (compatible; building-recon/1.0; +https://911realtime.org)"


def _outer_ring(geom: dict) -> list | None:
    """Outer ring ([[lng, lat], ...]) from a Polygon, or the first sub-polygon's
    outer ring of a MultiPolygon (NYC returns MultiPolygon). None otherwise."""
    coords = geom.get("coordinates")
    if not coords:
        return None
    t = geom.get("type")
    if t == "Polygon":
        return coords[0]
    if t == "MultiPolygon":
        return coords[0][0]
    return None


def _first_vertex(geom: dict) -> tuple[float, float] | None:
    ring = _outer_ring(geom)
    if not ring:
        return None
    return float(ring[0][0]), float(ring[0][1])


def _features(payload: dict) -> list[dict]:
    return payload.get("features", []) if isinstance(payload, dict) else []


def _present(v) -> bool:
    return v not in (None, "")


def parse_nyc(payload: dict) -> list[dict]:
    out = []
    for feat in _features(payload):
        geom = feat.get("geometry") or {}
        ring = _outer_ring(geom)
        if not ring or not aoi.point_in_aoi(float(ring[0][0]), float(ring[0][1]), "manhattan"):
            continue
        p = feat.get("properties", {})
        ge = p.get("ground_elevation")
        yr = p.get("construction_year")
        out.append({
            "ring": [[float(x), float(y)] for x, y in ring],
            "height_ft": float(p["height_roof"]) if _present(p.get("height_roof")) else None,
            "height_m": None,
            "base_elevation_m": float(ge) * FT_TO_M if _present(ge) else 0.0,
            "cnstrct_yr": int(float(yr)) if _present(yr) and str(yr) != "0" else None,
            "area": "manhattan",
            "source": "nyc",
            "name": p.get("name") or None,
        })
    return out


def parse_arlington(payload: dict) -> list[dict]:
    """Arlington 'Building Heights': footprints with height + ground elevation in
    FEET, no construction year (unknown-year is kept by the 2001 filter)."""
    out = []
    for feat in _features(payload):
        geom = feat.get("geometry") or {}
        ring = _outer_ring(geom)
        if not ring or not aoi.point_in_aoi(float(ring[0][0]), float(ring[0][1]), "pentagon"):
            continue
        p = feat.get("properties", {})
        h = p.get("Est_Building_Height_ft")
        ge = p.get("Est_Ground_Elevation_ft")
        out.append({
            "ring": [[float(x), float(y)] for x, y in ring],
            "height_ft": float(h) if _present(h) else None,
            "height_m": None,
            "base_elevation_m": float(ge) * FT_TO_M if _present(ge) else 0.0,
            "cnstrct_yr": None,  # layer carries no construction year
            "area": "pentagon",
            "source": "arlington",
            "name": None,
        })
    return out


def _bbox_query(url: str, bbox: tuple, source: str) -> str:
    mn_lng, mn_lat, mx_lng, mx_lat = bbox
    if source == "nyc":  # Socrata within_box(the_geom, north_lat, west_lng, south_lat, east_lng)
        where = f"within_box(the_geom,{mx_lat},{mn_lng},{mn_lat},{mx_lng})"
        return f"{url}?$where={where}&$limit=50000"
    # ArcGIS REST envelope query returning GeoJSON in WGS84.
    env = f"{mn_lng},{mn_lat},{mx_lng},{mx_lat}"
    return (f"{url}/query?geometry={env}&geometryType=esriGeometryEnvelope&inSR=4326"
            f"&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326"
            f"&resultRecordCount=5000&f=geojson")


ARLINGTON_URL = ("https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/"
                 "od_Building_Height_Polygons/FeatureServer/0")

SOURCES: dict[str, dict] = {
    "nyc": {
        "url": "https://data.cityofnewyork.us/resource/5zhs-2jue.geojson",
        "area": "manhattan",
        "parse": parse_nyc,
    },
    "arlington": {"url": ARLINGTON_URL, "area": "pentagon", "parse": parse_arlington},
}


@task(**NETWORK_RETRIES)
def fetch_source(name: str, client: httpx.Client | None = None) -> list[dict]:
    spec = SOURCES[name]
    own = client is None
    client = client or httpx.Client(
        timeout=120.0,
        headers={"User-Agent": _USER_AGENT},
        follow_redirects=True,
    )
    try:
        url = _bbox_query(spec["url"], aoi.AOIS[spec["area"]]["bbox"], name)
        resp = client.get(url)
        resp.raise_for_status()
        return spec["parse"](resp.json())
    finally:
        if own:
            client.close()
