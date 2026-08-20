"""
Batch-decode every RS3 sensor recording under a directory (issue #263).

Walks the tree, content-hashes to skip duplicates (the four FOIA sets repeat
the same recordings), skips non-sensor ``.rs3`` files (RS3 *project* files
share the extension; ``iter_messages`` rejects them by header), decodes each
unique recording with ``rs3_parser.decode_df``, writes gzipped CSVs, and
prints/saves an inventory summary.

    python analysis/rs3_batch_decode.py --data-dir <dir> --out-dir <dir>/decoded

Output naming: ``<sha1-8>_<original stem>.csv.gz``.
"""

import argparse
import glob
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import rs3_parser  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out-dir")
    args = ap.parse_args(argv)
    out_dir = args.out_dir or os.path.join(args.data_dir, "decoded")
    os.makedirs(out_dir, exist_ok=True)

    paths = sorted(glob.glob(os.path.join(args.data_dir, "**", "*.rs3"), recursive=True)
                   + glob.glob(os.path.join(args.data_dir, "**", "*.RS3"), recursive=True))
    seen, summary = {}, []
    for p in paths:
        h = hashlib.sha1()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()[:8]
        if digest in seen:
            summary.append({"file": os.path.relpath(p, args.data_dir), "sha1": digest,
                            "status": f"duplicate of {seen[digest]}"})
            continue
        seen[digest] = os.path.relpath(p, args.data_dir)
        stem = os.path.splitext(os.path.basename(p))[0].replace(" ", "_")
        out = os.path.join(out_dir, f"{digest}_{stem}.csv.gz")
        if os.path.exists(out):
            # resumed run: keep the record usable by downstream loaders
            summary.append({"file": seen[digest], "sha1": digest, "status": "ok",
                            "out": os.path.basename(out), "resumed": True})
            continue
        t0 = time.time()
        try:
            df = rs3_parser.decode_df(p)
        except SystemExit:
            summary.append({"file": seen[digest], "sha1": digest, "status": "not a sensor recording"})
            continue
        df.to_csv(out, index=False)
        rec = {"file": seen[digest], "sha1": digest, "out": os.path.basename(out),
               "rows": int(len(df)),
               "t0": df.Time.min(), "t1": df.Time.max(),
               "sites": ",".join(sorted(df.Id.unique())),
               "uncalibrated": ",".join(sorted(set(df.Id.unique())
                                               - set(rs3_parser.tables_for(p)[1]))),
               "secs": round(time.time() - t0, 1), "status": "ok"}
        summary.append(rec)
        print(f"{rec['file']}: {rec['rows']:,} rows {rec['t0']}..{rec['t1']} "
              f"sites={rec['sites']}" + (f" UNCAL={rec['uncalibrated']}" if rec["uncalibrated"] else "")
              + f" ({rec['secs']}s)", flush=True)

    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    ok = [s for s in summary if s["status"] == "ok"]
    dup = [s for s in summary if s["status"].startswith("duplicate")]
    nrows = sum(s.get("rows") or 0 for s in ok)
    print(f"\ndecoded {len(ok)} unique recordings ({nrows:,}+ rows), "
          f"{len(dup)} duplicates skipped, "
          f"{len(summary) - len(ok) - len(dup)} non-sensor/other")


if __name__ == "__main__":
    main()
