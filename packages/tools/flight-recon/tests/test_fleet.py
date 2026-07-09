"""Tail normalization + B-43 fleet lookup. BTS Tail_Number quirks: missing
leading N, embedded hyphens/spaces, lowercase, and junk sentinels — plus the
pandas-NaN-stringified "NAN" trap."""

from flight_recon.fleet import load_fleet, normalize_tail


def test_normalize_adds_missing_n_prefix():
    assert normalize_tail("334AA") == "N334AA"


def test_normalize_strips_punctuation_whitespace_case():
    assert normalize_tail(" n-334aa ") == "N334AA"


def test_normalize_rejects_empty_none_and_sentinels():
    assert normalize_tail(None) is None
    assert normalize_tail("") is None
    assert normalize_tail("UNKNOW") is None
    assert normalize_tail("UNKNOWN") is None
    assert normalize_tail("NONE") is None
    assert normalize_tail("NAN") is None  # str(float("nan")).upper()


def test_load_fleet_builds_display_names_and_skips_bad_rows(tmp_path):
    p = tmp_path / "b43.csv"
    p.write_text(
        "TAIL_NUMBER,MANUFACTURER,MODEL\n"
        "N334AA,BOEING,767-223\n"
        "612UA,BOEING,767-222\n"      # missing N prefix -> normalized key
        ",BOEING,737-800\n"           # no tail -> skipped
        "N999XX,AIRBUS,\n"            # no model -> skipped
    )
    fleet = load_fleet(p)
    assert fleet == {"N334AA": "Boeing 767-223", "N612UA": "Boeing 767-222"}
