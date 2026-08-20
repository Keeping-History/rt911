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


def test_normalize_msgid_strips_brackets():
    assert threader.normalize_msgid("<a@x>") == "a@x"
    assert threader.normalize_msgid(" <a@x> ") == "a@x"
    assert threader.normalize_msgid("a@x") == "a@x"   # usenetarchive form (no <>)
    assert threader.normalize_msgid(None) == ""


def test_build_thread_index_normalizes():
    # usenetarchive emits bracket-less ids; the index is bracket-normalised so it
    # joins mbox_parser records (which keep the <>).
    parents = {"a@x": "", "b@x": "a@x"}
    idx = threader.build_thread_index(parents)
    assert idx["a@x"] == {"parent": None, "thread": "a@x"}
    assert idx["b@x"] == {"parent": "a@x", "thread": "a@x"}
    # bracketed input normalises to the same keys
    assert set(threader.build_thread_index({"<a@x>": "", "<b@x>": "<a@x>"})) == {"a@x", "b@x"}


def test_build_threaded_archive_runs_pipeline_in_order(tmp_path):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch("video_grabber.usenet.threader.subprocess.run", side_effect=fake_run):
        arch = threader.build_threaded_archive("/in/group.mbox", str(tmp_path))

    steps = [c[0] for c in calls]  # binary name of each step
    # Full build: threadify needs the complete archive (Archive::Open), so every
    # derived-data step must run, in dependency order, before it.
    assert steps == [
        "import-source-mbox", "kill-duplicates",
        "extract-msgid", "connectivity", "extract-msgmeta",
        "repack-zstd", "lexicon", "lexsort", "threadify",
    ]
    # import reads the (plain) mbox; the threaded archive is the dedup output,
    # reused in place by every later step (which take arch as their final arg).
    assert calls[0][1] == "/in/group.mbox"
    assert arch.endswith("/arch")
    assert all(c[-1] == arch for c in calls[2:])  # every in-place step targets arch
    repack = next(c for c in calls if c[0] == "repack-zstd")
    assert "-s" in repack  # dict-size cap (bounds memory) is passed


def test_bin_honours_usenetarchive_bin_env(monkeypatch):
    monkeypatch.setenv("USENETARCHIVE_BIN", "/opt/uat/bin")
    assert threader._bin("threadify") == "/opt/uat/bin/threadify"
    monkeypatch.delenv("USENETARCHIVE_BIN")
    assert threader._bin("threadify") == "threadify"


def test_ensure_plain_mbox_unzips(tmp_path):
    import logging
    import zipfile
    zp = tmp_path / "g.mbox.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("g.mbox", "From 1\nSubject: hi\n\nbody\n")
    out = threader._ensure_plain_mbox(str(zp), tmp_path / "w", logging.getLogger("t"))
    assert out.endswith("g.mbox")
    assert "From 1" in open(out).read()


def test_ensure_plain_mbox_gunzips(tmp_path):
    import gzip
    import logging
    gp = tmp_path / "g.mbox.gz"
    with gzip.open(gp, "wb") as f:
        f.write(b"From 1\nSubject: hi\n\nbody\n")
    out = threader._ensure_plain_mbox(str(gp), tmp_path / "w", logging.getLogger("t"))
    assert "From 1" in open(out).read()


def test_ensure_plain_mbox_passes_through_plain(tmp_path):
    import logging
    assert threader._ensure_plain_mbox("/in/g.mbox", tmp_path, logging.getLogger("t")) == "/in/g.mbox"


def test_run_raises_with_stderr(tmp_path):
    import logging
    with mock.patch("video_grabber.usenet.threader.subprocess.run",
                    return_value=mock.Mock(returncode=1, stdout="", stderr="Cannot open /x/arch")):
        try:
            threader._run(["/usr/local/bin/threadify", "/x/arch"], logging.getLogger("t"))
            assert False, "expected failure"
        except RuntimeError as e:
            assert "threadify failed" in str(e) and "Cannot open" in str(e)


def test_thread_mbox_end_to_end(tmp_path):
    tsv = "<a@x>\t\n<b@x>\t<a@x>\n"

    def fake_run(args, **kwargs):
        if args[0] == threader._THREAD_EXPORT_BIN:
            return mock.Mock(returncode=0, stdout=tsv, stderr="")
        return mock.Mock(returncode=0, stdout="", stderr="")

    with mock.patch("video_grabber.usenet.threader.subprocess.run", side_effect=fake_run):
        index = threader.thread_mbox("/in/group.mbox", str(tmp_path))

    assert index["b@x"] == {"parent": "a@x", "thread": "a@x"}
