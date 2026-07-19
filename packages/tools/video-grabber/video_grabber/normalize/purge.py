"""Best-effort Cloudflare cache purge after in-place audio/ overwrites.

audio/ objects carry a long immutable Cache-Control, so without a purge CF
keeps serving pre-normalization bytes indefinitely. Purge failure must never
fail the job — origin bytes are already correct; we log and move on. The
nginx-s3-gateway (file-proxy) layer is handled operationally instead:
`kubectl -n file-proxy rollout restart deploy/file-proxy` after the batch.
"""
import httpx

from video_grabber.config import Config

_API = "https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache"


def purge_urls(urls: list[str], cfg: Config, logger) -> bool:
    if not cfg.cf_api_token or not cfg.cf_zone_id:
        logger.warning("CF purge skipped: CF_API_TOKEN/CF_ZONE_ID not set (%d url(s))", len(urls))
        return False
    try:
        resp = httpx.post(
            _API.format(zone=cfg.cf_zone_id),
            headers={"Authorization": f"Bearer {cfg.cf_api_token}"},
            json={"files": urls},
            timeout=30,
        )
        if resp.status_code == 200 and resp.json().get("success"):
            return True
        logger.warning("CF purge failed: HTTP %d %s", resp.status_code, resp.text[:500])
        return False
    except httpx.HTTPError as exc:
        logger.warning("CF purge failed: %s", exc)
        return False
