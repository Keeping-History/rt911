#!/usr/bin/env python3
"""Generate scripts/map_pois.airports.json (+ npias-2001-primary.txt) from
the FAA's CY2000 primary-airport enplanement report, joined against
OurAirports for coordinates/runway data.

See scripts/build-map-pois.md for the full methodology writeup.

Usage (run from scripts/; faa_cy2000_primary.txt is already committed):
    curl -sL https://davidmegginson.github.io/ourairports-data/airports.csv -o ourairports.csv
    curl -sL https://davidmegginson.github.io/ourairports-data/runways.csv  -o runways.csv
    python3 generate_map_pois.py
"""
import csv
import json
import re
from collections import defaultdict

# --- 1. Parse the FAA DOT/TSC CY2000 ACAIS "Report C12" (Changes in Revenue
# Passenger Enplanements at Primary Airports), sourced from
# https://www.faa.gov/sites/faa.gov/files/airports/planning_capacity/passenger_allcargo_stats/passenger/cy00_primary_change.pdf
# (Report Date 10/19/2001). Transcribed verbatim into faa_cy2000_primary.txt.
rows = []
pat = re.compile(
    r'^\s*(\d+)\s+(\S+)\s+(.*?)\(([^,]*),([A-Z]{2})\)\s+([\d,]+)\s+([\-\d.]+)%\s+([\d,]+)\s*$'
)
with open('faa_cy2000_primary.txt') as f:
    for line in f:
        line = line.rstrip('\n')
        if not line.strip():
            continue
        m = pat.match(line)
        if not m:
            raise SystemExit(f'unparsed FAA report line: {line!r}')
        rank, locid, name, city, state, cy2000, change, cy1999 = m.groups()
        rows.append({
            'rank': int(rank), 'locid': locid, 'faa_name': name.strip(),
            'faa_city': city.strip(), 'state': state,
            'cy2000': int(cy2000.replace(',', '')),
        })

TERRITORY_STATES = {'PR', 'GU', 'VI', 'CM', 'AQ'}
us_rows = [r for r in rows if r['state'] not in TERRITORY_STATES]
# FAA "primary" = >10,000 annual revenue passenger enplanements.
primary = [r for r in us_rows if r['cy2000'] > 10000]

# --- 2. Join each FAA LOCID to the current OurAirports record to get
# coordinates / city / region / runway data. FAA LOCIDs usually match
# OurAirports iata_code, but fall back to local_code / gps_code / ident,
# and finally to two manual overrides for airports whose FAA-report-era
# identifier has since been superseded by a different code for the same
# facility (confirmed via OurAirports "keywords" cross-reference).
LOCID_OVERRIDE = {
    'L15': 'HSH',  # Henderson (NV) Executive Airport -- FAA LID "L15" retired, now KHND/HSH
    '17Z': 'KMO',  # Manokotak, AK -- FAA LID "17Z" retired, now PAMB/KMO
}

# Airports that had >10,000 CY2000 enplanements per the FAA report but whose
# current OurAirports coordinates cannot be trusted to represent the
# facility that was open on 2001-09-11:
RELOCATED_AFTER_2001 = {
    'SGU': 'St George Municipal (the CY2000-primary airport) closed; the '
           'IATA code SGU now belongs to St George Regional, a new facility '
           'at a different site that opened in 2011.',
}

# Airports that had >10,000 CY2000 enplanements but have no usable 3-letter
# IATA code in current OurAirports data (facility closed, renamed with no
# IATA reassigned, or never carried one) -- excluded because the record
# schema requires a real IATA code, not because they weren't primary.
NO_USABLE_IATA = {
    'PFN': 'Panama City-Bay Co Intl closed in 2010 (superseded by ECP, '
           'which did not exist in 2001); OurAirports\' closed-airport '
           'record carries no iata_code.',
    'LHD': 'Lake Hood Seaplane Base (Anchorage) -- no IATA code assigned.',
    'CVX': 'Charlevoix Municipal (MI) -- no IATA code assigned in current '
           'OurAirports data.',
    '3W2': 'Put-in-Bay Airport (OH) -- no IATA code assigned; scheduled '
           'service to the island has since lapsed.',
    'PCW': 'Port Clinton (OH), now Erie-Ottawa International -- no IATA '
           'code assigned in current OurAirports data.',
}

