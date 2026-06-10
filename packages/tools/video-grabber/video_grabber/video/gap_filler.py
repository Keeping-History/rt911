"""
Blue gap filler — generates fMP4/CMAF HLS segments for all 3 renditions.
Color: #0000f5. Codec-matched to real content for seamless hls.js level-switching.
Thumb audio retained (8kbps mono) — hls.js requires audio in all renditions.
"""
import subprocess
from pathlib import Path

from video_grabber.video.encoder import RENDITIONS, _HLS_FLAGS


def generate_gap_fmp4(duration_seconds: int, output_dir: Path) -> Path:
    """Generate blue gap filler for all 3 renditions. Returns master.m3u8."""
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]

    for rend in RENDITIONS:
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)

        cmd = (
            [
                "ffmpeg",
                "-f", "lavfi", "-i",
                f"color=c=0x0000f5:size={rend['width']}x{rend['height']}:rate=29.97",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
                "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
                "-c:a", "aac",
                "-t", str(duration_seconds),
            ]
            + rend["a_flags"]
            + _HLS_FLAGS
            + ["-hls_segment_filename", "seg%04d.m4s", str(rend_dir / "index.m3u8")]
        )
        subprocess.run(cmd, check=True)

        master_lines += [
            f"#EXT-X-STREAM-INF:BANDWIDTH={rend['bandwidth']},"
            f"RESOLUTION={rend['width']}x{rend['height']}",
            f"{rend['name']}/index.m3u8",
        ]

    master = output_dir / "master.m3u8"
    master.write_text("\n".join(master_lines) + "\n")
    return master
