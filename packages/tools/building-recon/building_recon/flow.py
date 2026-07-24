"""Prefect flow: fetch 2001 building footprints, restore the WTC, publish."""
import json
import os

import build_2001
from prefect import flow, get_run_logger

from building_recon import directus, purge, wasabi
from building_recon.sources import fetch_source

DEFAULT_SOURCES = ["nyc", "dc", "arlington"]
WASABI_KEY = "maps/buildings-2001.geojson"


def assemble_from_sources(source_raws_by_name: dict[str, list[dict]]) -> tuple[dict, dict]:
    """Flatten per-source raw buildings and assemble the 2001 FeatureCollection.

    Pure (no Prefect, no I/O) so the assembly step is testable on its own.
    """
    all_raws: list[dict] = []
    for raws in source_raws_by_name.values():
        all_raws.extend(raws)
    return build_2001.assemble(all_raws, build_2001.load_wtc_complex())


def _directus_client(directus_url: str | None) -> directus.DirectusClient:
    url = directus_url or os.environ["DIRECTUS_URL"]
    token = os.environ["DIRECTUS_API_TOKEN"]
    return directus.DirectusClient(url, token)


@flow(name="reconstruct-2001-buildings", log_prints=True)
def reconstruct_buildings(directus_url: str | None = None, sources: list[str] | None = None,
                          upload: bool = True, load_directus: bool = True) -> dict:
    log = get_run_logger()
    names = sources or DEFAULT_SOURCES
    raws_by_name = {name: fetch_source(name) for name in names}
    fc, summary = assemble_from_sources(raws_by_name)
    log.info("assembled %d features: %s", summary["total"], summary["by_source"])

    result = {"summary": summary}
    if load_directus:
        client = _directus_client(directus_url)
        rows = directus.rows_from_features(fc["features"])
        result["directus"] = directus.load_buildings(client, rows)
    if upload:
        url = wasabi.upload_text(WASABI_KEY, json.dumps(fc), "application/json")
        purge.purge_urls([url])
        result["url"] = url
        log.info("published %s", url)
    return result


if __name__ == "__main__":
    reconstruct_buildings()
