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
