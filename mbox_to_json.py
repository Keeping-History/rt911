#!/usr/bin/env python3
"""
mbox_to_json.py — Parse MBOX newsgroup archives and export to JSON.

Usage:
    python mbox_to_json.py [--before DATE] [--output FILE] [--output-break N] [--delete] PATH [PATH ...]

Arguments:
    PATH               One or more MBOX files, compressed archives (.gz, .tgz,
                       .tar.gz, .zip), or directories to scan recursively.
    --before DATE      Exclude messages after this date (ISO 8601: YYYY-MM-DD or
                       YYYY-MM-DDTHH:MM:SS). Messages with no parseable date are
                       always included.
    --output FILE      Output file path (default: stdout)
    --output-break N   Split output into multiple files every N records. Requires
                       --output. Files are named by inserting a zero-padded part
                       number before the extension, e.g. messages.00001.json.
    --format FMT       Output format: jsonl or json (default: jsonl)
    --indent N         JSON indentation level (default: 2; use 0 for compact; ignored for jsonl)
    --delete           Delete source files after successful conversion (default: false)
"""

import argparse
import contextlib
import gzip
import json
import mailbox
import sys
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator, List, Optional, Tuple  # List kept for collect_inputs signature


def decode_header_value(raw: str) -> str:
    """Decode a potentially encoded email header value into a plain string."""
    if raw is None:
        return None
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw


def _decode_payload(payload: bytes, charset: str) -> str:
    """Decode bytes using charset, falling back to latin-1 for unknown encodings."""
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, TypeError):
        return payload.decode("latin-1", errors="replace")


def extract_body(message) -> dict:
    """
    Extract message body parts. Returns a dict with:
      - text_plain: list of plain-text parts
      - text_html:  list of HTML parts
      - attachments: list of attachment metadata dicts
    """
    plain_parts = []
    html_parts = []
    attachments = []

    if message.is_multipart():
        for part in message.walk():
            content_type = part.get_content_type()
            disposition = part.get("Content-Disposition", "")
            filename = part.get_filename()

            if filename or "attachment" in disposition:
                attachments.append({
                    "filename": decode_header_value(filename),
                    "content_type": content_type,
                    "size": len(part.get_payload(decode=True) or b""),
                })
                continue

            if content_type == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    plain_parts.append(_decode_payload(payload, charset))
            elif content_type == "text/html":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    html_parts.append(_decode_payload(payload, charset))
    else:
        payload = message.get_payload(decode=True)
        if payload:
            charset = message.get_content_charset() or "utf-8"
            text = _decode_payload(payload, charset)
            if message.get_content_type() == "text/html":
                html_parts.append(text)
            else:
                plain_parts.append(text)

    return {
        "text_plain": plain_parts,
        "text_html": html_parts,
        "attachments": attachments,
    }


def _sanitize(obj):
    """Recursively replace lone surrogate characters invalid in UTF-8/JSON."""
    if isinstance(obj, str):
        return obj.encode("utf-8", errors="surrogatepass").decode("utf-8", errors="replace")
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def message_to_dict(message, source_file: str) -> dict:
    """Convert a mailbox.Message object to a JSON-serialisable dict."""
    # Collect every header, preserving duplicates (e.g. Received)
    headers = {}
    for key in message.keys():
        decoded = decode_header_value(message[key])
        normalized_key = key.lower()
        if normalized_key in headers:
            existing = headers[normalized_key]
            if isinstance(existing, list):
                existing.append(decoded)
            else:
                headers[normalized_key] = [existing, decoded]
        else:
            headers[normalized_key] = decoded

    # Parse the Date header into an ISO 8601 string if possible
    date_str = message.get("Date")
    date_iso = None
    if date_str:
        try:
            dt = parsedate_to_datetime(date_str)
            date_iso = dt.isoformat()
        except Exception:
            pass

    return {
        "source_file": source_file,
        "date_iso": date_iso,
        "headers": headers,
        "body": extract_body(message),
    }


def parse_cutoff(date_str: str) -> datetime:
    """Parse a date/datetime string into an aware datetime (UTC assumed if no tz)."""
    formats = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(
        f"Cannot parse date '{date_str}'. Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS."
    )


