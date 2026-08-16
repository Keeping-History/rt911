#!/usr/bin/env python3
"""Round-2 ingest manifest: archive.org finds, anchor-verified 2026-08-16."""
import json
import os
import subprocess
from datetime import datetime, timedelta, timezone

EDT = timezone(timedelta(hours=-4))
HERE = os.path.dirname(os.path.abspath(__file__))
STAGING = os.path.join(HERE, "staging2")


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


ENTRIES = [
    # slug, filename, start, tz label, title, full_title, note
    ("WOR", "WOR-AM_2001-09-11_ET0848.mp3", et(11, 8, 48, 34), "EDT",
     "WOR 710", "WOR 710 New York — Sept 11, 8:48-10:50 AM ET (archive.org)",
     "south tower collapse live at ~4230s"),
    ("KOH", "KOH-AM_2001-09-11_ET0849.mp3", et(11, 8, 49, 0), "PDT",
     "News Talk 780 KOH", "KOH 780 Reno — Sept 11, ~8:49-11:01 AM ET, ABC feed + local (archive.org)",
     "start +/-90s; content-bounded"),
    ("BBC-R4", "BBC-R4_World-Tonight_2001-09-11_ET1700.mp3", et(11, 17, 0, 0), "BST",
     "BBC Radio 4", "BBC Radio 4 — The World Tonight special edition, Sept 11, 10 PM UK / 5 PM ET",
     "program open verified"),
    ("WAMU", "WAMU-NPR_2001-09-11_evening-a_ET1907.mp3", et(11, 19, 7, 0), "EDT",
     "WAMU 88.5 / NPR", "WAMU-NPR — Sept 11 evening coverage part 1, 7:07-8:22 PM ET (archive.org)",
     "continuous into part 2"),
    ("WAMU", "WAMU-NPR_2001-09-11_evening-b_ET2022.mp3", et(11, 20, 22, 36), "EDT",
     "WAMU 88.5 / NPR", "WAMU-NPR — Sept 11 evening coverage part 2 incl. Bush address, 8:22-9:03 PM ET",
     "Bush 8:30 PM address anchors this file"),
    ("WABC", "WABC-AM_2001-09-11_hole-patch_ET1050.mp3", et(11, 10, 50, 20), "EDT",
     "77 WABC New York", "WABC 770 — Sept 11, 10:50-10:59 AM ET patch (archive.org aircheck)",
     "fills the 10:50-11:00 hole; aligned via 11:00 ABC hourly open"),
    ("WCBS", "WCBS-AM_2001-09-11_gap-patch_ET172710.mp3", et(11, 17, 27, 10), "EDT",
     "WCBS Newsradio 880", "WCBS 880 — Sept 11, 5:27-5:30 PM ET patch (official release)",
     "fills the 4-min radiotapes gap; WTC7 anchor proven segment"),
    ("WCBS", "WCBS-AM_2001-09-12_morning_ET0716.mp3", et(12, 7, 16, 0), "EDT",
     "WCBS Newsradio 880", "WCBS 880 — Sept 12 morning-after coverage, 7:16-9:18 AM ET (official release)",
     "new coverage"),
    ("WCBS", "WCBS-AM_2001-09-12_afternoon_ET1405.mp3", et(12, 14, 5, 0), "EDT",
     "WCBS Newsradio 880", "WCBS 880 — Sept 12 afternoon coverage, 2:05-3:16 PM ET (official release)",
     "new coverage"),
]

entries = []
for slug, fname, start, tz, title, full, note in ENTRIES:
    path = os.path.join(STAGING, fname)
    d = dur(path)
    entries.append({
        "source_slug": slug,
        "file": fname,
        "bucket_key": f"audio/radio/{slug}/{fname}",
        "title": title,
        "full_title": full,
        "start_date": naive_utc(start),
        "end_date": naive_utc(start + timedelta(seconds=d)),
        "calc_duration": round(d),
        "timezone": tz,
        "note": note,
    })

out = os.path.join(HERE, "ingest_manifest2.json")
json.dump(entries, open(out, "w"), indent=1)
print(f"{len(entries)} entries, {sum(e['calc_duration'] for e in entries)/3600:.1f} h")
for e in entries:
    print(f"{e['source_slug']:7s} {e['start_date']}Z +{e['calc_duration']:>5}s  {e['file']}")
