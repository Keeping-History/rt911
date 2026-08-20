"""Unit tests for the usenet processor (parse + thread join)."""
import json
from unittest import mock

from video_grabber.usenet import processor


def test_parser_record_to_message_maps_and_joins_thread():
    rec = {
        "date_iso": "2000-11-25T23:34:13+00:00",
        "date_source": "Date",
        "headers": {
            "newsgroups": "ntl.support.modems",
            "subject": "Re: Binary groups",
            "from": "Cronos <c@x>",
            "message-id": "<b@x>",
            "references": "<a@x>",
            "in-reply-to": "<a@x>",
        },
        "body": {"text_plain": ["line1", "line2"], "text_html": []},
    }
    # thread index is bracket-normalised (as build_thread_index produces)
    index = {"b@x": {"parent": "a@x", "thread": "a@x"}}
    msg = processor.parser_record_to_message(rec, index, fallback_group="fallback")
    assert msg["newsgroup"] == "ntl.support.modems"
    assert msg["start_date"] == "2000-11-25T23:34:13+00:00"
    assert msg["message_id"] == "b@x"        # <> stripped to match the index
    assert msg["thread_id"] == "a@x"
    assert msg["parent_id"] == "a@x"
    assert msg["references"] == "<a@x>"       # raw header kept as-is
    assert msg["body"] == "line1\nline2"


def test_message_falls_back_to_own_id_and_group_and_html():
    rec = {
        "date_iso": "2001-01-01T00:00:00+00:00",
        "headers": {"message-id": ["<solo@x>"], "subject": "hi"},  # list-valued header
        "body": {"text_plain": [], "text_html": ["<p>hello <b>world</b></p>"]},
    }
    msg = processor.parser_record_to_message(rec, {}, fallback_group="comp.lang.c")
    assert msg["newsgroup"] == "comp.lang.c"        # no Newsgroups header → fallback
    assert msg["message_id"] == "solo@x"            # list flattened + <> stripped
    assert msg["thread_id"] == "solo@x"             # no oracle entry → own id (singleton)
    assert msg["parent_id"] is None
    assert msg["body"] == "hello world"             # HTML stripped


def test_crosspost_newsgroups_takes_first():
    rec = {"headers": {"newsgroups": "a.b, c.d", "message-id": "<m@x>"}, "body": {}}
    assert processor.parser_record_to_message(rec, {}, "fb")["newsgroup"] == "a.b"


def test_process_archive_groups_by_newsgroup(tmp_path):
    records = [
        {"headers": {"newsgroups": "ntl.talk", "message-id": "<1@x>"}, "body": {"text_plain": ["a"]}},
        {"headers": {"newsgroups": "ntl.talk", "message-id": "<2@x>"}, "body": {"text_plain": ["b"]}},
        {"headers": {"newsgroups": "ntl.gaming", "message-id": "<3@x>"}, "body": {"text_plain": ["c"]}},
    ]

    def fake_parser(mbox_path, before, out_path, **kwargs):
        with open(out_path, "w", encoding="utf-8") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
        return str(out_path)

    with mock.patch.object(processor, "run_mbox_parser", side_effect=fake_parser), \
         mock.patch.object(processor.threader, "thread_mbox", return_value={}):
        groups = processor.process_archive("/in/x.mbox", "2001-09-21", str(tmp_path), "fallback")

    assert set(groups) == {"ntl.talk", "ntl.gaming"}
    assert len(groups["ntl.talk"]) == 2
    assert groups["ntl.gaming"][0]["message_id"] == "3@x"


def test_valid_newsgroup_accepts_and_rejects():
    for ok in ["comp.lang.c", "ntl.support.modems", "japan.chat", "24hoursupport",
               "bit.listserv.skeptic", "0.test", "a.b-c.d_e", "NetSet.TV.star_trek"]:
        assert processor.valid_newsgroup(ok), ok
    for bad in ["", "-h", "!.!", ".blur", "1", "0000000001", "1.1.1.1", ".a", "a.", "a..b", None]:
        assert not processor.valid_newsgroup(bad), bad


def test_newsgroup_of_picks_first_valid_crosspost_then_fallback_then_none():
    assert processor._newsgroup_of({"newsgroups": "!.!, comp.lang.c"}, "fb.k") == "comp.lang.c"
    assert processor._newsgroup_of({"newsgroups": "!junk"}, "comp.lang.c") == "comp.lang.c"
    assert processor._newsgroup_of({"newsgroups": "1"}, "-h") is None


