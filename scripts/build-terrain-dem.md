# Terrain DEM (terrain-dem.pmtiles)

One-time raster-DEM basemap for the Flight Tracker's 3D terrain feature.
Terrarium-encoded, 512px WebP terrain-RGB tiles in a PMTiles archive, extracted
from [Mapterhorn](https://mapterhorn.com)'s planet-wide distribution.

## Contract with the app

`packages/frontend/src/lib/basemap/basemapStyles.ts` mounts the archive as a
`raster-dem` source: `encoding: "terrarium"`, `tileSize: 512`, bounds
`-150,18,-65,65` (the same NA bbox as the vector basemap and satellite
rasters). The app sets **no inline maxzoom** on this source — same pattern as
the satellite rasters in `scripts/build-satellite-basemap.md` — it defers to
the archive's own native max, and MapLibre overzooms past it automatically
for hillshade rendering. This means the exact zoom the archive was built at
is a size/quality tradeoff, not a hard requirement.

## Source + license

Mapterhorn distributes Terrarium-encoded terrain-RGB tiles as 512px WebP
images in a single planet-wide PMTiles archive, `https://download.mapterhorn.com/planet.pmtiles`
(covers z0–z12). `pmtiles extract` with `--bbox` is Mapterhorn's documented,
supported access path for pulling a regional subset (see
https://mapterhorn.com/data-access).

License/attribution: various open data sources, listed at
https://mapterhorn.com/attribution. The frontend basemap style already
credits "Mapterhorn" (see the `hillshade-*` layers' source attribution in
`basemapStyles.ts`), matching the PMTiles archive's own embedded attribution
(see sanity checks below).

## Tooling

The `pmtiles` CLI was not preinstalled on the build box. Installed from the
[protomaps/go-pmtiles](https://github.com/protomaps/go-pmtiles) GitHub
releases (Linux amd64 binary) into `~/.local/bin/pmtiles` (already on PATH):

```bash
curl -sL https://github.com/protomaps/go-pmtiles/releases/download/v1.31.1/go-pmtiles_1.31.1_Linux_x86_64.tar.gz \
  -o pmtiles.tar.gz
tar -xzf pmtiles.tar.gz
mv pmtiles ~/.local/bin/pmtiles
```

Version installed: **pmtiles 1.31.1** (commit `b9f2dac`, built
2026-07-13T17:06:44Z).

## Build (run in a scratch dir, NOT inside the repo)

Dry-run sizing first — always check before spending bandwidth on the real
extract. At the NA bbox used by all the other map archives:

```bash
pmtiles extract https://download.mapterhorn.com/planet.pmtiles terrain-dem.pmtiles \
  --bbox=-150,18,-65,65 --maxzoom=<N> --dry-run
```

Dry-run sizes actually measured for this bbox, at each candidate maxzoom
(kept here so the zoom/size tradeoff is revisitable):

| `--maxzoom` | Region tiles | Result tile entries | Reported archive size |
|---|---|---|---|
| 11 | 251,221 | 150,305 | 36 GB |
| **10 (chosen)** | 63,041 | 39,146 | **12 GB** |
| 9 | 15,899 | 10,392 | 3.4 GB |
| 8 | 4,065 | 2,842 | 946 MB |

**Chose `--maxzoom=10`.** The implementation spec allowed maxzoom 10–11 for
this archive; z11 measured 36 GB, well past the 20 GB sanity threshold for a
one-time regional DEM pull. The map is only ever viewed at flight/regional
scales, and (per the Contract section above) MapLibre overzooms `raster-dem`
tiles past the archive's native max acceptably for hillshade rendering — so
z10's 12 GB was the right size/quality tradeoff over z11's 36 GB. z8/z9 were
measured too, in case a future revision needs to shrink further.

Real extract:

```bash
pmtiles extract https://download.mapterhorn.com/planet.pmtiles terrain-dem.pmtiles \
  --bbox=-150,18,-65,65 --maxzoom=10
# 2026/07/16 02:49:36 extract.go:606: Completed in 4m44.858946593s with 4
#   download threads (137.42 tiles/s).
# 2026/07/16 02:49:36 extract.go:611: Extract required 43 total requests.
# 2026/07/16 02:49:36 extract.go:612: Extract transferred 12 GB
#   (overfetch 0.05) for an archive size of 12 GB
```

Final archive on disk: 11,452,735,372 bytes (~11.4 GiB / 12 GB per pmtiles'
own accounting).

## Sanity checks (before uploading)

```bash
pmtiles show terrain-dem.pmtiles
```

```
pmtiles spec version: 3
tile type: webp
bounds: (long: -150.000000, lat: 18.000000) (long: -65.000000, lat: 65.000000)
min zoom: 0
max zoom: 10
center: (long: -107.500000, lat: 41.500000)
center zoom: 6
addressed tiles count: 47238
tile entries count: 39146
tile contents count: 38220
clustered: true
internal compression: gzip
tile compression: none
attribution <a href="https://mapterhorn.com/attribution">© Mapterhorn</a>
```

`tile type: webp` confirms the Terrarium-RGB WebP encoding the app expects
(the `raster-dem` source declares `encoding: "terrarium"` explicitly in
`basemapStyles.ts` — this isn't separately stored in the PMTiles header).
Bounds match the NA bbox exactly, maxzoom is 10 as built, and the embedded
attribution points at Mapterhorn's attribution page — consistent with what
the frontend style already credits.

## Host (GATED — prod Wasabi) — DONE 2026-07-16

Same pattern as `scripts/build-satellite-basemap.md`'s "Host" section, which
was used successfully for the satellite archives on 2026-07-13:

1. Uploaded to the file-proxy's Wasabi bucket under `maps/terrain-dem.pmtiles`,
   alongside `na-basemap.pmtiles` / `na-satellite-day.pmtiles` /
   `na-satellite-night.pmtiles`.
2. Used the video-grabber Wasabi credentials (secret `video-grabber-secrets`
   in the `video-grabber` k8s namespace, keys `WASABI_ACCESS_KEY_ID` /
   `WASABI_SECRET_ACCESS_KEY`) with boto3 and
   `request_checksum_calculation="when_required"` — Wasabi rejects boto3
   ≥ 1.36's default checksum header (installed boto3 was 1.43.36). Client
   construction mirrors
   `packages/tools/video-grabber/video_grabber/storage/wasabi.py`:
   `signature_version="s3v4"`, `addressing_style="path"`,
   `response_checksum_validation="when_required"`, region `us-central-1`,
   endpoint `https://s3.us-central-1.wasabisys.com`, bucket
   `files.911realtime.org`.
3. No infra change needed: the `/maps` Ingress path on files.911realtime.org
   is prefix-based (same as the satellite archives) and already routes
   `terrain-dem.pmtiles` without any allow-list edit in
   `github.com/keeping-history/infra`.

Upload confirmed: `head_object` after transfer reported
`ContentLength: 11452735372` — matching the local file exactly.

## Verify

```bash
curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/terrain-dem.pmtiles
```

First request right after upload returned a bare `200 OK` (likely a cache/S3
gateway warm-up artifact on the very first hit against a freshly-written
object). A retry immediately after returned:

```
HTTP/2 206
content-length: 17
content-range: bytes 0-16/11452735372
```

`206 Partial Content` with the correct `content-range` total, matching the
other three archives (`na-basemap.pmtiles`, `na-satellite-day.pmtiles`,
`na-satellite-night.pmtiles`) queried the same way for comparison.
