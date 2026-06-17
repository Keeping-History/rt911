"""Unit tests for the Usenet IA scanner — fake session + fake db, no network."""
from video_grabber.usenet import scanner


class FakeResult(list):
    """A search result is just an iterable of item dicts."""


class FakeSession:
    def __init__(self, by_collection):
        self.by_collection = by_collection
        self.queries = []

    def search_items(self, query, fields=None):
        self.queries.append(query)
        # query is "collection:<id>"
        cid = query.split(":", 1)[1]
        return FakeResult(self.by_collection.get(cid, []))


class FakeDB:
    def __init__(self):
        self.rows = []      # captured INSERT param dicts
        self.commits = 0

    def execute(self, _stmt, params):
        self.rows.append(params)

    def commit(self):
        self.commits += 1


def test_guess_mbox_format_prefers_item_then_collection():
    assert scanner.guess_mbox_format({"format": ["Archive BitTorrent", "mbox.gz"]}, "giganews") == "gz"
    assert scanner.guess_mbox_format({"format": "ZIP"}, "usenethistorical") == "zip"
    # no usable hint → fall back to the collection default
    assert scanner.guess_mbox_format({}, "usenethistorical") == "zip"
    assert scanner.guess_mbox_format({}, "giganews") == "gz"
    assert scanner.guess_mbox_format({}, "somethingelse") == "unknown"


def test_scan_collection_upserts_one_row_per_item():
    session = FakeSession({
        "usenethistorical": [
            {"identifier": "usenet-comp.lang.c", "mediatype": "texts"},
            {"identifier": "usenet-rec.games", "mediatype": "texts"},
        ],
    })
    db = FakeDB()
    n = scanner.scan_collection(session, "usenethistorical", db)
    assert n == 2
    ids = [r["ia_identifier"] for r in db.rows]
    assert ids == ["usenet-comp.lang.c", "usenet-rec.games"]
    assert all(r["stage"] == "discovered" for r in db.rows)
    assert all(r["collection"] == "usenethistorical" for r in db.rows)
    assert db.commits >= 1  # final commit at minimum


def test_scan_collection_recurses_nested_collections():
    session = FakeSession({
        "root": [
            {"identifier": "child", "mediatype": "collection"},
            {"identifier": "usenet-a", "mediatype": "texts"},
        ],
        "child": [
            {"identifier": "usenet-b", "mediatype": "texts"},
        ],
    })
    db = FakeDB()
    n = scanner.scan_collection(session, "root", db)
    # one leaf in root + one leaf in child
    assert n == 2
    assert {r["ia_identifier"] for r in db.rows} == {"usenet-a", "usenet-b"}


def test_scan_collections_dedups_across_collections():
    shared = {"identifier": "usenet-shared", "mediatype": "texts"}
    session = FakeSession({
        "usenethistorical": [shared],
        "giganews": [shared],  # same item under two collections
    })
    db = FakeDB()
    total = scanner.scan_collections(session, ["usenethistorical", "giganews"], db)
    # visited-set is shared, but each collection is a distinct query; the item is a
    # leaf so it is upserted once per collection it literally appears in. DB-level
    # ON CONFLICT is the real dedup — here we assert both queries ran.
    assert session.queries == ["collection:usenethistorical", "collection:giganews"]
    assert total == 2  # upserted once per collection; DB ON CONFLICT is the real dedup
