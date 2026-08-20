#!/usr/bin/env python3
"""Build the delta ingest manifest for RadioTuner station additions.

Already in production (do not touch): WINS hourly set except the 2-3 AM 9/12
hour; WCBS official release covering 8:46-13:13 ET. Everything else is new.

Start times are the anchor-verified values from the 2026-08-15 evaluation
(Eastern Daylight Time, UTC-4), stored as naive-UTC strings per the
mp3_items convention. end_date = start + probed duration.
"""
import glob
import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

EDT = timezone(timedelta(hours=-4))
HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, "audio")
STAGING = os.path.join(HERE, "staging")


def dur(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
        capture_output=True, text=True,
    )
    return float(json.loads(r.stdout)["format"]["duration"])


def et(day, h, m, s=0):
    return datetime(2001, 9, day, h, m, s, tzinfo=EDT)


def naive_utc(dt):
    return dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat(sep="T", timespec="seconds")


entries = []


def add(slug, src_path, staged_name, start, title, full_title, note=""):
    staged = os.path.join(STAGING, staged_name)
    if not os.path.exists(staged):
        shutil.copy2(src_path, staged)
    d = dur(staged)
    entries.append({
        "source_slug": slug,
        "file": staged_name,
        "bucket_key": f"audio/radio/{slug}/{staged_name}",
        "title": title,
        "full_title": full_title,
        "start_date": naive_utc(start),
        "end_date": naive_utc(start + timedelta(seconds=d)),
        "calc_duration": round(d),
        "note": note,
    })


# --- WINS gap filler: 2-3 AM ET Sept 12 (missing from the production set) ---
add("WINS", f"{AUDIO}/19_WINS-AM_9-12-2001_2-3AM.mp3",
    "WINS-AM_2001-09-12_0200-0300-ET.mp3", et(12, 2, 0),
    "1010 WINS NEWS", "1010 WINS New York — Sept 12, 2:00-3:00 AM ET (radiotapes.com)",
    "fills the one missing hour in the existing 24h set")

# --- WCBS afternoon extension: radiotapes files 5-10 (existing row ends 13:12:58 ET) ---
wcbs = {
    5: (et(11, 13, 14, 0), "1:14-2:18 PM"),
    6: (et(11, 14, 18, 0), "2:18-3:25 PM"),
    7: (et(11, 15, 21, 0), "3:21-4:19 PM"),
    8: (et(11, 16, 19, 0), "4:19-5:27 PM"),
    9: (et(11, 17, 31, 0), "5:31-6:29 PM"),
    10: (et(11, 18, 28, 0), "6:28-7:39 PM"),
}
for n, (start, span) in wcbs.items():
    add("WCBS", f"{AUDIO}/{n:02d}_WCBS-AM_9-11-2001.mp3",
        f"WCBS-AM_2001-09-11_part{n:02d}-ET{start.strftime('%H%M')}.mp3", start,
        "WCBS Newsradio 880",
        f"WCBS 880 New York — Sept 11, {span} ET (radiotapes.com)",
        "starts from spoken news-time checks")

# --- WABC: all 8 files (two continuous blocks; 10:50-11:00 hole is in the source) ---
wabc_files = sorted(glob.glob(f"{AUDIO}/*WABC*.mp3"))
wabc_starts = [et(11, 8, 0), et(11, 9, 0), et(11, 9, 50), et(11, 11, 0),
               et(11, 12, 0), et(11, 13, 0), et(11, 14, 0), et(11, 15, 0)]
for f, start in zip(wabc_files, wabc_starts):
    add("WABC", f, f"WABC-AM_2001-09-11_ET{start.strftime('%H%M')}.mp3", start,
        "77 WABC New York",
        f"WABC 770 New York — Sept 11, from {start.strftime('%-I:%M %p')} ET (radiotapes.com)",
        "labels verified by event anchors")

# --- WTOP ---
add("WTOP", f"{AUDIO}/WTOP-AM_9-11-2001.mp3",
    "WTOP-AM_2001-09-11_ET0849.mp3", et(11, 8, 49, 30),
    "WTOP News Radio", "WTOP 1500 Washington — Sept 11, 8:49-10:01 AM ET (radiotapes.com)",
    "start from UA175 position, +/-45s")

# --- YouTube pool (transcoded to 128k MP3 in staging by transcode step) ---
yt = [
    ("WKXW", "WKXW-FM_2001-09-11_full-broadcast_ET0850.mp3", et(11, 8, 50, 26),
     "New Jersey 101.5", "WKXW 101.5 Trenton — Sept 11 full broadcast, 8:50 AM-3:34 PM ET",
     "morning exact; ~2 min trim after 10:28"),
    ("KFI", "KFI-AM_2001-09-11_full-broadcast_PT0500.mp3", et(11, 8, 0, 0),
     "KFI AM 640", "KFI 640 Los Angeles — Sept 11 full broadcast, 5:00 AM-1:00 PM PT",
     "5:00:00 PT sharp; zero drift"),
    ("WRIF", "WRIF-FM_Drew-and-Mike_2001-09-11_full-show_ET0600.mp3", et(11, 6, 0, 0),
     "WRIF Detroit", "WRIF 101.1 Detroit — Drew & Mike, Sept 11 full show, 6:00 AM-2:18 PM ET",
     "UA175 live at 3:03:00 offset"),
    ("WIBX", "WIBX-AM_Keeler_2001-09-11_ET0902.mp3", et(11, 9, 2, 5),
     "WIBX 950", "WIBX 950 Utica — Keeler in the Morning, Sept 11, 9:02 AM-12:46 PM ET",
     "corrected start; +/-30s"),
    ("WBAP", "WBAP-AM_2001-09-11_ET0852.mp3", et(11, 8, 52, 20),
     "WBAP 820", "WBAP 820 Dallas — Sept 11, 8:52-10:29 AM ET",
     "collapse1 live at ~1:06:45"),
    ("KQRS", "KQRS-FM_KQ-Morning-Show_2001-09-11_ET0856.mp3", et(11, 8, 56, 0),
     "92 KQRS", "KQRS 92.5 Minneapolis — KQ Morning Show, Sept 11, ~8:56-10:00 AM ET",
     "loose anchors; +/-3 min"),
]
for slug, fname, start, title, full, note in yt:
    path = os.path.join(STAGING, fname)
    if not os.path.exists(path):
        print(f"SKIP (not transcoded yet): {fname}")
        continue
    add(slug, path, fname, start, title, full, note)

out = os.path.join(HERE, "ingest_manifest.json")
with open(out, "w") as fh:
    json.dump(entries, fh, indent=1)
total = sum(e["calc_duration"] for e in entries)
print(f"{len(entries)} files, {total/3600:.1f} h -> {out}")
for e in entries:
    print(f"{e['source_slug']:6s} {e['start_date']}Z +{e['calc_duration']:>6}s  {e['file']}")
