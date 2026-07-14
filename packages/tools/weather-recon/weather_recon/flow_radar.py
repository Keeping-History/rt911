"""
Prefect flow: mirror IEM archived NEXRAD CONUS composites to Wasabi.

Per frame: download PNG (+ .wld once per run for geometry), verify the
geometry matches every other frame, upload weather/radar/n0r_<stamp>.png.
404s are recorded as missing (real gaps exist in the 2001 archive).
Finishes by writing weather/radar/index.json (bounds + frame list + gaps).

skip_existing=True (default) makes re-runs resumable: already-uploaded keys
are skipped via one list_objects sweep, so a crashed run just re-runs.

Secrets: WASABI_ACCESS_KEY_ID / WASABI_SECRET_ACCESS_KEY env-only.
"""

import json
from pathlib import Path

import httpx
from prefect import flow, get_run_logger, task

from weather_recon.flow import NETWORK_RETRIES
from weather_recon.radar import (add_index0_transparency, build_index, corners,
                                 frame_times, iem_frame_url, iem_wld_url,
                                 parse_wld, png_dimensions, wasabi_frame_key)
from weather_recon.wasabi import existing_keys, make_client, upload_bytes

FETCH_TIMEOUT = 60.0
FRAME_CACHE_CONTROL = "max-age=31536000"   # immutable history
INDEX_KEY = "weather/radar/index.json"


def _fetch_frame(client, stamp, cache_dir):
    """PNG bytes for stamp, disk-cached; None on 404 (archive gap)."""
    cache_file = cache_dir / f"n0r_{stamp}.png" if cache_dir else None
    if cache_file is not None and cache_file.is_file():
        return cache_file.read_bytes()
    r = client.get(iem_frame_url(stamp))
    if r.status_code == 404:
        return None
    r.raise_for_status()
    if cache_file is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(r.content)
    return r.content


@task(**NETWORK_RETRIES)
def mirror_frames(start, end, cache_dir, skip_existing):
    log = get_run_logger()
    stamps = frame_times(start, end)
    cache = Path(cache_dir) if cache_dir else None
    s3 = make_client()
    have = existing_keys(s3, "weather/radar/n0r_") if skip_existing else set()
    if have:
        log.info("skip_existing: %d frames already on Wasabi", len(have))

    uploaded, skipped, missing, present = 0, 0, [], []
    bounds = None
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client:
        wld = parse_wld(client.get(iem_wld_url(stamps[0])).raise_for_status().text)
        for i, stamp in enumerate(stamps, 1):
            key = wasabi_frame_key(stamp)
            if key in have:
                skipped += 1
                present.append(stamp)
                continue
            data = _fetch_frame(client, stamp, cache)
            if data is None:
                missing.append(stamp)
                continue
            # IEM frames ship index-0 black as "no echo" with no transparency;
            # patch in tRNS here (post-cache, pre-upload) so the disk cache
            # stays a verbatim IEM mirror but Wasabi only ever sees keyed frames.
            data = add_index0_transparency(data)
            dims = png_dimensions(data)
            frame_bounds = corners(wld, *dims)
            if bounds is None:
                bounds = frame_bounds
                log.info("mosaic geometry: %dx%d px, bounds %s", *dims, bounds)
            elif frame_bounds != bounds:
                raise RuntimeError(f"geometry mismatch at {stamp}: "
                                   f"{frame_bounds} != {bounds}")
            upload_bytes(s3, key, data, "image/png", FRAME_CACHE_CONTROL)
            uploaded += 1
            present.append(stamp)
            if i % 100 == 0:
                log.info("frames %d/%d (uploaded %d, skipped %d, missing %d)",
                         i, len(stamps), uploaded, skipped, len(missing))
    if bounds is None:
        # every frame either existed already or is missing; recompute bounds
        # from the wld + the sample dims of the first cached/present frame
        bounds = corners(wld, 6000, 2600)
        log.warning("no new frames uploaded; using wld-derived default bounds %s",
                    bounds)
    return present, missing, bounds, uploaded, skipped


@task(**NETWORK_RETRIES)
def write_index(present, missing, bounds, start, end):
    log = get_run_logger()
    s3 = make_client()
    index = build_index(sorted(present), sorted(missing), bounds, start, end)
    upload_bytes(s3, INDEX_KEY, json.dumps(index).encode("utf-8"),
                 "application/json", "max-age=300")
    log.info("%s written: %d frames, %d missing", INDEX_KEY,
             len(index["frames"]), len(index["missing"]))


@flow(name="load-weather-radar", log_prints=True)
def load_weather_radar(
    start: str = "2001-09-09",
    end: str = "2001-09-12",
    cache_dir: str | None = "/tmp/iem-radar-cache",
    skip_existing: bool = True,
):
    log = get_run_logger()
    present, missing, bounds, uploaded, skipped = mirror_frames(
        start, end, cache_dir, skip_existing)
    write_index(present, missing, bounds, start, end)
    log.info("done: %d uploaded, %d skipped, %d missing of %d",
             uploaded, skipped, len(missing), len(present) + len(missing))
    return {"uploaded": uploaded, "skipped_existing": skipped,
            "missing": len(missing), "frames_total": len(present) + len(missing),
            "bounds": bounds}


if __name__ == "__main__":
    load_weather_radar()
