"""Tag derivation: what a searcher can actually filter on."""
from video_grabber.parties.tags import (
    build_tag_records,
    build_tags,
    normalize_callsign,
    slugify,
    split_tag,
)
from video_grabber.parties.vocab import agency_for, canonical_facility

FULL = {
    "tier": "clip",
    "link": "landline",
    "participants": [
        {"facility": "Indianapolis Center", "position": "R86", "person": None,
         "role": "atc", "confidence": "high"},
        {"facility": "American", "position": "dispatch", "person": "Jim McDonald",
         "role": "airline", "confidence": "high"},
    ],
    "aircraft": ["American 77"],
    "mentions": {"facilities": ["NEADS"], "aircraft": ["UAL93"], "people": ["Ben Sliney"]},
    "topics": ["loss-of-contact", "hijack-report"],
}


def test_every_tag_is_namespaced():
    """A bare tag list cannot be filtered by kind, and names collide across kinds."""
    assert all(":" in t for t in build_tags(FULL))


def test_tags_are_sorted_and_deduped():
    tags = build_tags(FULL)
    assert tags == sorted(set(tags))


def test_participants_and_mentions_both_reach_the_index():
    """Someone searching for NEADS wants the calls that discuss it, too."""
    tags = build_tags(FULL)
    assert "facility:indianapolis-center" in tags   # participant
    assert "facility:neads" in tags                 # merely mentioned
    assert "person:jim-mcdonald" in tags
    assert "person:ben-sliney" in tags


def test_agency_is_inferred_from_facility():
    tags = build_tags(FULL)
    assert "agency:faa" in tags and "agency:norad" in tags


def test_only_vocabulary_topics_become_tags():
    tags = build_tags({**FULL, "topics": ["hijack-report", "everyone-is-worried"]})
    assert "topic:hijack-report" in tags
    assert not any(t.startswith("topic:everyone") for t in tags)


def test_various_never_becomes_a_facility():
    """Schema 1's placeholder must not enter the index as a real place."""
    tags = build_tags({"participants": [{"facility": "various", "role": "atc"}]})
    assert "facility:various" not in tags


def test_airframe_models_do_not_become_callsign_tags():
    """'we have a 757 inbound' is a type, not a flight.

    `aircraft:757` is worse than no tag — it collides every Boeing on the
    morning into one bucket.
    """
    tags = build_tags({"aircraft": ["757"], "mentions": {"aircraft": ["767"]}})
    assert not any(t.startswith("aircraft:7") for t in tags)


def test_empty_block_yields_no_tags():
    assert build_tags({}) == []


# --- callsign normalisation ----------------------------------------------

def test_spoken_and_coded_callsigns_collapse_to_one_tag():
    """'American 11', 'AAL11' and 'AA11' are one aircraft, so one tag."""
    assert {normalize_callsign(c) for c in ("American 11", "AAL11", "AA 11")} == {"aal11"}


def test_military_callsigns_keep_their_own_prefix():
    # The point is collapsing spellings, not forcing everything into an airline.
    # Leading zeros are stripped so the spellings below agree; see the next test.
    assert normalize_callsign("Gofer 06") == "gofer6"
    assert normalize_callsign("Quit 2-5") == "quit25"


def test_leading_zeros_do_not_split_an_aircraft_in_two():
    assert normalize_callsign("Gofer 06") == normalize_callsign("GOFER6")


def test_aircraft_tags_use_the_normalised_form():
    tags = build_tags(FULL)
    assert "aircraft:aal77" in tags and "aircraft:ual93" in tags


# --- helpers --------------------------------------------------------------

def test_slugify_collapses_punctuation_and_case():
    assert slugify("Washington Center (ZDC)") == "washington-center-zdc"


def test_agency_prefers_the_longest_matching_key():
    # 'us airways' must not be shadowed by a shorter carrier key, and
    # 'port authority' must beat any substring.
    assert agency_for("US Airways") == "airline"
    assert agency_for("Port Authority Police") == "panynj"


def test_unknown_facility_has_no_agency():
    assert agency_for("Somewhere Nobody Listed") is None


# --- facility aliasing ----------------------------------------------------

