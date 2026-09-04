#!/usr/bin/env python3
"""Walk the I3S node tree of showcases_manhattan_buildings/SceneServer,
pruning to an area of interest, and extract real triangle geometry for
buildings whose CNSTRCT_YR is <= YEAR_CUTOFF (or unknown).

Format notes (verified by hand against a live node's binary geometry,
byte-exact match against defaultGeometrySchema):
  header: vertexCount (u32), featureCount (u32)
  then, PerAttributeArray (flat blocks, not interleaved):
    position  (vertexCount * 3 float32) -- LOCAL OFFSET in degrees (x,y)
              and meters (z) from the node's obb.center; vertexCRS is
              plain EPSG:4326, so real_lon = center.lon + x,
              real_lat = center.lat + y, real_height_m = center.z + z.
              No rotation needed -- confirmed by the offsets being tiny
              (~0.01-0.03) degree-scale, not meter-scale, and center
              landing on a real, sane Manhattan point.
    normal    (vertexCount * 3 float32)
    uv0       (vertexCount * 2 float32)
    color     (vertexCount * 4 uint8)
    featureId (featureCount * 1 uint64) -- equals the FeatureServer OBJECTID
              directly (SceneServer declares "featureidMappedFromFS": 0)
    faceRange (featureCount * 2 uint32) -- [firstFace, lastFace] INCLUSIVE,
              contiguous across features; faces are a flat non-indexed
              triangle list (face i = vertices[3i:3i+3]).
"""
import gzip
import json
import math
import struct
import urllib.request
from pathlib import Path

BASE = "https://services2.arcgis.com/cFEFS0EWrhfDeVw9/arcgis/rest/services/showcases_manhattan_buildings/SceneServer/layers/0"
HERE = Path(__file__).parent

YEAR_CUTOFF = 2001
# Lower Manhattan AOI, matching building-recon's existing scope, padded a bit.
AOI = (-74.025, 40.698, -73.998, 40.723)  # minLng, minLat, maxLng, maxLat

Triangle = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw


def fetch_json(url: str) -> dict:
    return json.loads(fetch_bytes(url))


_page_cache: dict[int, list[dict]] = {}


def get_node(index: int) -> dict:
    page = index // 64
    if page not in _page_cache:
        data = fetch_json(f"{BASE}/nodepages/{page}?f=json")
        _page_cache[page] = data["nodes"]
    return _page_cache[page][index % 64]


def obb_lnglat_bbox(node: dict) -> tuple[float, float, float, float]:
    """Approximate AABB (lon/lat) for a node's OBB, generous on purpose --
    only used to prune the tree, never to decide correctness."""
    cx, cy, cz = node["obb"]["center"]
    hx, hy, hz = node["obb"]["halfSize"]
    # halfSize is in meters; convert to a generous degree padding.
    pad_lat = hx / 111_320 + hy / 111_320 + 50 / 111_320
    pad_lng = pad_lat / max(math.cos(math.radians(cy)), 0.1)
    return (cx - pad_lng, cy - pad_lat, cx + pad_lng, cy + pad_lat)


def bbox_overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def find_leaf_nodes_in_aoi(aoi: tuple[float, float, float, float]) -> list[dict]:
    leaves = []
    visited = set()

    def visit(index: int) -> None:
        if index in visited:
            return
        visited.add(index)
        node = get_node(index)
        bbox = obb_lnglat_bbox(node)
        if not bbox_overlaps(bbox, aoi):
            return
        children = node.get("children", [])
        if not children:
            if "mesh" in node:
                leaves.append(node)
            return
        for c in children:
            visit(c)

    visit(0)
    return leaves


def parse_geometry(data: bytes) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int]]]:
    """Returns (positions, [(featureId, firstFace, lastFace), ...])."""
    vertex_count, feature_count = struct.unpack_from("<II", data, 0)
    offset = 8
    positions = struct.unpack_from(f"<{vertex_count * 3}f", data, offset)
    offset += vertex_count * 3 * 4
    offset += vertex_count * 3 * 4  # normal
    offset += vertex_count * 2 * 4  # uv0
    offset += vertex_count * 4  # color
    feature_ids = struct.unpack_from(f"<{feature_count}Q", data, offset)
    offset += feature_count * 8
    face_ranges = struct.unpack_from(f"<{feature_count * 2}I", data, offset)
    offset += feature_count * 2 * 4
    assert offset == len(data), f"parsed {offset}, expected {len(data)}"

    verts = [(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]) for i in range(vertex_count)]
    features = [
        (feature_ids[i], face_ranges[i * 2], face_ranges[i * 2 + 1])
        for i in range(feature_count)
    ]
    return verts, features


def extract(aoi: tuple[float, float, float, float] = AOI, year_cutoff: int = YEAR_CUTOFF) -> list[Triangle]:
    attrs: dict[str, int | None] = json.loads((HERE / "attributes.json").read_text())
    year_by_id = {int(k): v for k, v in attrs.items()}

    print("finding leaf nodes in AOI ...")
    leaves = find_leaf_nodes_in_aoi(aoi)
    print(f"{len(leaves)} leaf nodes with geometry in AOI")

    all_tris: list[Triangle] = []
    kept_buildings = set()
    skipped_buildings = set()

    for i, node in enumerate(leaves):
        cx, cy, cz = node["obb"]["center"]
        resource = node["mesh"]["geometry"]["resource"]
        geom_bytes = fetch_bytes(f"{BASE}/nodes/{resource}/geometries/0")
        local_verts, features = parse_geometry(geom_bytes)
        real_verts = [(cx + vx, cy + vy, cz + vz) for vx, vy, vz in local_verts]

        for feature_id, first_face, last_face in features:
            year = year_by_id.get(feature_id)
            if year is not None and year > year_cutoff:
                skipped_buildings.add(feature_id)
                continue
            kept_buildings.add(feature_id)
            for face in range(first_face, last_face + 1):
                a = real_verts[face * 3]
                b = real_verts[face * 3 + 1]
                c = real_verts[face * 3 + 2]
                all_tris.append((a, b, c))
        print(f"  [{i + 1}/{len(leaves)}] node {node['index']}: {len(features)} features, {len(all_tris)} tris so far")

    print(f"kept {len(kept_buildings)} buildings, skipped {len(skipped_buildings)} (post-{year_cutoff})")
    print(f"total triangles: {len(all_tris)}")
    return all_tris


if __name__ == "__main__":
    tris = extract()
    import pickle
    with open(HERE / "extracted_tris.pkl", "wb") as f:
        pickle.dump(tris, f)
    print(f"saved {len(tris)} triangles to extracted_tris.pkl")
