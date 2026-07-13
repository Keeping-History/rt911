from weather_recon.ghcn import (compute_almanac, derive_ghcn_id, nearest_ghcn,
                                nearest_ghcn_candidates, parse_daily_rows,
                                parse_ghcnd_stations)

GHCND_STATIONS = (
    "USW00094846  41.9950  -87.9336  201.8 IL CHICAGO OHARE INTL AP        \n"
    "USW00014819  41.7861  -87.7522  185.9 IL CHICAGO MIDWAY AP 3SW        \n"
    "CA006158733  43.6772  -79.6306  173.4    TORONTO LESTER B. PEARSON INT\n"
)

# Three stations near Chicago O'Hare at 0, 6.72 and 12.62 km, deliberately
# listed OUT of distance order so the ordering assertions discriminate a
# true sorted k-nearest from naive file-order collection; plus one far
# station (Toronto, ~702 km) that must be excluded by max_km.
NEARBY_STATIONS = (
    "USW00014819  41.9000  -87.8500  185.9 IL CHICAGO MIDWAY AP 3SW        \n"
    "USW00094846  41.9950  -87.9336  201.8 IL CHICAGO OHARE INTL AP        \n"
    "CA006158733  43.6772  -79.6306  173.4    TORONTO LESTER B. PEARSON INT\n"
    "USC00111577  42.0500  -87.9000  190.0 IL EVANSTON                    \n"
)

DAILY_CSV = ('"STATION","DATE","PRCP","TMAX","TMIN"\n'
             '"USW00094846","1971-09-09","    5","  278","  133"\n'
             '"USW00094846","1972-09-09","    0","  333","  100"\n'
             '"USW00094846","1999-09-09","   25","  333","   89"\n'
             '"USW00094846","2001-09-08","    0","  250","  120"\n'
             '"USW00094846","2001-09-09","    0","  400","  200"\n'   # after cutoff!
             '"USW00094846","1980-09-10","","  289",""\n')


def test_derive_ghcn_id():
    assert derive_ghcn_id("725300-94846") == "USW00094846"
    assert derive_ghcn_id("716270-99999") is None


def test_parse_ghcnd_stations():
    st = parse_ghcnd_stations(GHCND_STATIONS)
    assert st[0] == {"id": "USW00094846", "lat": 41.9950, "lon": -87.9336,
                     "name": "IL CHICAGO OHARE INTL AP"}
    assert st[2]["id"] == "CA006158733"


def test_nearest_ghcn_within_radius():
    st = parse_ghcnd_stations(GHCND_STATIONS)
    assert nearest_ghcn(43.68, -79.63, st) == "CA006158733"
    assert nearest_ghcn(41.995, -87.934, st) == "USW00094846"


def test_nearest_ghcn_none_when_too_far():
    st = parse_ghcnd_stations(GHCND_STATIONS)
    assert nearest_ghcn(19.43, -99.07, st) is None   # Mexico City vs this tiny list


def test_nearest_ghcn_candidates_orders_by_distance_and_excludes_far():
    st = parse_ghcnd_stations(NEARBY_STATIONS)
    ids = nearest_ghcn_candidates(41.9950, -87.9336, st)
    # nearest-first: self (0 km), then Evanston (6.72 km), then Midway (12.62 km);
    # Toronto (~702 km) excluded by the 20 km default max_km.
    assert ids == ["USW00094846", "USC00111577", "USW00014819"]


def test_nearest_ghcn_candidates_respects_limit():
    st = parse_ghcnd_stations(NEARBY_STATIONS)
    ids = nearest_ghcn_candidates(41.9950, -87.9336, st, limit=2)
    assert ids == ["USW00094846", "USC00111577"]


def test_parse_daily_rows_units_and_missing():
    rows = parse_daily_rows(DAILY_CSV)
    assert rows[0] == {"date": "1971-09-09", "prcp_mm": 0.5, "tmax_c": 27.8,
                       "tmin_c": 13.3}
    assert rows[5]["prcp_mm"] is None and rows[5]["tmin_c"] is None


def test_compute_almanac_records_normals_and_cutoff():
    rows = parse_daily_rows(DAILY_CSV)
    alm = compute_almanac(rows, ["09-09", "09-10"])
    d = alm["09-09"]
    # record high 33.3 shared by 1972 and 1999 -> latest year wins
    assert d["record_high_c"] == 33.3 and d["record_high_year"] == 1999
    assert d["record_low_c"] == 8.9 and d["record_low_year"] == 1999
    # 2001-09-09 (40.0C, after cutoff) MUST be excluded
    assert d["record_high_c"] != 40.0
    # normals over 1971-2000 rows present: (27.8+33.3+33.3)/3 = 31.5 (1dp)
    assert d["normal_high_c"] == 31.5
    assert d["record_precip_mm"] == 2.5 and d["record_precip_year"] == 1999
    d10 = alm["09-10"]
    assert d10["record_high_c"] == 28.9 and d10["record_high_year"] == 1980
    assert d10["record_low_c"] is None and d10["record_precip_mm"] is None


def test_compute_almanac_zero_precip_tie_goes_to_latest_year():
    csv_text = ('"STATION","DATE","PRCP","TMAX","TMIN"\n'
                '"USW00094846","1975-09-11","    0","  250","  120"\n'
                '"USW00094846","1988-09-11","    0","  260","  130"\n')
    alm = compute_almanac(parse_daily_rows(csv_text), ["09-11"])
    d = alm["09-11"]
    assert d["record_precip_mm"] == 0.0 and d["record_precip_year"] == 1988
