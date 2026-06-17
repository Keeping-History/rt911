"""Unit tests for the usenetarchive threading wrapper — subprocess mocked."""
from unittest import mock

from video_grabber.usenet import threader


def test_parse_parent_tsv():
    tsv = "<a@x>\t\n<b@x>\t<a@x>\n<c@x>\t<b@x>\n\n"
    parents = threader.parse_parent_tsv(tsv)
    assert parents == {"<a@x>": "", "<b@x>": "<a@x>", "<c@x>": "<b@x>"}


def test_thread_root_walks_chain_to_root():
    parents = {"<a@x>": "", "<b@x>": "<a@x>", "<c@x>": "<b@x>"}
    assert threader.thread_root("<c@x>", parents) == "<a@x>"
    assert threader.thread_root("<a@x>", parents) == "<a@x>"


def test_thread_root_guards_cycles():
    parents = {"<a@x>": "<b@x>", "<b@x>": "<a@x>"}  # 2-cycle
    # Must terminate and return a stable root rather than loop forever.
    assert threader.thread_root("<a@x>", parents) in {"<a@x>", "<b@x>"}


def test_thread_root_groups_siblings_under_dangling_parent():
    # Two messages whose parent (<root@x>) is referenced but absent from the set
    # must share a thread id so they group.
    parents = {"<b@x>": "<root@x>", "<c@x>": "<root@x>"}
    assert threader.thread_root("<b@x>", parents) == "<root@x>"
    assert threader.thread_root("<c@x>", parents) == "<root@x>"


def test_build_thread_index():
    parents = {"<a@x>": "", "<b@x>": "<a@x>"}
    idx = threader.build_thread_index(parents)
    assert idx["<a@x>"] == {"parent": None, "thread": "<a@x>"}
    assert idx["<b@x>"] == {"parent": "<a@x>", "thread": "<a@x>"}


def test_build_threaded_archive_runs_pipeline_in_order(tmp_path):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch("video_grabber.usenet.threader.subprocess.run", side_effect=fake_run):
        arch = threader.build_threaded_archive("/in/group.mbox", str(tmp_path))

    steps = [c[0] for c in calls]  # binary name of each step
    assert steps == [
        "import-source-mbox", "kill-duplicates",
        "extract-msgid", "connectivity", "threadify",
    ]
    # import reads the mbox; the threaded archive is the dedup output, reused by the
    # in-place steps and returned.
    assert calls[0][1] == "/in/group.mbox"
    assert arch.endswith("/arch")
    assert calls[2][1] == arch and calls[3][1] == arch and calls[4][1] == arch


def test_bin_honours_usenetarchive_bin_env(monkeypatch):
    monkeypatch.setenv("USENETARCHIVE_BIN", "/opt/uat/bin")
    assert threader._bin("threadify") == "/opt/uat/bin/threadify"
    monkeypatch.delenv("USENETARCHIVE_BIN")
    assert threader._bin("threadify") == "threadify"


def test_thread_mbox_end_to_end(tmp_path):
    tsv = "<a@x>\t\n<b@x>\t<a@x>\n"

    def fake_run(args, **kwargs):
        if args[0] == threader._THREAD_EXPORT_BIN:
            return mock.Mock(returncode=0, stdout=tsv, stderr="")
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch("video_grabber.usenet.threader.subprocess.run", side_effect=fake_run):
        index = threader.thread_mbox("/in/group.mbox", str(tmp_path))

    assert index["<b@x>"] == {"parent": "<a@x>", "thread": "<a@x>"}
