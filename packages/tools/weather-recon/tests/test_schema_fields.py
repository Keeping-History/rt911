from weather_recon.directus import COLLECTIONS


def test_expected_collections():
    assert set(COLLECTIONS) == {"weather_stations", "weather_observations",
                                "weather_forecasts"}


def test_every_collection_has_exactly_one_primary_key():
    for name, spec in COLLECTIONS.items():
        pks = [f["field"] for f in spec["fields"]
               if f.get("schema", {}).get("is_primary_key")]
        assert len(pks) == 1, f"{name}: PKs {pks}"


def test_no_duplicate_field_names():
    for name, spec in COLLECTIONS.items():
        fields = [f["field"] for f in spec["fields"]]
        assert len(fields) == len(set(fields)), f"{name}"


def test_json_fields_carry_cast_json_special():
    # Repo law (flight_recon/directus.py:37): json fields without cast-json
    # fail collection creation with an opaque 400.
    for name, spec in COLLECTIONS.items():
        for f in spec["fields"]:
            if f["type"] == "json":
                assert "cast-json" in f.get("meta", {}).get("special", []), \
                    f"{name}.{f['field']}"


def test_stations_pk_is_the_icao_string():
    pk = next(f for f in COLLECTIONS["weather_stations"]["fields"]
              if f.get("schema", {}).get("is_primary_key"))
    assert pk["field"] == "station_id" and pk["type"] == "string"


def test_delete_all_pk_filter_derivable_for_every_collection():
    # delete_all filters on the collection PK; every collection must yield one
    from weather_recon.directus import COLLECTIONS
    for name, spec in COLLECTIONS.items():
        pk = next(f["field"] for f in spec["fields"]
                  if f.get("schema", {}).get("is_primary_key"))
        assert pk


def test_observation_and_forecast_time_fields_are_timestamps():
    obs = {f["field"]: f for f in COLLECTIONS["weather_observations"]["fields"]}
    fc = {f["field"]: f for f in COLLECTIONS["weather_forecasts"]["fields"]}
    assert obs["observed_at"]["type"] == "timestamp"
    assert obs["observed_at"]["schema"] == {"is_nullable": False}
    assert fc["issued_at"]["type"] == "timestamp"
    assert fc["issued_at"]["schema"] == {"is_nullable": False}
