"""
Dev-run: add wfo + nws_zone columns to data/stations.csv.

    python scripts/enrich_stations.py          # uses caches under data/enrich-cache/
    python scripts/enrich_stations.py --refresh

Per US station: WFO from api.weather.gov points (cached JSON; reliable), then
the 2001 zone resolved against that WFO's archived ZFP segments (cached AFOS
text) via weather_recon.zone_resolve. CA/MX stations get empty wfo/nws_zone.
Unresolved stations are listed at exit (curate ZONE_OVERRIDES; exit 1 until
every US station resolves).
"""

import csv
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from weather_recon.afos import split_products, split_segments  # noqa: E402
from weather_recon.stations import load_stations  # noqa: E402
from weather_recon.zone_resolve import resolve_zone  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CSV = ROOT / "data" / "stations.csv"
CACHE = ROOT / "data" / "enrich-cache"
FIELDS = ["station_id", "name", "lat", "lon", "elevation_m", "country", "tz",
          "isd_id", "wfo", "nws_zone"]
UA = {"User-Agent": "rt911-weather-recon (me@robbiebyrd.com)"}
AFOS = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"

# Hand-curated results for stations the automated resolution can't place.
# Populate ONLY from reading the archived product text. ICAO -> (wfo, zone).
#
# KJFK/KLGA (Queens) and KEWR (Newark/Essex Co, NJ): OKX's Sept-2001 ZFP
# always bundles the 5 NYC boroughs + adjacent NJ counties into combined
# segments (e.g. "NJZ005-006-011-NYZ072>077-" / "BRONX-ESSEX-HUDSON-KINGS
# (BROOKLYN)-NASSAU-NEW YORK (MANHATTAN)-QUEENS-RICHMOND (STATEN ISLAND)-
# UNION-"), so the name-list order (alphabetical) never lines up positionally
# with the UGC zone-code order (numeric per state prefix) -- taking
# segment.zones[0] would silently pick the wrong county/state. The actual
# NYZ/NJZ <-> county mapping was confirmed from real *single- or double-zone*
# ZFPOKX segments elsewhere in the archived 2001 stream (same office, same
# UGC scheme all year, so the id is stable even though the specific day
# differs): "NYZ075-076-210853-" / "KINGS (BROOKLYN)-QUEENS-" (Oct 20 2001)
# -> NYZ076 = Queens (JFK, LaGuardia); a single-zone "NJZ005-...-" / "ESSEX-"
# segment -> NJZ005 = Essex Co NJ (Newark/EWR).
ZONE_OVERRIDES: dict[str, tuple[str, str]] = {
    "KJFK": ("OKX", "NYZ076"),
    "KLGA": ("OKX", "NYZ076"),
    "KEWR": ("OKX", "NJZ005"),
    # The remaining stations below have station *names* that don't literally
    # share a token with their WFO's area-name headers (e.g. "PAGE FIELD
    # AIRPORT" vs. "LEE"), so the automated name-match scores 0 even though
    # the WFO's archive has real content. Each zone id was confirmed from a
    # single- or 2-zone ZFP segment for the same office elsewhere in the
    # archived 2001 stream (stable UGC scheme all year):
    # "CAZ007-131100-" / "ALAMEDA AND CONTRA COSTA COUNTIES-" (ZFPMTR, in
    # the Sept window, line ~605 of the cache).
    "KOAK": ("MTR", "CAZ007"),
    # "CAZ008-122300-" / "SANTA CLARA COUNTY-" (ZFPMTR, Sept window).
    "KSJC": ("MTR", "CAZ008"),
    # "MTZ012-302300-" / "CASCADE-" (ZFPTFX, Dec 30 2001 issuance).
    "KGTF": ("TFX", "MTZ012"),
    # "MTZ014-281100-" / "SOUTHERN LEWIS AND CLARK-" (ZFPTFX, Dec 27 2001).
    "KHLN": ("TFX", "MTZ014"),
    # "IDZ020-311130-" / "UPPER SNAKE RIVER PLAIN-", temp table lists IDAHO
    # FALLS/REXBURG under this zone (ZFPPIH, Dec 30 2001).
    "KIDA": ("PIH", "IDZ020"),
    # "IDZ021-311130-" / "LOWER SNAKE RIVER PLAIN-", temp table lists
    # POCATELLO-ARPT/POCATELLO under this zone (ZFPPIH, Dec 30 2001).
    "KPIH": ("PIH", "IDZ021"),
    # "FLZ062-065-...-" / "CHARLOTTE-LEE-" (ZFPTBW, repeated throughout
    # 2001) -- FLZ062=Charlotte, FLZ065=Lee (Fort Myers/Page Field).
    "KFMY": ("TBW", "FLZ065"),
    # "CAZ092-080000-" / "SOUTHEASTERN SAN JOAQUIN VALLEY-" (ZFPHNX, Dec 7
    # 2001); the Sept-window segment's temp table lists BAKERSFIELD as the
    # southernmost city under the matching 4-zone SE San Joaquin group.
    "KBFL": ("HNX", "CAZ092"),
    # KHSV (Huntsville AL): IEM's AFOS archive has zero ZFP-family products
    # for HUN under any known 2001 pil (checked ZFPHUN, ZFPHSV, and the full
    # `cccc=KHUN` product list for 2001 -- only FWCHSV/FWCMSL fire-weather
    # condition statements exist, no zone forecast). Accepted gap per the
    # brief's rule: not a major city, WFO archive genuinely empty.
    "KHSV": ("HUN", ""),
}

