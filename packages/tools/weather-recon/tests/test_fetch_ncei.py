import httpx

from weather_recon.fetch_ncei import fetch_station_csv, ncei_url

CSV_BODY = ('"STATION","DATE","REPORT_TYPE","TMP"\n'
            '"72530094846","2001-09-09T00:51:00","FM-15","+0190,1"\n')


def test_ncei_url_strips_dash_and_carries_window():
    url = ncei_url("725300-94846", "2001-09-09", "2001-09-12")
    assert "stations=72530094846" in url
    assert "startDate=2001-09-09" in url and "endDate=2001-09-12" in url
    assert url.startswith("https://www.ncei.noaa.gov/access/services/data/v1?")
    assert "dataset=global-hourly" in url and "format=csv" in url


def _mock_client(calls):
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, text=CSV_BODY)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_parses_rows(tmp_path):
    calls = []
    rows = fetch_station_csv(_mock_client(calls), "725300-94846",
                             "2001-09-09", "2001-09-12", tmp_path)
    assert len(calls) == 1
    assert rows == [{"STATION": "72530094846", "DATE": "2001-09-09T00:51:00",
                     "REPORT_TYPE": "FM-15", "TMP": "+0190,1"}]


def test_fetch_uses_cache_on_second_call(tmp_path):
    calls = []
    client = _mock_client(calls)
    fetch_station_csv(client, "725300-94846", "2001-09-09", "2001-09-12", tmp_path)
    rows = fetch_station_csv(client, "725300-94846", "2001-09-09", "2001-09-12",
                             tmp_path)
    assert len(calls) == 1                      # no second HTTP hit
    assert rows[0]["DATE"] == "2001-09-09T00:51:00"
    assert (tmp_path / "725300-94846_2001-09-09_2001-09-12.csv").is_file()


def test_fetch_without_cache_dir(tmp_path):
    calls = []
    rows = fetch_station_csv(_mock_client(calls), "725300-94846",
                             "2001-09-09", "2001-09-12", None)
    assert len(rows) == 1 and len(calls) == 1


def test_fetch_raises_on_http_error(tmp_path):
    client = httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(503, text="unavailable")))
    try:
        fetch_station_csv(client, "725300-94846", "2001-09-09", "2001-09-12",
                          tmp_path)
        raise AssertionError("expected HTTPStatusError")
    except httpx.HTTPStatusError:
        pass
    # a failed fetch must not poison the cache
    assert not (tmp_path / "725300-94846_2001-09-09_2001-09-12.csv").exists()
