import httpx

from weather_recon.fetch_afos import fetch_wfo_products

BODY = "\x01\n080 \nFPUS51 KOKX 111905\nZFPOKX\n...\n\x03"


def _mock(calls):
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, text=BODY)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_url_params(tmp_path):
    calls = []
    fetch_wfo_products(_mock(calls), "OKX", "2001-09-08", "2001-09-13", tmp_path)
    assert "pil=ZFPOKX" in calls[0] and "sdate=2001-09-08" in calls[0]
    assert "edate=2001-09-13" in calls[0] and "limit=9999" in calls[0]


def test_fetch_url_params_uses_pil_override(tmp_path):
    # FFC (Atlanta GA, modern cwa) filed its 2001 ZFP under ATL, not FFC.
    calls = []
    fetch_wfo_products(_mock(calls), "FFC", "2001-09-08", "2001-09-13", tmp_path)
    assert "pil=ZFPATL" in calls[0]
    assert (tmp_path / "ZFPATL_2001-09-08_2001-09-13.txt").is_file()


def test_fetch_returns_raw_and_caches(tmp_path):
    calls = []
    client = _mock(calls)
    t1 = fetch_wfo_products(client, "OKX", "2001-09-08", "2001-09-13", tmp_path)
    t2 = fetch_wfo_products(client, "OKX", "2001-09-08", "2001-09-13", tmp_path)
    assert t1 == BODY == t2 and len(calls) == 1
    assert (tmp_path / "ZFPOKX_2001-09-08_2001-09-13.txt").is_file()


def test_fetch_error_does_not_cache(tmp_path):
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(503, text="x")))
    try:
        fetch_wfo_products(client, "OKX", "2001-09-08", "2001-09-13", tmp_path)
        raise AssertionError("expected HTTPStatusError")
    except httpx.HTTPStatusError:
        pass
    assert not (tmp_path / "ZFPOKX_2001-09-08_2001-09-13.txt").exists()
