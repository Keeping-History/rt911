"""The three metadata fields exist in both schema definitions and stay in sync:
COLLECTIONS drives prod (ensure_collection); LOCAL_SCHEMA_DDL drives scratch DBs."""

from flight_recon import notable
from flight_recon.directus import COLLECTIONS


def test_flight_tracks_has_metadata_fields():
    fields = {f["field"]: f for f in COLLECTIONS["flight_tracks"]["fields"]}
    assert fields["tail_number"]["type"] == "string"
    assert fields["aircraft_type"]["type"] == "string"
    assert fields["details"]["type"] == "json"
    # cast-json special is mandatory — without it Directus 400s the payload
    assert "cast-json" in fields["details"]["meta"]["special"]


def test_local_ddl_carries_the_same_columns():
    for col in ("tail_number", "aircraft_type", "details"):
        assert col in notable.LOCAL_SCHEMA_DDL, f"LOCAL_SCHEMA_DDL missing {col}"
