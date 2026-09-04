#!/usr/bin/env python3
"""Fetch OBJECTID -> CNSTRCT_YR for every building via the companion
FeatureServer (the SceneServer's own /query endpoint returns "Invalid URL"
for this service; the sibling FeatureServer at the same base path works
and shares the same OBJECTID space -- confirmed via the SceneServer's own
"featureidMappedFromFS": 0 declaration)."""
import json
import time
import urllib.request
from pathlib import Path

BASE = "https://services2.arcgis.com/cFEFS0EWrhfDeVw9/arcgis/rest/services/showcases_manhattan_buildings/FeatureServer/0"
PAGE_SIZE = 2000
OUT = Path(__file__).parent / "attributes.json"


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req) as resp:
        import gzip
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw)


def main() -> None:
    count = fetch(f"{BASE}/query?f=json&where=1=1&returnCountOnly=true")["count"]
    print(f"total buildings: {count}")

    attrs: dict[int, int | None] = {}
    offset = 0
    while offset < count:
        url = (
            f"{BASE}/query?f=json&where=1=1&outFields=OBJECTID,CNSTRCT_YR"
            f"&returnGeometry=false&resultOffset={offset}&resultRecordCount={PAGE_SIZE}&orderByFields=OBJECTID"
        )
        data = fetch(url)
        feats = data["features"]
        for f in feats:
            a = f["attributes"]
            attrs[a["OBJECTID"]] = a["CNSTRCT_YR"]
        offset += len(feats)
        print(f"  fetched {offset}/{count}")
        if not feats:
            break
        time.sleep(0.05)

    OUT.write_text(json.dumps(attrs))
    print(f"wrote {OUT} ({len(attrs)} entries)")


if __name__ == "__main__":
    main()
