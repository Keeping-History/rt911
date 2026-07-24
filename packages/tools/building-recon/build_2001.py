"""Pure transforms for the 2001 building-footprint pipeline.

No network, DB, or S3 here — everything in this module is a deterministic
function of its inputs so it is unit-testable without external services.
building_recon/flow.py wires these to the I/O modules.
"""

import json
import os

FT_TO_M = 0.3048
CUTOFF_YEAR = 2001


def to_height_m(raw: dict) -> float | None:
    """Height in meters: explicit meters win, else feet->meters, else None."""
    if raw.get("height_m") is not None:
        return float(raw["height_m"])
    if raw.get("height_ft") is not None:
        return float(raw["height_ft"]) * FT_TO_M
    return None


def keep_for_2001(raw: dict) -> bool:
    """Keep a building for the 2001 skyline.

    Drop only buildings we KNOW were built after 2001. A missing construction
    year is kept: the vast majority of unknown-year footprints in these two
    zones predate 2001, and demolished-since structures we care about are added
    back explicitly (the WTC complex), never inferred from a null year.
    """
    yr = raw.get("cnstrct_yr")
    return yr is None or int(yr) <= CUTOFF_YEAR


def normalize(raws: list[dict]) -> list[dict]:
    """Filter to the 2001 state and produce metric, height-bearing features."""
    out: list[dict] = []
    for raw in raws:
        if not keep_for_2001(raw):
            continue
        h = to_height_m(raw)
        if h is None or h <= 0:
            continue
        out.append({
            "ring": raw["ring"],
            "height_m": h,
            "base_elevation_m": float(raw.get("base_elevation_m") or 0.0),
            "area": raw["area"],
            "source": raw.get("source", "unknown"),
            "name": raw.get("name"),
            "cnstrct_yr": raw.get("cnstrct_yr"),
        })
    return out


_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_WTC_PATH = os.path.join(_DATA_DIR, "wtc_complex_2001.geojson")


def load_wtc_complex(path: str | None = None) -> list[dict]:
    """The curated WTC complex as RawBuilding dicts (already metric)."""
    with open(path or _WTC_PATH) as fh:
        fc = json.load(fh)
    out: list[dict] = []
    for feat in fc["features"]:
        ring = feat["geometry"]["coordinates"][0]
        props = feat.get("properties", {})
        out.append({
            "ring": [[float(x), float(y)] for x, y in ring],
            "height_m": float(props["height_m"]),
            "base_elevation_m": float(props.get("base_elevation_m", 0.0)),
            "area": "manhattan",
            "source": "wtc-curated",
            "name": props.get("name"),
        })
    return out


def _closed(ring: list[list[float]]) -> list[list[float]]:
    if ring and ring[0] != ring[-1]:
        return [*ring, ring[0]]
    return ring


def build_feature_collection(features: list[dict]) -> dict:
    """Assemble the frontend-contract FeatureCollection (Polygon + 3 props)."""
    out_feats = []
    for f in features:
        out_feats.append({
            "type": "Feature",
            "properties": {
                "height_m": f["height_m"],
                "base_elevation_m": f["base_elevation_m"],
                "area": f["area"],
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [_closed([[float(x), float(y)] for x, y in f["ring"]])],
            },
        })
    return {"type": "FeatureCollection", "features": out_feats}


def assemble(source_raws: list[dict], wtc: list[dict]) -> tuple[dict, list[dict], dict]:
    """Normalize sources, append the curated WTC, build the FeatureCollection.

    Returns `(feature_collection, feats, summary)`: `feature_collection` is the
    frontend-contract GeoJSON (only `height_m`/`base_elevation_m`/`area`
    properties, unchanged); `feats` is the rich feature list (also carrying
    `ring`/`source`/`name`/`cnstrct_yr`) so callers can populate the canonical
    Directus store without stripping it down to the frontend's 3 properties.
    """
    feats = normalize(source_raws) + list(wtc)
    fc = build_feature_collection(feats)
    by_source: dict[str, int] = {}
    by_area: dict[str, int] = {}
    for f in feats:
        by_source[f["source"]] = by_source.get(f["source"], 0) + 1
        by_area[f["area"]] = by_area.get(f["area"], 0) + 1
    summary = {"total": len(feats), "by_source": by_source, "by_area": by_area}
    return fc, feats, summary