ourairports = list(csv.DictReader(open('ourairports.csv', newline='', encoding='utf-8')))
by_iata = defaultdict(list)
by_local = defaultdict(list)
by_gps = defaultdict(list)
by_ident = defaultdict(list)
for r in ourairports:
    if r['iata_code']:
        by_iata[r['iata_code']].append(r)
    if r['local_code']:
        by_local[r['local_code']].append(r)
    if r['gps_code']:
        by_gps[r['gps_code']].append(r)
    by_ident[r['ident']].append(r)


def resolve(locid):
    """Find the current OurAirports record for an FAA LOCID.

    Tries iata_code, then local_code, then gps_code, then ident -- but
    always prefers a US record with a resolvable iata_code over a non-US
    match, even if that means falling through to a later table (IATA codes
    are reused internationally, e.g. "CRQ", "HXD", "SAW" are all currently
    assigned to non-US airports even though they were the FAA LOCID for a
    US primary airport in CY2000 whose IATA code has since changed).
    """
    key = LOCID_OVERRIDE.get(locid, locid)
    non_us_fallback = None
    for table in (by_iata, by_local, by_gps, by_ident):
        cands = table.get(key)
        if not cands:
            continue
        us_cands = [c for c in cands if c['iso_country'] == 'US']
        us_with_iata = [c for c in us_cands if c['iata_code']]
        if us_with_iata:
            return us_with_iata[0]
        if non_us_fallback is None and cands:
            with_iata = [c for c in cands if c['iata_code']]
            non_us_fallback = (with_iata or cands)[0]
    return non_us_fallback


runway_stats = defaultdict(list)
for r in csv.DictReader(open('runways.csv', newline='', encoding='utf-8')):
    if r.get('closed') == '1':
        continue
    try:
        length = int(r['length_ft']) if r['length_ft'] else 0
    except ValueError:
        length = 0
    runway_stats[r['airport_ident']].append(length)


records = []
excluded_no_iata = []
excluded_relocated = []
unresolved = []
for p in primary:
    locid = p['locid']
    if locid in RELOCATED_AFTER_2001:
        excluded_relocated.append(locid)
        continue
    if locid in NO_USABLE_IATA:
        excluded_no_iata.append(locid)
        continue
    match = resolve(locid)
    if not match or not match['iata_code']:
        unresolved.append(locid)
        continue

    iata = match['iata_code']
    ident = match['ident']
    lengths = runway_stats.get(ident, [])
    region = (match.get('iso_region') or '').removeprefix('US-')
    elevation_ft = None
    if match.get('elevation_ft'):
        try:
            elevation_ft = int(float(match['elevation_ft']))
        except ValueError:
            pass

    records.append({
        'name': match['name'],
        'layer': 'Major Airports',
        'category': 'airport',
        'detail_title': 'Airport Details',
        'lat': round(float(match['latitude_deg']), 4),
        'lon': round(float(match['longitude_deg']), 4),
        'iata': iata,
        'icao': match.get('icao_code') or (ident if len(ident) == 4 else None),
        'city': match.get('municipality') or '',
        'region': region,
        'details': {
            'elevation_ft': elevation_ft,
            'runway_count': len(lengths),
            'longest_runway_ft': max(lengths) if lengths else 0,
        },
    })

print('FAA CY2000 US primary (>10,000 enplanements):', len(primary))
print('excluded (relocated after 2001):', excluded_relocated)
print('excluded (no usable IATA):', excluded_no_iata)
print('unresolved (unexpected):', unresolved)
print('final record count:', len(records))

# Sanity: unique IATA
iatas = [r['iata'] for r in records]
assert len(iatas) == len(set(iatas)), 'duplicate IATA in output'

records.sort(key=lambda r: r['iata'])
json.dump(records, open('map_pois.airports.json', 'w'), indent=2)

with open('npias-2001-primary.txt', 'w') as f:
    for r in records:
        f.write(r['iata'] + '\n')

print('wrote', len(records), 'records')
