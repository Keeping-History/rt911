"""
Tests for Directus media_items writer.
Mocks HTTP calls — no real Directus instance required.
"""
import respx
import httpx
from datetime import datetime, timezone
from unittest.mock import MagicMock

from video_grabber.directus.writer import write_media_item
from video_grabber.config import Config


def make_cfg():
    cfg = Config()
    cfg.directus_url = "http://directus:8055"
    cfg.directus_api_token = "static-token-xyz"
    return cfg


def make_job(*, passed_through_review=False):
    prog = MagicMock()
    prog.title = "CNN Live Coverage September 11, 2001"
    prog.air_date = datetime(2001, 9, 11, 12, 0, tzinfo=timezone.utc)
    prog.duration_seconds = 3600
    prog.description = "Live broadcast"

    channel = MagicMock()
    channel.slug = "cnn"
    channel.timezone = "America/New_York"

    job = MagicMock()
    job.ia_identifier = "cnn-sep11-0800"
    job.program = prog
    job.channel = channel
    job.passed_through_review = passed_through_review
    return job


@respx.mock
def test_write_media_item_posts_correct_fields():
    cfg = make_cfg()
    job = make_job()

    # Idempotency check returns empty
    respx.get(
        "http://directus:8055/items/media_items"
    ).mock(return_value=httpx.Response(200, json={"data": []}))

    # Source lookup
    respx.get(
        "http://directus:8055/items/sources"
    ).mock(return_value=httpx.Response(200, json={"data": [{"id": 42, "slug": "cnn"}]}))

    posted_body = {}

    def capture_post(request):
        posted_body.update(httpx.Request("POST", request.url).read())
        import json
        posted_body.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {"id": "new-id"}})

    respx.post(
        "http://directus:8055/items/media_items"
    ).mock(side_effect=capture_post)

    write_media_item(job, "hls/cnn/20010911/cnn-sep11-0800/master.m3u8", cfg)

    assert posted_body.get("format") == "m3u8"
    assert "cnn-sep11-0800" in str(posted_body.get("content", ""))
    assert posted_body.get("url") == "https://files.911realtime.org/hls/cnn/20010911/cnn-sep11-0800/master.m3u8"
    assert "Z" not in posted_body.get("start_date", "Z"), "start_date must be naive UTC (no Z suffix)"


@respx.mock
def test_write_media_item_approved_1_for_clean_job():
    cfg = make_cfg()
    job = make_job(passed_through_review=False)

    respx.get("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 1}]})
    )

    posted = {}

    def capture(request):
        import json
        posted.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    respx.post("http://directus:8055/items/media_items").mock(side_effect=capture)

    write_media_item(job, "some/key", cfg)
    assert posted.get("approved") == 1


@respx.mock
def test_write_media_item_approved_0_for_review_job():
    cfg = make_cfg()
    job = make_job(passed_through_review=True)

    respx.get("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 1}]})
    )

    posted = {}

    def capture(request):
        import json
        posted.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    respx.post("http://directus:8055/items/media_items").mock(side_effect=capture)

    write_media_item(job, "some/key", cfg)
    assert posted.get("approved") == 0


@respx.mock
def test_write_media_item_idempotent_on_existing():
    """If item already exists, do not post again."""
    cfg = make_cfg()
    job = make_job()

    respx.get("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": [{"id": "existing"}]})
    )

    post_mock = respx.post("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": {}})
    )

    write_media_item(job, "some/key", cfg)

    assert not post_mock.called, "Should not POST when item already exists"


@respx.mock
def test_idempotency_filters_on_exact_content_blob():
    """content is a plain text column, so the idempotency check must match the
    exact serialized JSON via filter[content][_eq], not traverse into it."""
    cfg = make_cfg()
    job = make_job()

    captured = {}

    def capture_get(request):
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json={"data": []})

    respx.get("http://directus:8055/items/media_items").mock(side_effect=capture_get)
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 1}]})
    )
    respx.post("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": {}})
    )

    write_media_item(job, "some/key", cfg)

    assert captured["params"].get("filter[content][_eq]") == (
        '{"ia_identifier": "cnn-sep11-0800"}'
    )
    assert "filter[content][ia_identifier][_eq]" not in captured["params"]


@respx.mock
def test_source_lookup_upper_cases_slug():
    """sources.slug is stored upper-cased; the lower-cased channel slug must be
    upper-cased for the lookup to resolve."""
    cfg = make_cfg()
    job = make_job()  # channel.slug == "cnn"

    captured = {}

    respx.get("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    def capture_sources(request):
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json={"data": [{"id": 11, "slug": "CNN"}]})

    respx.get("http://directus:8055/items/sources").mock(side_effect=capture_sources)

    posted = {}

    def capture_post(request):
        import json
        posted.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    respx.post("http://directus:8055/items/media_items").mock(side_effect=capture_post)

    write_media_item(job, "some/key", cfg)

    assert captured["params"].get("filter[slug][_eq]") == "CNN"
    assert posted.get("source") == 11


@respx.mock
def test_write_media_item_uses_static_token():
    cfg = make_cfg()
    job = make_job()

    captured_headers = {}

    def check_auth(request):
        captured_headers["authorization"] = request.headers.get("authorization", "")
        return httpx.Response(200, json={"data": []})

    respx.get("http://directus:8055/items/media_items").mock(side_effect=check_auth)
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 1}]})
    )
    respx.post("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": {}})
    )

    write_media_item(job, "some/key", cfg)
    assert "static-token-xyz" in captured_headers.get("authorization", "")


# --- upsert_channel_media_item (channel-stitching) ---

@respx.mock
def test_upsert_channel_keys_on_url_not_content_subfield():
    """The channel-stream idempotency check must filter by the top-level url,
    never a content subfield (content is an opaque JSON string -> 403)."""
    from video_grabber.directus.writer import upsert_channel_media_item

    cfg = make_cfg()
    channel = MagicMock(slug="weta", display_name="WETA", timezone="EDT")
    captured = {}

    def capture_get(request):
        captured["params"] = dict(request.url.params)
        return httpx.Response(200, json={"data": []})

    respx.get("http://directus:8055/items/media_items").mock(side_effect=capture_get)
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 18}]})
    )
    post = respx.post("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": {"id": 1}})
    )

    upsert_channel_media_item(channel, "playlists/weta/master.m3u8",
                              datetime(2001, 9, 9, tzinfo=timezone.utc), cfg)

    assert captured["params"].get("filter[url][_eq]") == \
        "https://files.911realtime.org/playlists/weta/master.m3u8"
    assert "filter[content][channel_stream][_eq]" not in captured["params"]
    assert post.called


@respx.mock
def test_upsert_channel_patches_when_row_exists():
    """An existing row (same url) is PATCHed in place, not duplicated."""
    from video_grabber.directus.writer import upsert_channel_media_item

    cfg = make_cfg()
    channel = MagicMock(slug="weta", display_name="WETA", timezone="EDT")

    respx.get("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 460681}]})
    )
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 18}]})
    )
    post = respx.post("http://directus:8055/items/media_items").mock(
        return_value=httpx.Response(200, json={"data": {}})
    )
    patch = respx.patch("http://directus:8055/items/media_items/460681").mock(
        return_value=httpx.Response(200, json={"data": {"id": 460681}})
    )

    upsert_channel_media_item(channel, "playlists/weta/master.m3u8",
                              datetime(2001, 9, 9, tzinfo=timezone.utc), cfg)

    assert patch.called and not post.called
