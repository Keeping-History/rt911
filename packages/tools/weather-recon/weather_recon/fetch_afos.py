"""Cached AFOS product fetch per (WFO, window) — mirrors fetch_ncei's contract."""

from urllib.parse import urlencode

BASE = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"

# api.weather.gov's `cwa` is the MODERN WFO identifier. A handful of offices
# archived their 2001 ZFP under a different 3-letter product id (pre-rename /
# pre-consolidation) -- confirmed per-office via IEM's AFOS product list API
# (`/api/1/nws/afos/list.json?cccc=K<cwa>&date=2001-09-11`), not guessed.
# wfo (cwa, stored in the CSV) -> AFOS PIL suffix used for ZFP in 2001.
AFOS_PIL_OVERRIDES: dict[str, str] = {
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


def afos_pil(wfo):
    """Modern WFO cwa -> the ZFP product PIL it was filed under in 2001."""
    return "ZFP" + AFOS_PIL_OVERRIDES.get(wfo, wfo)


def fetch_wfo_products(client, wfo, sdate, edate, cache_dir):
    pil = afos_pil(wfo)
    cache_file = None
    if cache_dir is not None:
        cache_file = cache_dir / f"{pil}_{sdate}_{edate}.txt"
    if cache_file is not None and cache_file.is_file():
        return cache_file.read_text(encoding="utf-8")
    url = BASE + "?" + urlencode({"pil": pil, "sdate": sdate,
                                  "edate": edate, "fmt": "text", "limit": "9999"})
    r = client.get(url, timeout=120)
    r.raise_for_status()
    if cache_file is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(r.text, encoding="utf-8")
    return r.text
