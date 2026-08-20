# Aircraft model picks (user-approved 2026-07-15)

Family → model file mapping for the 3D layer and the 2D icon set
(`icons/<name>.svg` are the auto-generated top-down silhouettes).
Licenses/authors: see manifest-*.jsonl. Nose-up orientation still needs
per-model normalization at integration.

| flight_tracks aircraft_type match | STL | License |
|---|---|---|
| (fallback / unknown) | generic-a320.stl | CC-BY 4.0 |
| Boeing 737* | b737-737800-jonahash.stl | CC-BY 4.0 |
| Boeing 757* | **b757-fgfs-gpl.stl** (converted, FlightGear) | GPL-2.0+ |
| Boeing 767* | b767-rticknor-767300er.stl | CC-BY-SA 3.0 |
| Boeing 777* | b777-jyu-777300er.stl | CC-BY 4.0 |
| Boeing 727* | **b727-yuppy-gpl.stl** (converted from OBJ) | GPL-2.0 |
| Boeing 717 / DC-9* / MD-8x / MD-90 | md80-boeing717.stl | CC-BY 3.0 |
| DC-10* / MD-11 | dc10-reean24.stl (axes rotated!) | CC-BY 4.0 |
| Airbus A-319* | a320-p6619-a319.stl | CC-BY-SA 3.0 |
| Airbus A320* | a320-p6619-a321.stl (or a319) | CC-BY-SA 3.0 |
| Canadair CL-600* (CRJ) | crj-crj200.stl | CC-BY 3.0 |
| Embraer EMB-135* | erj-erj145xr.stl | CC-BY 3.0 |
| ATR 42* / Shorts SD3-60 / small turboprops | **atr-328jet.stl (stand-in — user call)** | CC-BY 3.0 |
| Gulfstream / Cessna 650 (bizjets) | bizjet-g550.stl (decimate: 83k tris) | CC-BY 3.0 |
| Douglas C-47A / DC-7BF | dc3-pumpkinhead.stl | CC-BY 3.0 |

Rejected/limbo: b757-757-adcoff72-NC.stl and b727-727100-jimenez-NC.stl
(CC-BY-NC — superseded by the GPL conversions above); dc3-jpoponea.stl
(410k tris); b777-lohtaja-7779x.stl (anachronistic 777-9X); L-410 parts
(print-plated); bizjet-citation.stl (provenance unclear).

Converters (stdlib, in this dir): obj2stl.py, ac2stl.py (AC3D; filters
FlightGear light-cone/beacon helper objects + geometric outlier guard).
GPL note: converted derivatives remain GPL — fine to serve as assets with
attribution + source link; keep this dir's manifests as the record.
