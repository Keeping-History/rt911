"""
Parsers for archived NWS AFOS text products (IEM retrieve.py output).

Stream format (verified live): products separated by \\x01 (start) / \\x03
(end), a 3-digit sequence line, then the WMO header `FPUS5x KXXX DDHHMM`
(day/hour/minute UTC), the PIL line (ZFPXXX), and the body. Bodies contain
one segment per zone group: UGC line(s), area-name lines, a LOCAL issuance
line, forecast text, `$$` terminator. issued_at always comes from the WMO
header (UTC) — never from the local-time line (anachronism rule).
"""

import re

WMO_RE = re.compile(r"^([A-Z]{4}\d{2}) (K[A-Z0-9]{3}) (\d{2})(\d{2})(\d{2})", re.M)
# a UGC chunk line: SSZ or SSC groups separated by '-', optionally ending in
# the DDHHMM expiry; always ends with '-'
UGC_LINE_RE = re.compile(r"^[A-Z]{2}[CZ]\d{3}[A-Z0-9>\-]*-$")
# a single UGC token: SSZnnn / SSZnnn>mmm (prefixed) or bare nnn / nnn>mmm
# (inherits the previous prefix). Exactly 3 digits, so this never matches the
# 6-digit DDHHMM expiry stamp that trails a UGC line — that token is simply
# skipped as unrecognized.
UGC_TOKEN_RE = re.compile(r"^([A-Z]{2}[CZ])?(\d{3})(?:>(\d{3}))?$")


def split_products(text):
    """\\x01-separated stream -> product strings starting at the WMO header."""
    out = []
    for chunk in text.split("\x01"):
        m = WMO_RE.search(chunk)
        if m:
            out.append(chunk[m.start():].split("\x03")[0].rstrip())
    return out


def parse_wmo_issued(product, year, month):
    """WMO header DDHHMM (UTC) -> ISO timestamp, using the window's year/month."""
    m = WMO_RE.search(product)
    if not m:
        raise ValueError("no WMO header in product")
    day, hour, minute = int(m.group(3)), int(m.group(4)), int(m.group(5))
    return f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}:00"


def expand_ugc(ugc):
    """UGC zone string -> explicit zone ids; expiry DDHHMM token dropped."""
    zones, prefix = [], None
    for token in ugc.strip().strip("-").split("-"):
        if not token:
            continue
        m = UGC_TOKEN_RE.match(token)
        if not m:
            # doesn't fit SSZnnn[>mmm] / nnn[>mmm] shape -> the trailing
            # 6-digit expiry stamp (e.g. 120905), not a zone token.
            continue
        if m.group(1):
            prefix = m.group(1)
        elif prefix is None:
            continue
        start = int(m.group(2))
        end = int(m.group(3)) if m.group(3) else start
        for n in range(start, end + 1):
            zones.append(f"{prefix}{n:03d}")
    return zones


def split_segments(product):
    """Product body -> [{ugc, zones, area_names, text}] per $$ segment."""
    lines = product.splitlines()
    segments, i = [], 0
    while i < len(lines):
        if not UGC_LINE_RE.match(lines[i].strip()):
            i += 1
            continue
        ugc_parts, start = [], i
        while i < len(lines) and UGC_LINE_RE.match(lines[i].strip()):
            ugc_parts.append(lines[i].strip())
            i += 1
        # area names run until the local issuance line (ends in a 4-digit year)
        names = []
        while i < len(lines) and not re.search(r"\d{4}\s*$", lines[i]):
            if lines[i].strip():
                names.append(lines[i].strip())
            i += 1
        body_start = start
        while i < len(lines) and lines[i].strip() != "$$":
            i += 1
        segment_text = "\n".join(lines[body_start:i]).rstrip()
        ugc = "".join(ugc_parts)
        segments.append({"ugc": ugc, "zones": expand_ugc(ugc),
                         "area_names": " ".join(names), "text": segment_text})
        i += 1
    return segments
