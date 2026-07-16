# Exporting the raw RADES `.RS3` files to CSV (Windows XP + RS3 app)

Goal: turn each raw binary sensor recording in the 84 RADES FOIA release into a
per-message CSV **with computed latitude/longitude**, so the flight-recon
pipeline can analyze *all* aircraft tracks (issue #263) — the binary field
encodings are undecoded, but the bundled RS3 app computes lat/lon itself and
has a per-message CSV export (the same path that produced `Exp_Query.csv` in
the Pentagon products).

Everything below comes from the release's own docs: `Practice Files/
Introduction to RS3.doc` (Message Viewer §, Exercises #18/#19) and
`Products/software/RS3 Quick Instructions.doc`.

## One-time setup

1. Copy the RADES folders you'll work from onto the hard drive (the app writes
   next to its data; CD paths and read-only flags break it).
2. Right-click each copied file → Properties → **uncheck Read-only** → OK.
3. Install RS3: run `Rs3Setup.EXE` (in `rades.pentagon…/Products/software/` —
   the UAL93 set has an identical copy). Accept defaults; ~12 MB. Create the
   desktop shortcut when asked. Ignore any "RDI Boards not installed" warning —
   that's for live radar capture hardware, not playback.
4. Make an output folder, e.g. `C:\exports\`.

## Per-file export procedure (Message Viewer)

Repeat for each raw `.RS3` file (list below). One source file → one CSV, named
after the source file.

1. Launch RS3 → **File → New Project** → *Blank Project* → Load.
2. **Project → Add Task** → in *Select Data Source* choose **File** → pick the
   raw file (e.g. `C:\rades\raw\12541130.RS3`) → check **Open as Read Only** →
   Open.
3. **Project → Add Process** → select the **Message Viewer** icon → OK.
4. Right-click *Message Viewer* in the Project Manager tree → **Properties**:
   - **Msg Fields tab** — the defaults are `Site ID, Track No, Date, Time,
     Message Type, Range, Azimuth Degs, Mode 3, Mode 2, Mode C, Height`.
     Add from the left frame: **Latitude**, **Longitude**, and any
     validity-bit fields offered (e.g. *Mode 3 Valid*, *Mode C Valid* — the
     84 RADES analysts' own spreadsheets include them). Field order doesn't
     matter to the pipeline; headers are exported.
   - **Options tab** —
     - check **Export On**
     - check **Export Column Headings**
     - **Export Filename**: `C:\exports\<sourcefilename>.csv`
       (e.g. `C:\exports\12541130.csv`)
     - **Export Format**: CSV
     - uncheck **View Messages While Processing** (major speed-up; the grid
       doesn't need to paint for the export to happen)
   - OK.
5. **Data → Start**. Raise the run speed to maximum (Sensor Display's run-speed
   control — Exercise #9 in the intro doc — or just let it run). Wait until the
   file plays out (the End indicator, upper-left).
6. **Data → Stop**, then File → Exit (no need to save the project).
7. Sanity-check the CSV opens and has a `Latitude` column with real values.
   Expect tens of MB per half-hour file.

If the Message Viewer misbehaves on a big file, the fallback is the Sensor
Display **Query Area** flow (Exercise #10: Process → Query Area → trace a
boundary → right-click → Query Results → export) — that's what produced
`Exp_Query.csv` — but it's per-area rather than whole-file, so prefer the
Message Viewer.

## Which files to export (deduplicated across the four release sets)

The three event sets share identical `12540930.RS3 … 12541430.RS3` copies —
export each name once. Priority order:

1. **NEADS core sweep** (any set's `Data/Raw/USAF/`, ~7–21 MB each):
   `12540930, 12541000, 12541030, 12541100, 12541130, 12541200, 12541230,
   12541300, 12541330, 12541400, 12541430` (11 files — 09:30–15:00 UTC)
2. **NEADS afternoon** (Pentagon set): `NEADS 12541430 … NEADS 12541630`
   (4 more files — through 17:00 UTC; the `NEADS 12541430` duplicates #1's
   `12541430`, skip it)
3. **SEADS radars** (Pentagon set): `SEADS_12541100 … SEADS_12541600`
   (11 files — southern coverage of AA77/UA93 area)
4. **WTC evening file** (WTC set): `12542330.rs3` (23:30 UTC)
5. Optional, likely redundant with 1–3: `Projects/Cnv_Multifile Sensor
   Data.rs3` (160 MB combined file), `Projects/Pittsburgh.rs3` (90 MB),
   `Data/Filtered/USAF/Pentagon Combined Radar File.rs3` (145 MB — already
   merged + filtered; useful as a cross-check against `Exp_Query.csv`)

That's ~26 files ≈ 330 MB of binary → expect a few GB of CSV. Zip the CSVs
(they compress ~10×) and drop them next to the RADES folder; the analysis
continues from there (parse → per-squawk track segmentation → BTS correlation).
