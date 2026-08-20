"""
Orchestration test for build_channel_flow — verifies the schedule → assemble →
publish wiring calls each stage with the right arguments. All side-effecting
collaborators (db, ffmpeg, S3, Directus) are mocked.
"""
from unittest.mock import patch, MagicMock


def test_build_channel_flow_wires_schedule_assemble_publish():
    from video_grabber.pipeline import flows

    channel = MagicMock()
    channel.slug = "cnn"
    channel.display_name = "CNN"
    channel.timezone = "EDT"

    playlists = {
        "master": "#EXTM3U master\n",
        "full": "#EXTM3U full\n",
        "mid": "#EXTM3U mid\n",
        "thumb": "#EXTM3U thumb\n",
    }
    epg_channel = {"name": "CNN", "callSign": "CNN", "grid": []}

    with patch.object(flows, "get_db", return_value=MagicMock()), \
         patch.object(flows, "Config", return_value=MagicMock()), \
         patch.object(flows, "_load_channel", return_value=channel), \
         patch.object(flows, "build_schedule", return_value=7) as m_sched, \
         patch.object(flows, "assemble_range", return_value=(playlists, epg_channel)) as m_asm, \
         patch.object(flows, "_ensure_gap_pool") as m_gap, \
         patch.object(flows, "upload_text") as m_text, \
         patch.object(flows, "list_keys", return_value=["epg/cnn.json"]) as m_list, \
         patch.object(flows, "read_text", return_value='{"name": "CNN", "grid": []}'), \
         patch.object(flows, "upsert_channel_media_item") as m_upsert:

        flows.build_channel_flow(
            "chan-1", "2001-09-09T00:00:00+00:00", "2001-09-18T00:00:00+00:00"
        )

    # Scheduler populated slots for the window.
    m_sched.assert_called_once()
    assert m_sched.call_args.args[0] == "chan-1"

    # Assembler ran for the channel.
    m_asm.assert_called_once()

    # Shared gap pool ensured once (idempotent upload lives inside it).
    m_gap.assert_called_once()

    published = {c.args[1] for c in m_text.call_args_list}
    # Four HLS playlists under playlists/<slug>/.
    assert {
        "playlists/cnn/master.m3u8",
        "playlists/cnn/full.m3u8",
        "playlists/cnn/mid.m3u8",
        "playlists/cnn/thumb.m3u8",
    } <= published
    # Per-channel EPG JSON + the combined guide.
    assert "epg/cnn.json" in published
    assert "epg/guide.json" in published
    m_list.assert_called_once()  # guide rebuilt by listing per-channel json

    # Directus upserted with the master playlist URL.
    m_upsert.assert_called_once()
    assert m_upsert.call_args.args[1] == "playlists/cnn/master.m3u8"
