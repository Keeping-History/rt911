"""Pure transforms for the 2001 building-footprint pipeline.

No network, DB, or S3 here — everything in this module is a deterministic
function of its inputs so it is unit-testable without external services.
building_recon/flow.py wires these to the I/O modules.
"""

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
        })
    return out
