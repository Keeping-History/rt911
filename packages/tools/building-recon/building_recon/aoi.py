"""Areas of interest: the two 9/11 impact zones, as lng/lat bounding boxes."""

# (min_lng, min_lat, max_lng, max_lat). Generous margins around each impact
# zone; buildings outside these boxes are never fetched.
AOIS: dict[str, dict] = {
    # Lower Manhattan: Battery Park up past the WTC site / City Hall.
    "manhattan": {"bbox": (-74.0200, 40.7010, -74.0020, 40.7200)},
    # Pentagon + immediate Arlington surroundings.
    "pentagon": {"bbox": (-77.0640, 38.8650, -77.0480, 38.8760)},
}


def point_in_aoi(lng: float, lat: float, area: str) -> bool:
    mn_lng, mn_lat, mx_lng, mx_lat = AOIS[area]["bbox"]
    return mn_lng <= lng <= mx_lng and mn_lat <= lat <= mx_lat


def area_for_point(lng: float, lat: float) -> str | None:
    for area in AOIS:
        if point_in_aoi(lng, lat, area):
            return area
    return None
