"""
Tests for the RADES verified-tier loader's pure core (chain cleaning,
waypoint building, row/geometry construction) and its safety guards.
DB-touching paths are covered by the dry-run procedure in the design doc.
"""

import math

import pytest

from flight_recon.rades_load import (
    ALT_MAX_FT, NOTABLE_IDS, build_rows, chain_waypoints, clean_chain,
)


def _cruise(n=40, t0=40000.0, lat0=40.0, lon0=-75.0, alt=33000.0, dt=12.0):
    """A steady westbound cruise chain: (secs, lat, lon, mc_ft)."""
    return [(t0 + i * dt, lat0, lon0 - i * 0.02, alt) for i in range(n)]


def test_clean_chain_thins_and_keeps_order():
    pts = _cruise()
    # inject sub-spacing duplicates (multi-site interleave)
    dup = [(p[0] + 1.0, p[1] + 0.001, p[2], p[3]) for p in pts[:10]]
    out = clean_chain(pts + dup)
    times = [p[0] for p in out]
    assert times == sorted(times)
    assert all(b - a >= 5.0 for a, b in zip(times, times[1:]))


def test_clean_chain_drops_lateral_spike():
    pts = _cruise()
    pts[20] = (pts[20][0], pts[20][1] + 0.08, pts[20][2], pts[20][3])  # ~5 nm blip
    out = clean_chain(pts)
    lats = [p[1] for p in out]
    assert max(lats) - min(lats) < 0.01


def test_clean_chain_blanks_garbled_modec_and_interpolates():
    pts = _cruise()
    pts[15] = (pts[15][0], pts[15][1], pts[15][2], 58500.0)   # garble amid FL330
    pts[16] = (pts[16][0], pts[16][1], pts[16][2], None)      # radar-only return
    out = clean_chain(pts)
    alts = [p[3] for p in out]
    assert all(a is not None for a in alts)
    assert max(alts) <= 33000.0  # garble replaced by neighborhood, capped by peers


def test_clean_chain_all_primary_returns_empty():
    pts = [(t, 40.0, -75.0, None) for t in range(0, 600, 12)]
    assert clean_chain(pts) == []


def test_chain_waypoints_whole_seconds_strictly_increasing():
    wps = chain_waypoints(clean_chain(_cruise()))
    stamps = [w["utc"] for w in wps]
    assert stamps == sorted(stamps) and len(set(stamps)) == len(stamps)
    assert all(isinstance(w["alt_ft"], int) and 0 <= w["alt_ft"] <= ALT_MAX_FT for w in wps)


def test_build_rows_per_minute_and_dense_geometry():
    wps = chain_waypoints(clean_chain(_cruise(n=60)))
    positions, geometry = build_rows("XX123", "XX", wps, diverted=False)
    # interior rows land on whole minutes; clock anchor matches the prod window
    for p in positions[1:-1]:
        assert p["et_seconds"] % 60 == 0
    for p in positions:
        assert p["clock_seconds"] == p["et_seconds"] + 172800
        assert p["diverted"] is False
        assert p["flight"] == "XX123" and p["carrier"] == "XX"
    # geometry spans the track and is at least as dense as the minute grid
    assert len(geometry) >= 2
    assert geometry[0] == pytest.approx([wps[0]["lon"], wps[0]["lat"]], abs=1e-4)
    assert geometry[-1] == pytest.approx([wps[-1]["lon"], wps[-1]["lat"]], abs=1e-4)


def test_build_rows_diverted_flag_propagates():
    wps = chain_waypoints(clean_chain(_cruise(n=60)))
    positions, _ = build_rows("YY9", "YY", wps, diverted=True)
    assert all(p["diverted"] is True for p in positions)


def test_notable_ids_are_hard_excluded():
    # the loader must never touch the curated five, whatever the tier says
    assert NOTABLE_IDS == {"AA11", "UA175", "AA77", "UA93", "GOFER06"}


def test_spike_filter_survives_a_real_turn():
    # a 2-minute standard-rate 180 must NOT be eaten by the deviation filter
    pts = []
    for i in range(40):
        t = 40000.0 + i * 12.0
        ang = math.radians(min(i, 20) * 9)          # turn through 180 deg
        pts.append((t, 40.0 + 0.03 * math.sin(ang), -75.0 - 0.03 * (1 - math.cos(ang)), 20000.0))
    out = clean_chain(pts)
    assert len(out) >= 35  # at most a point or two shaved, the turn preserved