def test_the_three_names_for_one_center_reach_one_tag():
    """The reason this table exists.

    One clip's transcript says "Boston", another says "Boston Center", a third
    says "ZBW". The record stores whichever was said — so without resolution the
    index splits one facility three ways and a search for any misses the others.
    """
    def facility_tags(name):
        return [t for t in build_tags({"participants": [{"facility": name}]})
                if t.startswith("facility:")]

    assert facility_tags("Boston") == facility_tags("Boston Center") \
        == facility_tags("ZBW") == ["facility:boston-center"]


def test_the_longest_alias_wins_so_an_airport_is_not_read_as_its_center():
    # "Washington National" contains "washington", which alone means the Center.
    assert canonical_facility("Washington National") == "washington-national"
    assert canonical_facility("Washington Center") == "washington-center"


def test_a_callsign_for_a_unit_resolves_to_the_unit():
    # "Huntress" is NEADS's own callsign, not a separate facility.
    assert canonical_facility("Huntress") == "neads"


def test_an_unlisted_facility_keeps_its_own_slug_rather_than_vanishing():
    tags = build_tags({"participants": [{"facility": "Somewhere Nobody Listed"}]})
    assert "facility:somewhere-nobody-listed" in tags


def test_agency_still_resolves_through_the_canonical_name():
    tags = build_tags({"participants": [{"facility": "ZBW"}]})
    assert "agency:faa" in tags


def test_resolution_is_index_only_and_does_not_touch_the_record():
    """The licence for inferring at all: `parties` still says what was said."""
    parties = {"participants": [{"facility": "Boston"}]}
    build_tags(parties)
    assert parties["participants"][0]["facility"] == "Boston"


# --- curated merge --------------------------------------------------------

def test_curated_tags_are_preserved_alongside_derived_ones():
    tags = build_tags(FULL, curated=["collection:team-8", "note:check-timestamp"])
    assert "collection:team-8" in tags and "note:check-timestamp" in tags
    assert "facility:indianapolis-center" in tags   # derived ones still there


def test_a_retracted_derived_tag_does_not_survive_a_rerun():
    """Why curated tags need their own column rather than merging into `tags`.

    Merging the new derived set into whatever `tags` already held would let
    derived tags only ever accumulate: a facility the model stops identifying,
    or one the gate now rejects, would linger forever with nothing able to
    retract it. Re-running would entrench old mistakes instead of fixing them.
    """
    before = build_tags({"participants": [{"facility": "NEADS", "role": "military"}]})
    assert "facility:neads" in before
    # Next run: the gate rejected NEADS, so it is simply absent from the input.
    after = build_tags({"participants": [{"facility": None, "role": "military"}]},
                       curated=["note:keep-me"])
    assert "facility:neads" not in after
    assert "note:keep-me" in after


def test_curated_tags_need_not_use_a_known_namespace():
    # A curator may need vocabulary this module has never heard of.
    assert "anything at all" in build_tags({}, curated=["anything at all"])


def test_blank_curated_entries_are_dropped():
    assert build_tags({}, curated=["", "   ", None]) == []


def test_curated_and_derived_duplicates_collapse():
    tags = build_tags(FULL, curated=["facility:neads"])
    assert tags.count("facility:neads") == 1


def test_a_curator_may_assert_various_even_though_derivation_may_not():
    assert "facility:various" in build_tags({}, curated=["facility:various"])
    assert "facility:various" not in build_tags(
        {"participants": [{"facility": "various", "role": "atc"}]})


def test_split_tag_separates_namespace_from_value():
    assert split_tag("topic:hijack-report") == ("topic", "hijack-report")


def test_split_tag_keeps_a_value_containing_a_colon_intact():
    """Splitting on every colon would truncate the value silently."""
    assert split_tag("person:smith:jr") == ("person", "smith:jr")


def test_split_tag_returns_no_namespace_for_a_bare_tag():
    """Curated tags are taken verbatim, so an un-namespaced one must survive."""
    assert split_tag("interesting") == (None, "interesting")


def test_build_tag_records_reshapes_without_changing_the_derived_set():
    """The vocabulary and the search index must not be able to disagree."""
    records = build_tag_records(FULL)
    assert [r["tag"] for r in records] == build_tags(FULL)
    assert {"tag": "topic:hijack-report", "namespace": "topic",
            "value": "hijack-report"} in records
