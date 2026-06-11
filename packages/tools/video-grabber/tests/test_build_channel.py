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

    with patch.object(flows, "get_db", return_value=MagicMock()), \
         patch.object(flows, "Config", return_value=MagicMock()), \
         patch.object(flows, "_load_channel", return_value=channel), \
         patch.object(flows, "build_schedule", return_value=7) as m_sched, \
         patch.object(flows, "assemble_range", return_value=(playlists, {})) as m_asm, \
         patch.object(flows, "generate_gap_fmp4") as m_gap, \
         patch.object(flows, "upload_tree") as m_tree, \
         patch.object(flows, "upload_text") as m_text, \
         patch.object(flows, "upsert_channel_media_item") as m_upsert:

        flows.build_channel_flow(
            "chan-1", "2001-09-09T00:00:00+00:00", "2001-09-18T00:00:00+00:00"
        )

    # Scheduler populated slots for the window.
    m_sched.assert_called_once()
    assert m_sched.call_args.args[0] == "chan-1"

    # Assembler ran for the channel.
    m_asm.assert_called_once()

    # Gap package generated once and uploaded to the channel-level _gap prefix.
    m_gap.assert_called_once()
    m_tree.assert_called_once()
    assert m_tree.call_args.args[1] == "hls/cnn/_gap"

    # All four playlists published under epg/<slug>/.
    published = {c.args[1] for c in m_text.call_args_list}
    assert published == {
        "epg/cnn/master.m3u8",
        "epg/cnn/full.m3u8",
        "epg/cnn/mid.m3u8",
        "epg/cnn/thumb.m3u8",
    }

    # Directus upserted with the master URL.
    m_upsert.assert_called_once()
    assert m_upsert.call_args.args[1] == "epg/cnn/master.m3u8"
