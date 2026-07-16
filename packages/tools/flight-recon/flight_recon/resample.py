"""
Pure per-minute resampling of an irregular waypoint track.

The `flights` streamer channel buckets positions per UTC minute (``flight:minutes``):
a flight aloft at minute *m* must have a row at *m* or it flickers out of the
airborne snapshot. This module turns the irregular documented radar/anchor
waypoints of a curated flight (see ``data/notable_flights/*.json``) into exactly
one sample per whole UTC minute it is airborne, plus the exact endpoints.

It is deliberately dependency-free (no pandas) and side-effect-free so it can be
unit-tested in isolation — it is the accuracy-critical core of the notable-flight
loader. Position between waypoints is great-circle interpolated (reusing the same
``gc_interp`` the BTS reconstruction uses); altitude is linearly interpolated.
"""

import math
from datetime import datetime, timedelta, timezone

from reconstruct import gc_interp

STEP_SECONDS = 60
PHASE_ALT_EPS_FT = 200   # per-step altitude change below this reads as level "cruise"


def parse_utc(s):
    """Parse a ``2001-09-11T12:46:40Z`` stamp into an aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def fmt_utc(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _floor_minute(dt):
    return dt.replace(second=0, microsecond=0)


def _sample_times(takeoff, impact, step):
    """Whole-minute grid over [takeoff, impact], endpoints pinned.

    Yields ``takeoff`` exactly, then every whole UTC minute strictly inside the
    interval whose minute-bucket precedes the impact minute, then ``impact``
    exactly. The result covers every minute-bucket in [takeoff, impact] exactly
    once — the interior minutes at ``:00`` and the impact minute at the true
    impact second (which may be off-minute, e.g. 12:46:40)."""
    if impact <= takeoff:
        raise ValueError(f"impact {impact} is not after takeoff {takeoff}")
    times = [takeoff]
    impact_bucket = _floor_minute(impact)
    g = _floor_minute(takeoff) + timedelta(seconds=step)
    while g < impact_bucket:
        times.append(g)
        g += timedelta(seconds=step)
    times.append(impact)
    return times


def _interp_at(waypoints, t):
    """Great-circle (lat/lon) + linear (alt) interpolation of the track at time t.

    ``waypoints`` is a list of ``(utc_dt, lat, lon, alt_ft)`` sorted ascending;
    t must lie within [first, last]. Endpoints return the waypoint verbatim."""
    lo = 0
    hi = len(waypoints) - 1
    if t <= waypoints[lo][0]:
        _, lat, lon, alt = waypoints[lo]
        return lat, lon, float(alt)
    if t >= waypoints[hi][0]:
        _, lat, lon, alt = waypoints[hi]
        return lat, lon, float(alt)
    for i in range(len(waypoints) - 1):
        t0, lat0, lon0, alt0 = waypoints[i]
        t1, lat1, lon1, alt1 = waypoints[i + 1]
        if t0 <= t <= t1:
            span = (t1 - t0).total_seconds()
            f = 0.0 if span == 0 else (t - t0).total_seconds() / span
            lat, lon = gc_interp(lat0, lon0, lat1, lon1, f)
            alt = alt0 + f * (alt1 - alt0)
            return lat, lon, alt
    raise AssertionError(f"time {t} not bracketed by waypoints")  # unreachable


def resample_track(waypoints, step_seconds=STEP_SECONDS, ndigits=5):
    """Resample irregular waypoints to one sample per whole UTC minute.

    Parameters
    ----------
    waypoints : list of dicts ``{"utc": str|datetime, "lat", "lon", "alt_ft"}``
        Sorted ascending by time; the first is takeoff, the last is impact.
    Returns
    -------
    list of dicts ``{"utc": datetime, "lat": float, "lon": float,
    "alt_ft": int, "phase": str}`` — one per minute-bucket in [takeoff, impact],
    with the first pinned to the takeoff waypoint and the last to the impact
    waypoint (the impact sample sits at the true impact second, not the minute).
    """
    if len(waypoints) < 2:
        raise ValueError("need at least takeoff and impact waypoints")
    wps = []
    for w in waypoints:
        utc = w["utc"] if isinstance(w["utc"], datetime) else parse_utc(w["utc"])
        wps.append((utc, float(w["lat"]), float(w["lon"]), float(w["alt_ft"])))
    for a, b in zip(wps, wps[1:]):
        if b[0] <= a[0]:
            raise ValueError(f"waypoint times must strictly increase: {a[0]} !< {b[0]}")

    takeoff, impact = wps[0][0], wps[-1][0]
    samples = []
    for t in _sample_times(takeoff, impact, step_seconds):
        lat, lon, alt = _interp_at(wps, t)
        samples.append({"utc": t, "lat": round(lat, ndigits),
                        "lon": round(lon, ndigits), "alt_ft": round(alt)})
    _assign_phases(samples)
    return samples


def decimate_polyline(coords, tolerance_deg=0.0005):
    """Douglas-Peucker decimation of a ``[[lon, lat], ...]`` polyline.

    Keeps every vertex that deviates more than ``tolerance_deg`` (degrees,
    ~55 m at these latitudes) from the chord of its containing segment — so
    radar-surveyed turns (AA77's descending spiral, AA11's Hudson run) survive
    while straight cruise legs collapse to their endpoints. Endpoints are
    always kept. Planar treatment is fine at track scale."""
    if len(coords) <= 2:
        return list(coords)
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        lo, hi = stack.pop()
        ax, ay = coords[lo]
        bx, by = coords[hi]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        worst, worst_d = None, tolerance_deg
        for i in range(lo + 1, hi):
            px, py = coords[i]
            if norm == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dx * (ay - py) - dy * (ax - px)) / norm
            if d > worst_d:
                worst, worst_d = i, d
        if worst is not None:
            keep[worst] = True
            stack.append((lo, worst))
            stack.append((worst, hi))
    return [c for c, k in zip(coords, keep) if k]


def _assign_phases(samples):
    """Label each sample climb/cruise/descent from the local altitude trend."""
    for i, s in enumerate(samples):
        nxt = samples[i + 1]["alt_ft"] if i + 1 < len(samples) else None
        prv = samples[i - 1]["alt_ft"] if i > 0 else None
        if nxt is not None:
            delta = nxt - s["alt_ft"]
        else:
            delta = s["alt_ft"] - prv  # last sample: trend from the previous
        if delta > PHASE_ALT_EPS_FT:
            s["phase"] = "climb"
        elif delta < -PHASE_ALT_EPS_FT:
            s["phase"] = "descent"
        else:
            s["phase"] = "cruise"