def message_date(record: dict) -> Optional[datetime]:
    """Return the message's parsed datetime, or None if unparseable."""
    iso = record.get("date_iso")
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


_SUPPORTED_EXTENSIONS = {".mbox", ".gz", ".tgz", ".zip"}
_COMPRESSED_EXTENSIONS = {".gz", ".tgz", ".tar.gz", ".zip"}


def collect_inputs(paths: List[str]) -> List[str]:
    """
    Expand a mixed list of files and directories into a flat list of paths to
    process. Directories are walked recursively; only .mbox, .gz, .tgz,
    .tar.gz, and .zip files are included.
    """
    result = []
    for raw in paths:
        p = Path(raw)
        if not p.exists():
            print(f"Warning: '{raw}' not found, skipping.", file=sys.stderr)
            continue
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and (
                    child.suffix.lower() in _SUPPORTED_EXTENSIONS
                    or child.name.lower().endswith(".tar.gz")
                ):
                    result.append(str(child))
        else:
            result.append(str(p))
    return result


@contextlib.contextmanager
def _resolve_paths(path: str) -> Iterator[List[Tuple[str, str]]]:
    """
    Yield a list of (real_path, display_name) pairs for the given input.
    Decompresses .gz, .tar.gz/.tgz, and .zip into a temporary directory.
    """
    lower = path.lower()
    if lower.endswith(".tar.gz") or lower.endswith(".tgz"):
        with tempfile.TemporaryDirectory() as tmpdir:
            with tarfile.open(path, "r:gz") as tf:
                tf.extractall(tmpdir)
            entries = [
                (str(f), f"{path}:{f.relative_to(tmpdir)}")
                for f in sorted(Path(tmpdir).rglob("*"))
                if f.is_file()
            ]
            yield entries
    elif lower.endswith(".zip"):
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(path, "r") as zf:
                zf.extractall(tmpdir)
            entries = [
                (str(f), f"{path}:{f.relative_to(tmpdir)}")
                for f in sorted(Path(tmpdir).rglob("*"))
                if f.is_file()
            ]
            yield entries
    elif lower.endswith(".gz"):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = str(Path(tmpdir) / Path(path).stem)
            with gzip.open(path, "rb") as gz, open(tmp_path, "wb") as out:
                out.write(gz.read())
            yield [(tmp_path, path)]
    else:
        yield [(path, path)]


def parse_mbox(path: str, source_name: str = None) -> Iterator[dict]:
    """Yield message dicts from a single MBOX file."""
    label = source_name or path
    try:
        mbox = mailbox.mbox(path)
    except Exception as exc:
        print(f"Warning: cannot open '{label}': {exc}", file=sys.stderr)
        return
    try:
        mbox_iter = iter(mbox)
        i = 0
        while True:
            try:
                message = next(mbox_iter)
            except StopIteration:
                break
            except Exception as exc:
                print(f"Warning: skipping message {i} in '{label}': {exc}", file=sys.stderr)
                i += 1
                continue
            try:
                yield message_to_dict(message, source_file=label)
            except Exception as exc:
                print(f"Warning: skipping message {i} in '{label}': {exc}", file=sys.stderr)
            i += 1
    finally:
        mbox.close()