# api.weather.gov's `cwa` is the MODERN WFO identifier. A handful of offices
# archived their 2001 ZFP under a different 3-letter product id (pre-rename /
# pre-consolidation) -- confirmed per-office via IEM's AFOS product list API
# (`/api/1/nws/afos/list.json?cccc=K<cwa>&date=2001-09-11`), not guessed.
# wfo (cwa, stored in the CSV) -> AFOS PIL suffix used for ZFP in 2001.
PIL_OVERRIDES: dict[str, str] = {
    "FFC": "ATL",  # Atlanta GA (Peachtree City office, product still ATL)
    "FWD": "FTW",  # Dallas/Fort Worth TX
    "MFL": "MIA",  # Miami FL
    "KEY": "EYW",  # Key West FL
    "LIX": "NEW",  # New Orleans/Slidell LA
    "LUB": "LBB",  # Lubbock TX
    "LZK": "LIT",  # Little Rock AR
    "MEG": "MEM",  # Memphis TN
    "OHX": "BNA",  # Nashville TN
    "OUN": "OKC",  # Norman/Oklahoma City OK
    "TAE": "TLH",  # Tallahassee FL
    "TSA": "TUL",  # Tulsa OK
    "BMX": "BHM",  # Birmingham AL
    "EAX": "MCI",  # Kansas City/Pleasant Hill MO
    "EPZ": "ELP",  # El Paso TX
    "EWX": "SAT",  # Austin/San Antonio TX
    "HFO": "HI",   # Hawaii (single statewide ZFPHI, not per-office)
}


def points_lookup(client, station):
    f = CACHE / f"points_{station['station_id']}.json"
    if f.is_file():
        return json.loads(f.read_text())
    try:
        r = client.get(f"https://api.weather.gov/points/{station['lat']},{station['lon']}",
                       headers=UA, timeout=30, follow_redirects=True)
        r.raise_for_status()
        p = r.json()["properties"]
        data = {"cwa": p.get("cwa") or "", "zone": (p.get("forecastZone") or "").rsplit("/", 1)[-1]}
    except (httpx.HTTPStatusError, httpx.RequestError, KeyError, ValueError):
        data = {"cwa": "", "zone": ""}
    CACHE.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data))
    time.sleep(0.5)   # api.weather.gov politeness
    return data


def afos_segments(client, wfo):
    f = CACHE / f"zfp_{wfo}.txt"
    if f.is_file():
        text = f.read_text()
    else:
        pil = PIL_OVERRIDES.get(wfo, wfo)
        r = client.get(AFOS, params={"pil": f"ZFP{pil}", "sdate": "2001-09-08",
                                     "edate": "2001-09-13", "fmt": "text",
                                     "limit": "9999"}, timeout=120)
        r.raise_for_status()
        text = r.text
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    segs = []
    for prod in split_products(text):
        segs.extend(split_segments(prod))
    return segs


def main():
    rows = load_stations(CSV)
    unresolved = []
    with httpx.Client() as client:
        for st in rows:
            if st["country"] != "US":
                st["wfo"], st["nws_zone"] = "", ""
                continue
            if st["station_id"] in ZONE_OVERRIDES:
                st["wfo"], st["nws_zone"] = ZONE_OVERRIDES[st["station_id"]]
                continue
            pt = points_lookup(client, st)
            st["wfo"] = pt["cwa"]
            if not pt["cwa"]:
                unresolved.append((st["station_id"], pt["cwa"], st["name"]))
                st["nws_zone"] = ""
                continue
            segs = afos_segments(client, pt["cwa"])
            zone, method = resolve_zone(st["name"], pt["zone"], segs)
            if zone is None:
                unresolved.append((st["station_id"], pt["cwa"], st["name"]))
                st["nws_zone"] = ""
            else:
                st["nws_zone"] = zone
                print(f"{st['station_id']}: {pt['cwa']}/{zone} ({method})")
    with CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for st in rows:
            if st["elevation_m"] is None:
                st = {**st, "elevation_m": ""}
            w.writerow({k: st[k] for k in FIELDS})
    if unresolved:
        print(f"\nUNRESOLVED ({len(unresolved)}):", file=sys.stderr)
        for icao, wfo, name in unresolved:
            print(f"  {icao} wfo={wfo} name={name!r} -> read data/enrich-cache/"
                  f"zfp_{wfo}.txt and add to ZONE_OVERRIDES", file=sys.stderr)
        return 1
    print(f"wrote {len(rows)} stations with wfo/nws_zone to {CSV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