def test_header_thread_index_from_references():
    records = [
        {"headers": {"message-id": "<a@x>"}},
        {"headers": {"message-id": "<b@x>", "references": "<a@x>"}},
        {"headers": {"message-id": "<c@x>", "references": "<a@x> <b@x>"}},
    ]
    idx = processor.header_thread_index(records)
    assert idx["a@x"] == {"parent": None, "thread": "a@x"}
    assert idx["c@x"] == {"parent": "b@x", "thread": "a@x"}


def _write_jsonl(records):
    def fake_parser(mbox_path, before, out_path, **kw):
        with open(out_path, "w", encoding="utf-8") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
        return str(out_path)
    return fake_parser


def test_process_archive_skips_junk_newsgroups(tmp_path):
    records = [
        {"headers": {"newsgroups": "ntl.talk", "message-id": "<1@x>"}, "body": {}},
        {"headers": {"newsgroups": "!.!", "message-id": "<2@x>"}, "body": {}},  # junk → dropped
    ]
    # invalid fallback ("1") too, so the junk-header message has no valid group and is dropped
    with mock.patch.object(processor, "run_mbox_parser", side_effect=_write_jsonl(records)), \
         mock.patch.object(processor.threader, "thread_mbox", return_value={}):
        groups = processor.process_archive("/in/x.mbox", "2001-09-21", str(tmp_path), "1")
    assert set(groups) == {"ntl.talk"}
    assert len(groups["ntl.talk"]) == 1


def test_process_archive_uses_header_threading_when_large(tmp_path, monkeypatch):
    monkeypatch.setattr(processor, "_MAX_THREADIFY_MESSAGES", 2)
    records = [{"headers": {"newsgroups": "ntl.talk", "message-id": f"<{i}@x>",
                            "references": "" if i == 0 else "<0@x>"}, "body": {}} for i in range(5)]
    called = {"thread_mbox": False}

    def boom(*a, **k):
        called["thread_mbox"] = True
        return {}

    with mock.patch.object(processor, "run_mbox_parser", side_effect=_write_jsonl(records)), \
         mock.patch.object(processor.threader, "thread_mbox", side_effect=boom):
        groups = processor.process_archive("/in/x.mbox", "2001-09-21", str(tmp_path), "fb.k")

    assert called["thread_mbox"] is False                       # usenetarchive skipped (too large)
    assert any(m["parent_id"] == "0@x" for m in groups["ntl.talk"])  # header threading linked replies


def test_process_archive_uses_header_threading_when_tiny(tmp_path, monkeypatch):
    # Archives below the zstd dictionary-training floor (repack-zstd SIGSEGVs on
    # too few samples) must skip the usenetarchive build and thread from headers.
    monkeypatch.setattr(processor, "_MIN_THREADIFY_MESSAGES", 8)
    records = [{"headers": {"newsgroups": "ntl.talk", "message-id": f"<{i}@x>",
                            "references": "" if i == 0 else "<0@x>"}, "body": {}} for i in range(3)]
    called = {"thread_mbox": False}

    def boom(*a, **k):
        called["thread_mbox"] = True
        return {}

    with mock.patch.object(processor, "run_mbox_parser", side_effect=_write_jsonl(records)), \
         mock.patch.object(processor.threader, "thread_mbox", side_effect=boom):
        groups = processor.process_archive("/in/x.mbox", "2001-09-21", str(tmp_path), "fb.k")

    assert called["thread_mbox"] is False                       # usenetarchive skipped (too small)
    assert any(m["parent_id"] == "0@x" for m in groups["ntl.talk"])  # header threading still linked replies


def test_process_archive_falls_back_when_threader_crashes(tmp_path, monkeypatch):
    # If the usenetarchive build crashes for any reason (a repack-zstd/lexicon
    # SIGSEGV the count check didn't pre-empt), the job must degrade to header
    # threading and still produce records — not fail the whole archive.
    monkeypatch.setattr(processor, "_MIN_THREADIFY_MESSAGES", 0)
    monkeypatch.setattr(processor, "_MAX_THREADIFY_MESSAGES", 10_000)
    records = [{"headers": {"newsgroups": "ntl.talk", "message-id": f"<{i}@x>",
                            "references": "" if i == 0 else "<0@x>"}, "body": {}} for i in range(20)]

    def crash(*a, **k):
        raise RuntimeError("repack-zstd failed (rc=-11): Building dictionary")

    with mock.patch.object(processor, "run_mbox_parser", side_effect=_write_jsonl(records)), \
         mock.patch.object(processor.threader, "thread_mbox", side_effect=crash):
        groups = processor.process_archive("/in/x.mbox", "2001-09-21", str(tmp_path), "fb.k")

    assert "ntl.talk" in groups
    assert len(groups["ntl.talk"]) == 20                        # all messages survived the crash
    assert any(m["parent_id"] == "0@x" for m in groups["ntl.talk"])  # header threading linked replies
