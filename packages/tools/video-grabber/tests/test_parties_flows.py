import logging
from datetime import datetime
from types import SimpleNamespace

import pytest

import video_grabber.parties.flows as flows
from video_grabber.parties.flows import sample_windows, srt_text_to_plain

SRT = (
    "1\n00:00:01,000 --> 00:00:02,000\nIndy Center.\n\n"
    "2\n00:00:03,000 --> 00:00:04,000\nAmerican 77.\n"
)


def test_srt_to_plain_drops_indices_and_timestamps():
    assert srt_text_to_plain(SRT) == "Indy Center. American 77."


def test_sample_windows_returns_whole_text_when_short():
    assert sample_windows("short", n=6, size=2000) == ["short"]


def test_sample_windows_spreads_across_a_long_transcript():
    # Position-varying content: a repeating pattern whose period divides the
    # step would make distinct windows compare equal and hide a real bug.
    text = "".join(f"{i:04d}" for i in range(5000))
    got = sample_windows(text, n=6, size=2000)
    assert len(got) == 6
    assert all(len(w) == 2000 for w in got)
    assert len(set(got)) == 6


def test_sample_windows_reaches_the_end_of_the_transcript():
    # The last minutes of a NEADS tape are as interesting as the first; a
    # sampler that only ever reads the opening would miss them.
    text = "a" * 19000 + "TAIL" + "b" * 1000
    got = sample_windows(text, n=6, size=2000)
    assert any("TAIL" in w for w in got)


# --- rederive-mp3-metadata ------------------------------------------------
# The public projection and the tags are both pure functions of the stored
# `parties`, and both are re-derived here in one pass. Everything that touches
# the network is stubbed; these are about the order of the two writes, what
# ends up in the PATCH body, and the fact that an unattended re-derivation
# cannot start writing by accident.

PARTIES = {
    "tier": "clip", "link": "landline", "confidence": "high",
    "subject": "Boston Center reports American 11 is not responding",
    "evidence": "American 11 is not responding",
    "participants": [{"facility": "Boston Center", "role": "atc",
                      "confidence": "high", "source": "transcript"}],
    "mentions": {"facilities": [], "aircraft": ["AAL11"], "people": []},
    "topics": ["hijack-report"],
    "model": "claude-sonnet-5",
    "gate_reasons": ["subject names ['Cleveland'] which the transcript never contains"],
}

ROWS = [
    {"id": 1, "parties": PARTIES, "tags_curated": ["collection:team-8"]},
    {"id": 2, "parties": None, "tags_curated": []},
]


class RederiveEnv:
    """Records every write the flow makes, in the order it makes them."""

    def __init__(self):
        self.writes = []

    def patch(self, url, json, headers):
        self.writes.append(("patch", url.rsplit("/", 1)[-1], json))
        return SimpleNamespace(raise_for_status=lambda: None)

    def sync_item_tags(self, cfg, item_id, records, vocab):
        self.writes.append(("tags", str(item_id), [r["tag"] for r in records]))
        return len(records)

    def patches(self):
        return [w for w in self.writes if w[0] == "patch"]


@pytest.fixture
def rederive_env(monkeypatch):
    env = RederiveEnv()
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows, "_auth_headers", lambda cfg: {})
    monkeypatch.setattr(flows, "load_vocabulary", lambda cfg: {})
    monkeypatch.setattr(flows, "httpx", env)
    monkeypatch.setattr(flows, "sync_item_tags", env.sync_item_tags)
    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter(list(ROWS)))
    return env


def test_a_rederivation_writes_nothing_unless_it_is_asked_to(rederive_env):
    """Default dry_run. This flow rewrites every public column on all 814
    rows; triggering it from the Prefect UI to see what it would do must not
    be the same gesture as doing it."""
    flows.rederive_mp3_metadata_flow.fn()
    assert rederive_env.writes == []


def test_the_columns_are_written_before_the_tags(rederive_env):
    """Both derivations must land against one invalidation, and the streamer's
    cache is reloaded by the `mp3_items` trigger — the junction writes are
    silent (see backend/internal/cache/mp3_listen.go). Writing the columns
    first keeps the row the cache reloads from being one this pass has not
    finished with."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    assert [(kind, item) for kind, item, _ in rederive_env.writes] == [
        ("patch", "1"), ("tags", "1"), ("patch", "2"), ("tags", "2"),
    ]


def test_the_patch_body_holds_only_the_public_columns(rederive_env):
    """A row PATCH must not be able to clobber a column it does not derive —
    `parties` above all, which this flow only ever reads."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    body = rederive_env.patches()[0][2]
    assert set(body) == {"subject", "link", "tier", "confidence", "evidence",
                         "participants", "mentions", "provenance", "derived_at"}
    assert body["subject"] == PARTIES["subject"]


def test_the_private_blob_does_not_ride_along_in_the_patch(rederive_env):
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    for _, _, body in rederive_env.patches():
        assert "gate_reasons" not in str(body)
        assert "claude-sonnet-5" not in str(body)


def test_derived_at_records_the_derivation_version(rederive_env):
    """A row left behind by a half-finished run is otherwise only suspected.
    The version says which derivation produced it, so stale rows can be
    selected rather than guessed at."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    stamp = rederive_env.patches()[0][2]["derived_at"]
    version, _, when = stamp.partition(" ")
    assert version == f"v{flows.DERIVATION_VERSION}"
    assert datetime.fromisoformat(when).tzinfo is not None


def test_every_row_in_one_pass_carries_the_same_stamp(rederive_env):
    """So "which run wrote this" is answerable, not just "roughly when"."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    assert len({body["derived_at"] for _, _, body in rederive_env.patches()}) == 1


def test_a_row_with_no_parties_is_still_written(rederive_env):
    """Its projection has to be cleared, not left holding whatever an earlier
    derivation put there. 59 of the 814 rows have no `parties` at all."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    body = rederive_env.patches()[1][2]
    assert body["subject"] is None
    assert body["participants"] == []


def test_curated_tags_survive_a_rederivation(rederive_env):
    """The flow reads `tags_curated` and never writes it; a re-derivation that
    dropped hand-added tags would quietly undo curation across the corpus."""
    flows.rederive_mp3_metadata_flow.fn(dry_run=False)
    tags = next(w[2] for w in rederive_env.writes if w[0] == "tags")
    assert "collection:team-8" in tags
    assert "facility:boston-center" in tags


def test_limit_stops_the_pass_early(rederive_env):
    """Trying it on one row before committing to 814 of them."""
    flows.rederive_mp3_metadata_flow.fn(limit=1, dry_run=False)
    assert [w[1] for w in rederive_env.patches()] == ["1"]