def _split_path(base: str, part: int) -> str:
    """Insert a zero-padded part number before the file extension.

    Example: _split_path("messages.json", 1) -> "messages.00001.json"
    """
    p = Path(base)
    return str(p.parent / f"{p.stem}.{part:05d}{p.suffix}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse MBOX archives and export messages as a JSON array.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "files",
        nargs="+",
        metavar="PATH",
        help="MBOX files, compressed archives, or directories to scan recursively",
    )
    parser.add_argument(
        "--delete",
        action="store_true",
        default=False,
        help="Delete source files after successful conversion (default: false)",
    )
    parser.add_argument(
        "--before",
        metavar="DATE",
        help="Exclude messages after this date (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)",
    )
    parser.add_argument(
        "--output",
        "-o",
        metavar="FILE",
        help="Output file (default: stdout)",
    )
    parser.add_argument(
        "--output-break",
        type=int,
        default=None,
        metavar="N",
        help="Split output into a new file every N records (requires --output)",
    )
    parser.add_argument(
        "--format",
        "-f",
        choices=["json", "jsonl"],
        default="jsonl",
        help="Output format: jsonl (one record per line) or json array (default: jsonl)",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        metavar="N",
        help="JSON indentation level (default: 2; 0 = compact; ignored for jsonl)",
    )
    args = parser.parse_args()

    if args.output_break is not None and not args.output:
        parser.error("--output-break requires --output")
    if args.output_break is not None and args.format == "json":
        parser.error("--output-break is only supported with --format jsonl")

    cutoff: Optional[datetime] = None
    if args.before:
        try:
            cutoff = parse_cutoff(args.before)
        except ValueError as exc:
            parser.error(str(exc))

    inputs = collect_inputs(args.files)
    jsonl = args.format == "jsonl"
    indent = None if jsonl or args.indent == 0 else args.indent
    output_break: Optional[int] = args.output_break

    # --- output file management ---
    split_part = 1
    lines_in_file = 0
    output_paths: list = []

    def current_output_path() -> str:
        if output_break:
            return _split_path(args.output, split_part)
        return args.output

    def open_out():
        path = current_output_path()
        output_paths.append(path)
        return open(path, "w", encoding="utf-8")

    out = open_out() if args.output else sys.stdout

    def rotate_file():
        nonlocal out, split_part, lines_in_file
        if not jsonl:
            out.write("\n]\n")
        out.close()
        split_part += 1
        lines_in_file = 0
        out = open_out()
        if not jsonl:
            out.write("[\n")

    total_written = 0
    total_filtered = 0
    try:
        if not jsonl:
            out.write("[\n")
        for path in inputs:
            with _resolve_paths(path) as entries:
                for real_path, display_name in entries:
                    file_count = 0
                    for record in parse_mbox(real_path, source_name=display_name):
                        if cutoff is not None:
                            dt = message_date(record)
                            if dt is not None and dt > cutoff:
                                total_filtered += 1
                                continue
                        # Rotate before writing if we've hit the per-file limit
                        if output_break and lines_in_file >= output_break:
                            rotate_file()
                        clean = _sanitize(record)
                        if jsonl:
                            out.write(json.dumps(clean, ensure_ascii=False) + "\n")
                        else:
                            if lines_in_file > 0:
                                out.write(",\n")
                            out.write(json.dumps(clean, indent=indent, ensure_ascii=False))
                        total_written += 1
                        lines_in_file += 1
                        file_count += 1
                    print(f"Parsed {file_count:,} messages from '{display_name}'", file=sys.stderr)
        if not jsonl:
            out.write("\n]\n" if lines_in_file > 0 else "]\n")
    finally:
        if args.output:
            out.close()

    if total_filtered > 0:
        print(
            f"Excluded {total_filtered:,} messages after {cutoff.date().isoformat()} "
            f"({total_written:,} remaining)",
            file=sys.stderr,
        )
    if args.output:
        if output_break:
            print(
                f"Wrote {total_written:,} messages across {len(output_paths)} file(s): "
                + ", ".join(f"'{p}'" for p in output_paths),
                file=sys.stderr,
            )
        else:
            print(f"Wrote {total_written:,} messages to '{args.output}'", file=sys.stderr)

    if args.delete:
        for path in inputs:
            try:
                Path(path).unlink()
                print(f"Deleted '{path}'", file=sys.stderr)
            except Exception as exc:
                print(f"Warning: could not delete '{path}': {exc}", file=sys.stderr)
            # For plain .gz files, also delete the uncompressed counterpart if present
            lower = path.lower()
            if lower.endswith(".gz") and not lower.endswith(".tar.gz") and not lower.endswith(".tgz"):
                uncompressed = Path(path).with_suffix("")
                if uncompressed.exists():
                    try:
                        uncompressed.unlink()
                        print(f"Deleted '{uncompressed}'", file=sys.stderr)
                    except Exception as exc:
                        print(f"Warning: could not delete '{uncompressed}': {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
