"""Best-effort Cloudflare cache purge after re-uploading the buildings snapshot.

Mirrors video-grabber's `normalize/purge.py`. Purge failure must never fail
the pipeline run — origin bytes are already correct; we log and move on.
"""
import logging
import os

import httpx

log = logging.getLogger(__name__)

_API = "https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache"


def purge_urls(urls: list[str], client: httpx.Client | None = None) -> None:
    token = os.environ.get("CF_API_TOKEN")
    zone_id = os.environ.get("CF_ZONE_ID")
    if not token or not zone_id:
        log.warning("CF purge skipped: CF_API_TOKEN/CF_ZONE_ID not set (%d url(s))", len(urls))
        return
    http = client or httpx
    try:
        resp = http.post(
            _API.format(zone=zone_id),
            headers={"Authorization": f"Bearer {token}"},
            json={"files": urls},
            timeout=30,
        )
        if resp.status_code == 200 and resp.json().get("success"):
            return
        log.warning("CF purge failed: HTTP %d %s", resp.status_code, resp.text[:500])
    except (httpx.HTTPError, ValueError) as exc:
        # ValueError covers resp.json() raising json.JSONDecodeError on an
        # HTTP-200 response with a non-JSON body — purge_urls must never
        # raise (module contract).
        log.warning("CF purge failed: %s", exc)
